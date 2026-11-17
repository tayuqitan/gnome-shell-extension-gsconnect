// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Production method + helper, entirely mocked GI/settings/device objects.
// No TLS, network, certificates, daemon, GSettings backend or real pairing.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../../src/service/backends/lan.js', import.meta.url), 'utf8');
const helper = readFileSync(new URL('../../src/service/utils/transferCancellation.js', import.meta.url), 'utf8');
const begin = '    async _authenticate(connection, cancellable = null) {';
assert.equal(source.split(begin).length, 2);
const offset = source.indexOf(begin);
const method = source.slice(offset, source.indexOf('\n    /**', offset));
class Token {
    handlers = new Map();
    serial = 0;
    cancelled = false;
    is_cancelled() { return this.cancelled; }
    set_error_if_cancelled() { if (this.cancelled) throw Error('mock cancelled'); }
    connect(fn) {
        if (this.cancelled) { fn(); return 0; }
        this.handlers.set(++this.serial, fn); return this.serial;
    }
    disconnect(id) { this.handlers.delete(id); }
    cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        for (const fn of [...this.handlers.values()]) fn();
    }
}
/**
 * Instantiate extracted production auth using exclusively in-memory adapters.
 * @param {boolean} attached - Device already exists
 * @param {string} behavior - Handshake or certificate simulation
 * @returns {object} Fixture and tracked effects
 */
function fixture(attached, behavior = 'match') {
    const effects = [], handshake = [], logged = [];
    const settings = {
        get_string(key) { effects.push(['get', key]); return behavior === 'empty' ? '' : 'test-only-pem'; },
        reset(key) { effects.push(['reset', key]); },
    };
    const peer = {testPeer: true};
    let release;
    const scope = {
        GLib: {PRIORITY_DEFAULT: 0},
        Config: {GSCHEMA: {lookup(name, recursive) { effects.push(['lookup', name, recursive]); return {}; }}},
        logError(error) { logged.push(error.message); },
        Gio: {Cancellable: Token, TlsCertificateFlags: {EXPIRED: 8}, TlsAuthenticationMode: {REQUIRED: 2},
            Settings: class {
                constructor(options) { effects.push(['construct', options.path]); return settings; }
            },
            TlsCertificate: {new_from_pem(pem, length) {
                effects.push(['parse', pem, length]);
                if (behavior === 'parse-error') throw Error('mock parse failure');
                return {is_same(candidate) {
                    assert.equal(candidate, peer);
                    effects.push(['compare']);
                    if (behavior === 'compare-error') throw Error('mock compare failure');
                    return behavior !== 'mismatch';
                }};
            }},
        },
    };
    vm.createContext(scope);
    vm.runInContext(helper.replace(/^import .*;$/gm, '').replace(/export /g, ''), scope);
    vm.runInContext(`this.Channel = class {${method}}`, scope);
    const channel = new scope.Channel();
    channel.cancellable = new Token();
    channel.identity = {body: {deviceId: 'mock-only-device', deviceName: 'Mock device'}};
    channel.device = attached ? {
        get settings() { effects.push(['device-settings']); return settings; },
        unpair() { effects.push(['unpair']); },
    } : null;
    const token = new Token();
    const connection = {peer_certificate: peer,
        handshake_async(priority, child) {
            handshake.push(child);
            assert.equal(priority, 0);
            if (behavior === 'late-success')
                return new Promise(resolve => { release = resolve; });
            child.set_error_if_cancelled();
            if (behavior === 'pending') {
                return new Promise((resolve, reject) => {
                    const id = child.connect(() => { child.disconnect(id); reject(Error('mock cancelled')); });
                });
            }
            if (behavior === 'handshake-error') return Promise.reject(Error('mock handshake failed'));
            return Promise.resolve();
        }};
    return {channel, connection, token, effects, handshake, logged,
        release: () => release(), run: () => channel._authenticate(connection, token)};
}
/**
 * Assert parent cancellation subscriptions have been released.
 * @param {object} f - Fixture
 */
function assertDisposed(f) {
    assert.equal(f.token.handlers.size, 0);
    assert.equal(f.channel.cancellable.handlers.size, 0);
}
for (const attached of [true, false]) {
    const location = attached ? 'attached fake device' : 'fake settings factory';
    for (const parent of ['transfer', 'channel']) {
        for (const phase of ['pre-cancel', 'pending', 'late-success']) {
            test(`${location}: ${parent} ${phase} never reads settings or unpairs`, async () => {
                const f = fixture(attached, phase === 'pre-cancel' ? 'match' : phase);
                const selected = parent === 'transfer' ? f.token : f.channel.cancellable;
                if (phase === 'pre-cancel') selected.cancel();
                const promise = f.run();
                const rejected = assert.rejects(promise, /mock cancelled/);
                assert.equal(f.handshake.length, 1);
                if (phase !== 'pre-cancel') selected.cancel();
                if (phase === 'late-success') {
                    assert.deepEqual(f.effects, []);
                    f.release();
                }
                await rejected;
                assert.deepEqual(f.effects, []);
                assert.deepEqual(f.logged, []);
                assertDisposed(f);
                const other = parent === 'transfer' ? f.channel.cancellable : f.token;
                assert.equal(other.is_cancelled(), false);
            });
        }
    }
    for (const behavior of ['match', 'empty', 'mismatch', 'parse-error', 'compare-error', 'handshake-error']) {
        test(`${location}: ${behavior} preserves existing authentication policy`, async () => {
            const f = fixture(attached, behavior);
            if (['match', 'empty'].includes(behavior)) assert.equal(await f.run(), f.connection);
            else await assert.rejects(f.run(), behavior === 'handshake-error' ? /mock handshake failed/ : /Authentication Failure/);
            assertDisposed(f);
            assert.equal(f.token.is_cancelled(), false);
            assert.equal(f.channel.cancellable.is_cancelled(), false);
            if (behavior === 'handshake-error') {
                assert.deepEqual(f.effects, []);
                return;
            }
            assert.equal(f.effects.filter(([name]) => name === 'get').length, 1);
            const rejected = ['mismatch', 'parse-error', 'compare-error'].includes(behavior);
            assert.deepEqual(f.effects.filter(([name]) => name === 'unpair' || name === 'reset'),
                rejected ? (attached ? [['unpair']] : [['reset', 'paired'], ['reset', 'certificate-pem']]) : []);
            if (behavior === 'empty') {
                assert.equal(f.effects.some(([name]) => name === 'parse' || name === 'compare'), false);
            }
            if (!attached) {
                assert.deepEqual(f.effects.filter(([name]) => name === 'construct'),
                    [['construct', '/org/gnome/shell/extensions/gsconnect/device/mock-only-device/']]);
            }
            assert.equal(f.logged.length, ['parse-error', 'compare-error'].includes(behavior) ? 1 : 0);
        });
    }
}
