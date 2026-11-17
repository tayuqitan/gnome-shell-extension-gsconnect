// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Explicit private-bus integration client. Never uses Gio.DBus.session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const SERVICE = 'org.gnome.Shell.Extensions.GSConnect';
const PORTAL = `${SERVICE}.Clipboard`;
const PATH = '/org/gnome/Shell/Extensions/GSConnect/Clipboard';
const MIME = `application/x-gsconnect-isolated-test-${GLib.uuid_string_random()}`;
const FIXTURE = new Uint8Array([0, 1, 2, 127, 128, 254, 255, 71, 83, 67]);

/**
 * Assert a test condition without disclosing clipboard content.
 *
 * @param {boolean} value - Condition
 * @param {string} message - Failure description
 */
function assert(value, message) {
    if (!value)
        throw new Error(message);
}

/**
 * Parse explicit safety arguments.
 *
 * @param {string[]} args - CLI arguments
 * @returns {object} Validated options
 */
function parse(args) {
    assert(args.length === 6 || args.length === 7, 'Expected --bus-address ADDRESS --root DIRECTORY --extension-path PATH [--deadline]');
    assert(args[0] === '--bus-address' && args[2] === '--root' && args[4] === '--extension-path', 'Explicit arguments required');
    const [address, root, extension] = [args[1], args[3], args[5]];
    assert(/^unix:(path|abstract)=/.test(address) && !address.includes(';'), 'Only one explicit local private bus is allowed');
    assert(/^\/tmp\/gsconnect-shell-smoke\.[A-Za-z0-9]+$/.test(root), 'Expected a dedicated smoke-test directory');
    assert(extension === `${root}/data/gnome-shell/extensions/gsconnect@andyholmes.github.io`, 'Unexpected extension path');
    for (const [key, suffix] of [['HOME', 'home'], ['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache'], ['XDG_RUNTIME_DIR', 'runtime']])
        assert(GLib.getenv(key) === `${root}/${suffix}`, `Unsafe ${key}; launch only inside the isolated runner`);
    assert(GLib.getenv('DBUS_SESSION_BUS_ADDRESS') === address, 'Private bus argument/environment mismatch');
    assert(args.length === 6 || args[6] === '--deadline', 'Unknown argument');
    return {address, root, extension, deadline: args.length === 7};
}

/**
 * Issue a bounded asynchronous D-Bus call.
 *
 * @param {Gio.DBusConnection} bus - Explicit connection
 * @param {string} destination - Bus name
 * @param {string} path - Object path
 * @param {string} iface - Interface
 * @param {string} method - Method
 * @param {GLib.Variant|null} parameters - Parameters
 * @param {number} timeout - Milliseconds
 * @returns {Promise<GLib.Variant>} Reply
 */
