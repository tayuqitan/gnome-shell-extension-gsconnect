// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../../src/service/backends/lan.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('    async download('), source.indexOf('    async upload('));
/**
 * Build an isolated download failure fixture.
 * @param {string} mode - Failure stage to simulate
 * @returns {object} Channel and observed stream cleanup
 */
function fixture(mode) {
    const closed = [];
    const stream = name => ({close_async(_priority, cancel, callback) {
        assert.equal(cancel, null);
        closed.push(name); callback(this, {});
    }, close_finish() {}});
    const raw = stream('raw');
    const target = stream('target');
    const token = {connect: () => 1, disconnect() {}, set_error_if_cancelled() {}};
    const scope = {linkCancellables: () => ({cancellable: token, dispose() {}}),
        closeTransferSocket() {}, closeTransferStreams: async streams => Promise.allSettled(
            streams.map(item => new Promise(resolve => item.close_async(0, null, resolve)))), GLib: {PRIORITY_DEFAULT: 0}, Promise,
        Gio: {InetSocketAddress: {new_from_string() {}}, SocketClient: class {
            async connect_async() {
                if (mode === 'connect') throw Error('connect failed');
                return raw;
            }
        }}, copyExact: async () => { throw Error('write failed'); }};
    vm.runInNewContext(`this.Channel = class {${body}}`, scope);
    const channel = new scope.Channel();
    channel._encryptClient = async () => {
        if (mode === 'encrypt') throw Error('encrypt failed');
        return raw;
    };
    return {channel, target, closed};
}
for (const mode of ['connect', 'encrypt', 'write']) {
    test(`rich download closes target before ${mode} failure settles`, async () => {
        const {channel, target, closed} = fixture(mode);
        await assert.rejects(channel.download({type: 'gsconnect.clipboard.rich',
            payloadTransferInfo: {port: 1739}, payloadSize: 1}, target), new RegExp(mode));
        assert.ok(closed.includes('target'));
        if (mode !== 'connect') assert.ok(closed.includes('raw'));
    });
}
