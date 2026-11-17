// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Real memory-only GSettings and Cancellable; handshake/certificates are FAKE.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {linkCancellables} from '../../src/service/utils/transferCancellation.js';

/**
 * Assert a test boundary.
 *
 * @param {boolean} value - Condition
 * @param {string} message - Description
 */
function assert(value, message) {
    if (!value)
        throw new Error(message);
}

/**
 * Exercise actual authentication method with isolated memory settings.
 *
 * @param {object} schema - Explicit package schema
 * @param {string} method - Unmodified production method text
 * @param {string} mode - Cancellation timing or certificate mismatch
 * @param {boolean} devicePresent - Existing fake device
 * @returns {Promise<void>} Completion
 */
async function check(schema, method, mode, devicePresent) {
    const backend = Gio.memory_settings_backend_new();
    assert(backend !== null, 'Explicit memory backend required');
    const id = `test-${GLib.uuid_string_random()}`;
    const path = `/org/gnome/shell/extensions/gsconnect/device/${id}/`;
    // new_full ALWAYS has an explicit backend, never the default dconf backend.
    const settings = Gio.Settings.new_full(schema, backend, path);
    const neighbour = Gio.Settings.new_full(schema, backend, `${path}neighbour/`);
    for (const entry of [settings, neighbour]) {
        assert(entry.set_boolean('paired', true), 'Memory paired initialization failed');
        assert(entry.set_string('certificate-pem', 'fixture-not-a-certificate'), 'Memory certificate initialization failed');
    }
    let reads = 0;
    let accesses = 0;
    let resets = 0;
    let constructions = 0;
    let unpairs = 0;
    let validations = 0;
    const facade = {
        get_string(key) {
            reads++;
            return settings.get_string(key);
        },
        reset(key) {
            assert(['paired', 'certificate-pem'].includes(key), 'Unexpected setting reset');
            resets++;
            settings.reset(key);
        },
    };
    // No real Gio.TlsCertificate/connection constructors are provided.
    const boundary = {
        TlsCertificateFlags: {EXPIRED: 1}, TlsAuthenticationMode: {REQUIRED: 1},
        Settings: class {
            constructor(options) {
                constructions++;
                assert(options.settings_schema === schema && options.path === path,
                    'Unexpected schema or device path');
                const actual = Gio.Settings.new_full(
                    options.settings_schema, backend, options.path);
                assert(actual.get_boolean('paired'), 'Expected isolated pre-existing memory value');
                return facade;
            }
        },
        TlsCertificate: {new_from_pem(pem) {
            validations++;
            assert(pem === 'fixture-not-a-certificate', 'Only fake PEM may be inspected');
            return {is_same: () => false};
        }},
    };
    const config = {GSCHEMA: {lookup(name, recursive) {
        assert(name === 'org.gnome.Shell.Extensions.GSConnect.Device' && recursive === true,
            'Unexpected schema lookup');
        return schema;
    }}};
    // Only the exact method is evaluated, not lan.js imports/top-level code.
    const authenticate = new Function('Gio', 'GLib', 'Config', 'linkCancellables', 'logError',
        `return ({${method}})._authenticate;`)(boundary, GLib, config, linkCancellables,
        () => {
            throw new Error('Unexpected certificate parsing error');
        });
    const owner = new Gio.Cancellable();
    const transfer = new Gio.Cancellable();
    if (mode === 'pre-cancel')
        transfer.cancel();
    const channel = {cancellable: owner,
        identity: {body: {deviceId: id, deviceName: 'Fixture'}},
        device: devicePresent ? {get settings() {
            accesses++;
            return facade;
        }, unpair() {
            unpairs++;
        }} : null};
    const connection = {peer_certificate: {}, handshake_async(_priority, token) {
        // Fake handshake performs NO TLS, I/O or certificate generation.
        if (mode === 'during-cancel') {
            return new Promise((resolve, reject) => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    owner.cancel();
                    try {
                        token.set_error_if_cancelled();
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
        if (mode === 'late-success') {
            transfer.cancel();
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            try {
                token.set_error_if_cancelled();
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    }};
    let failure = null;
    try {
        await authenticate.call(channel, connection, transfer);
    } catch (error) {
        failure = error;
    }
    if (mode === 'mismatch') {
        assert(failure?.message === 'Fixture: Authentication Failure', 'Expected mock mismatch failure');
        assert(reads === 1 && validations === 1, 'Mock certificate check required');
        if (devicePresent) {
            assert(unpairs === 1 && resets === 0 && constructions === 0, 'Only fake device unpair called');
            assert(settings.get_boolean('paired'), 'Fake unpair does not implement real pairing changes');
        } else {
            assert(constructions === 1 && resets === 2 && unpairs === 0, 'Only isolated memory keys reset');
            assert(!settings.get_boolean('paired') && settings.get_string('certificate-pem') === '',
                'Memory settings must reflect actual reset defaults');
        }
    } else {
        assert(failure?.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED), 'Expected real cancellation error');
        assert(reads === 0 && accesses === 0 && resets === 0 && constructions === 0 &&
            unpairs === 0 && validations === 0,
        'Cancellation must precede all settings/certificate/unpair accesses');
        assert(settings.get_boolean('paired') && settings.get_string('certificate-pem') === 'fixture-not-a-certificate',
            'Cancelled authentication must preserve memory settings');
    }
    assert(neighbour.get_boolean('paired') && neighbour.get_string('certificate-pem') === 'fixture-not-a-certificate',
        'Independent memory path must remain unchanged');
    print(`PASS real memory settings/${mode}/device=${devicePresent}; simulated TLS/certificate`);
}

/** Load only explicit schemas and method text, never service initialization. */
async function run() {
    assert(ARGV.length === 1 && GLib.path_is_absolute(ARGV[0]), 'Pass absolute package directory');
    const schemas = Gio.SettingsSchemaSource.new_from_directory(
        `${ARGV[0]}/schemas`, null, false);
    const schema = schemas.lookup('org.gnome.Shell.Extensions.GSConnect.Device', false);
    assert(schema !== null, 'Package device schema required; no system schema fallback');
    const file = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent()
        .get_child('src/service/backends/lan.js');
    const source = new TextDecoder().decode(file.load_contents(null)[1]);
    const header = '    async _authenticate(connection, cancellable = null) {';
    assert(source.split(header).length === 2, 'Production method header must be unique');
    const start = source.indexOf(header);
    const end = source.indexOf('\n    /**', start);
    assert(start >= 0 && end > start, 'Production method boundaries required');
    const method = source.slice(start, end).trim();
    for (const mode of ['pre-cancel', 'during-cancel', 'late-success', 'mismatch']) {
        for (const present of [false, true])
            await check(schema, method, mode, present);
    }
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
    printerr('FAIL memory authentication watchdog');
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});
run().catch(error => {
    printerr(`FAIL memory authentication: ${error.message}`);
    exitCode = 1;
}).finally(() => {
    GLib.source_remove(watchdog);
    loop.quit();
});
loop.run();
System.exit(exitCode);