function call(bus, destination, path, iface, method, parameters = null, timeout = 5000) {
    return new Promise((resolve, reject) => {
        bus.call(destination, path, iface, method, parameters, null,
            Gio.DBusCallFlags.NO_AUTO_START, timeout, null, (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

/**
 * Wait without blocking the D-Bus dispatcher.
 *
 * @param {number} milliseconds - Delay
 * @returns {Promise<void>} Completion
 */
function delay(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/**
 * Run only after positively identifying the isolated active extension.
 *
 * @returns {Promise<void>} Completion
 */
async function run() {
    const options = parse(ARGV);
    const bus = Gio.DBusConnection.new_for_address_sync(options.address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
        Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null);
    let owned = false;
    let subscription = 0;
    let currentOffer = '';
    let mode = 'success';
    let requested = 0;
    let signalFailure = null;
    let shellOwner = '';
    const portal = async (method, parameters = null, timeout = 5000) => {
        for (const name of ['org.gnome.Shell', PORTAL]) {
            const owner = (await call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'GetNameOwner', new GLib.Variant('(s)', [name]))).deepUnpack()[0];
            assert(owner === shellOwner, 'Refusing portal call: verified Shell owner changed');
        }
        return call(bus, shellOwner, PATH, PORTAL, method, parameters, timeout);
    };
    try {
        shellOwner = (await call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetNameOwner', new GLib.Variant('(s)', ['org.gnome.Shell']))).deepUnpack()[0];
        const info = (await call(bus, shellOwner, '/org/gnome/Shell',
            'org.gnome.Shell.Extensions', 'GetExtensionInfo',
            new GLib.Variant('(s)', ['gsconnect@andyholmes.github.io']))).recursiveUnpack()[0];
        assert(info.path === options.extension && info.state === 1 && info.error === '', 'Refusing: expected isolated ACTIVE extension not confirmed');
        const owner = (await call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', [SERVICE]))).deepUnpack()[0];
        assert(!owner, 'Refusing: a GSConnect service is already running');
        const result = (await call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'RequestName', new GLib.Variant('(su)', [SERVICE, 4]))).deepUnpack()[0];
        assert(result === 1, 'Unable to own isolated mock name');
        owned = true;
        let ready = false;
        for (let attempt = 0; attempt < 50; attempt++) {
            try {
                const portalOwner = (await call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
                    'org.freedesktop.DBus', 'GetNameOwner', new GLib.Variant('(s)', [PORTAL]))).deepUnpack()[0];
                assert(portalOwner === shellOwner, 'Portal is not owned by verified Shell');
                await portal('GetOffer');
                ready = true;
                break;
            } catch {
                await delay(100);
            }
        }
        assert(ready, 'Native clipboard portal did not become ready');
        subscription = bus.signal_subscribe(shellOwner, PORTAL, 'ValueRequested', PATH,
            null, Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _name, params) => {
                const [id, requestId, mime] = params.deepUnpack();
                if (id !== currentOffer)
                    return;
                requested++;
                if (mime !== MIME || typeof requestId !== 'string' || !requestId || requestId.length > 256) {
                    signalFailure = new Error('Unexpected request MIME');
                    return;
                }
                if (mode === 'hold')
                    return;
                const error = mode === 'error' ? 'isolated fixture failure' : '';
                portal('Resolve', new GLib.Variant('(ssays)', [id, requestId, error ? [] : FIXTURE, error]))
                    .catch(failure => {
                        signalFailure = failure;
                    });
            });
        for (const testMode of ['success', 'error', 'cancel', ...(options.deadline ? ['deadline'] : [])]) {
            mode = ['cancel', 'deadline'].includes(testMode) ? 'hold' : testMode;
            requested = 0;
            currentOffer = `isolated-${testMode}-${GLib.uuid_string_random()}`;
            await portal('Offer', new GLib.Variant('(sasu)', [currentOffer, [MIME], 60]));
            assert((await portal('GetOffer')).deepUnpack()[0] === currentOffer, 'Offer identity mismatch');
            const began = GLib.get_monotonic_time();
            // Handle rejection immediately, before awaiting cancellation.
            const pending = portal('GetValue', new GLib.Variant('(s)', [MIME]), testMode === 'deadline' ? 70000 : 10000)
                .then(reply => ({reply}), error => ({error}));
            if (testMode === 'cancel') {
                for (let attempt = 0; requested === 0 && attempt < 50; attempt++)
                    await delay(20);
                assert(requested > 0, 'No pending native request to cancel');
                await portal('ClearOffer', new GLib.Variant('(s)', [currentOffer]));
            }
            const outcome = await pending;
            assert(!signalFailure, 'Signal handler failed');
            assert(requested > 0, 'Native async request signal was not emitted');
            if (testMode === 'success') {
                assert(!outcome.error, 'Binary transfer failed');
                const bytes = outcome.reply.deepUnpack()[0];
                assert(bytes.length === FIXTURE.length && FIXTURE.every((byte, i) => byte === bytes[i]), 'Binary fixture mismatch');
            } else {
                assert(Boolean(outcome.error), 'Expected transfer failure was not returned');
                assert(Gio.DBusError.is_remote_error(outcome.error), 'Transport/client timeout is not a native error pass');
                assert(Gio.DBusError.get_remote_error(outcome.error) === `${PORTAL}.Error`, 'Unexpected remote failure domain');
                if (testMode === 'error')
                    assert(outcome.error.message.includes('isolated fixture failure'), 'Explicit native error was not preserved');
                if (testMode === 'cancel')
                    assert(outcome.error.message.includes('Clipboard ownership changed'), 'Native ownership cancellation was not preserved');
                if (testMode === 'deadline') {
                    assert(outcome.error.message.includes('Clipboard request timed out'), 'Native deadline error was not preserved');
                    assert(GLib.get_monotonic_time() - began >= 55000000, 'Deadline failed too early');
                }
            }
            await portal('ClearOffer', new GLib.Variant('(s)', [currentOffer]));
            assert((await portal('GetOffer')).deepUnpack()[0] === '', 'Offer cleanup failed');
            currentOffer = '';
            print(`PASS native Shell bridge: ${testMode}`);
        }
        print('PASS isolated portal/native roundtrip; only random test MIME requested');
    } finally {
        if (currentOffer) {
            try {
                await portal('ClearOffer', new GLib.Variant('(s)', [currentOffer]));
            } catch {
                // Closing the mock owner also tears down the portal.
            }
        }
        if (subscription)
            bus.signal_unsubscribe(subscription);
        try {
            if (owned)
                await call(bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ReleaseName', new GLib.Variant('(s)', [SERVICE]));
        } finally {
            bus.close_sync(null);
        }
    }
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
run().catch(error => {
    printerr(`FAIL isolated Shell bridge: ${error.message}`);
    exitCode = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(exitCode);
