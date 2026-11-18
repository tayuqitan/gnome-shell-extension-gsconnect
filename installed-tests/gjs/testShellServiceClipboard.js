// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Private-bus client; service components use only this private session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import Gtk from 'gi://Gtk?version=3.0';

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
    assert(/^\/home\/gstest\/\.gsconnect-shell-check\.[A-Za-z0-9]+$/.test(root), 'Expected a dedicated smoke-test directory');
    assert(extension === `${root}/data/gnome-shell/extensions/gsconnect@andyholmes.github.io`, 'Unexpected extension path');
    for (const [key, suffix] of [['HOME', 'home'], ['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache'], ['XDG_RUNTIME_DIR', 'runtime']])
        assert(GLib.getenv(key) === `${root}/${suffix}`, `Unsafe ${key}; launch only inside the isolated runner`);
    assert(address === `unix:path=${root}/runtime/bus`, 'Exact private bus path required');
    assert(GLib.getenv('DBUS_SYSTEM_BUS_ADDRESS') === `unix:path=${root}/runtime/system-bus`,
        'Exact private mock system bus required');
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
        await serviceIntegration(options, portal);
        print('PASS isolated Shell/service integration; synthetic data only');
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

/**
 * Join production service clipboard orchestration to private Shell.
 *
 * @param {object} options - Verified private fixture paths
 * @param {function(string, GLib.Variant): Promise<GLib.Variant>} portal
 *     - Bounded portal call
 * @returns {Promise<void>} Integration result
 */
async function serviceIntegration(options, portal) {
    assert(GLib.getenv('WAYLAND_DISPLAY') === 'gsconnect-fixture', 'Private display required');
    Gtk.init(null);
    const debugErrors = [];
    globalThis.debug = error => debugErrors.push(error);
    globalThis._ = text => text;
    globalThis.HAVE_GNOME = true;
    Gio._promisify(Gio.AsyncInitable.prototype, 'init_async');
    Gio._promisify(Gio.DBusProxy.prototype, 'call');
    const base = Gio.File.new_for_path(options.extension).get_uri();
    const {default: Clipboard} = await import(`${base}/service/components/clipboard.js`);
    const {default: RichClipboard} = await import(`${base}/service/utils/richClipboard.js`);
    const app = new Gio.Application({application_id: 'org.gnome.GSConnect.PrivateFixture',
        flags: Gio.ApplicationFlags.NON_UNIQUE});
    app.set_default(); // No registration or service activation.
    app.settings = {get_value: () => ({deepUnpack: () => 1048576})};
    const clipboard = new Clipboard();
    let rich = null;
    try {
        for (let n = 0; !clipboard.richAvailable && n < 50; n++)
            await delay(100);
        assert(clipboard.richAvailable, 'Production service did not connect to portal');
        const notices = [], packets = [];
        const settings = {get_uint: key => ({'history-max-items': 50,
            'history-max-bytes': 1048576, 'rich-transfer-timeout': 60})[key],
        get_boolean: () => true, connect: () => 1, disconnect() {}};
        const device = {connected: true, name: 'Synthetic fixture',
            settings: {get_strv: () => ['gsconnect.clipboard.rich']},
            showNotification: notice => notices.push(notice), hideNotification() {},
            sendPacket: packet => packets.push(packet)};
        rich = new RichClipboard({settings, device}, clipboard);
        rich.remoteReady = true;
        let writes = 0;
        rich.request = (remote, detail, file, cancellable) => {
            assert(rich.fileReceiveCurrent(remote) && !cancellable.is_cancelled(),
                'Synthetic transport requires explicit receive authority');
            assert(detail.index === 0, 'Only synthetic fixture file expected');
            writes++;
            GLib.file_set_contents(file.get_path(), 'private synthetic file');
            return Promise.resolve();
        };
        await rich.accept({id: 'private-source', revision: 1, origin: 'private-peer',
            types: ['text/uri-list'], files: [{name: 'fixture.txt', size: 22}]});
        assert(writes === 0 && (await portal('GetOffer')).deepUnpack()[0] === '',
            'Metadata must not publish or download');
        await rich.receiveFiles(rich.remote.receiveToken);
        assert(writes === 1 && await clipboard.isCurrentOffer(rich.remote.clipboardId),
            'Complete receive publishes through actual service/Shell ownership');
        for (let n = 0; n < 2; n++) {
            const bytes = (await portal('GetValue', new GLib.Variant('(s)', ['text/uri-list'])))
                .deepUnpack()[0];
            const uri = new TextDecoder().decode(bytes).trim();
            assert(uri.startsWith(`file://${options.root}/cache/`), 'Private local cache URI only');
            const [, data] = Gio.File.new_for_uri(uri).load_contents(null);
            assert(new TextDecoder().decode(data) === 'private synthetic file', 'Exact cached bytes');
        }
        assert(writes === 1, 'Native reads must never refetch file payload');
        assert(notices.some(notice => notice.title === '文件已接收'), 'Receive completion feedback');
        print('PASS real service + Shell: explicit receive, cached URI, repeated native reads');
        const oldId = rich.remote.clipboardId;
        const newId = `new-local-${GLib.uuid_string_random()}`;
        await clipboard.offer(newId, [MIME], () => FIXTURE.slice(), 60);
        await clipboard.clearOffer(oldId);
        assert((await portal('GetOffer')).deepUnpack()[0] === newId,
            'Old cleanup must not clear new local offer');
        const bytes = (await portal('GetValue', new GLib.Variant('(s)', [MIME]))).deepUnpack()[0];
        assert(bytes.length === FIXTURE.length && FIXTURE.every((v, index) => bytes[index] === v),
            'New synthetic copy remains readable');
        await clipboard.clearOffer(newId);
        assert(debugErrors.length === 0, 'No hidden service errors');
        print('PASS real service + Shell: stale cleanup preserves replacement offer');
        for (const phase of ['Offer', 'GetOffer']) {
            await delay(50); // Settle the preceding synthetic ownership notifications.
            await rich.accept({id: `private-race-${phase}`, revision: 10, origin: 'private-peer',
                types: ['text/uri-list'], files: [{name: 'race.txt', size: 22}]});
            const remote = rich.remote;
            const originalCall = clipboard._call;
            const originalCheck = clipboard.isCurrentOffer;
            let release, entered;
            let captured = false, checking = false, settled = false;
            const held = new Promise(resolve => {
                release = resolve;
            });
            const reached = new Promise(resolve => {
                entered = resolve;
            });
            const noticeStart = notices.length;
            clipboard.isCurrentOffer = async function (id) {
                checking = id === remote.clipboardId;
                try {
                    return await originalCheck.call(this, id);
                } finally {
                    checking = false;
                }
            };
            clipboard._call = async function (method, parameters = null, proxy = this._clipboard) {
                const intercept = !captured && method === phase &&
                    (phase === 'Offer' ? parameters.deepUnpack()[0] === remote.clipboardId : checking);
                if (intercept)
                    captured = true;
                const reply = await originalCall.call(this, method, parameters, proxy);
                if (intercept) {
                    entered();
                    await held; // Delay delivery, not the real D-Bus operation itself.
                }
                return reply;
            };
            const receive = rich.receiveFiles(remote.receiveToken).then(
                () => {
                    settled = true;
                    return {ok: true};
                },
                error => {
                    settled = true;
                    return {error};
                });
            const replacement = `replacement-${phase}-${GLib.uuid_string_random()}`;
            try {
                const ready = await Promise.race([reached.then(() => true),
                    delay(5000).then(() => false)]);
                assert(ready && !settled, `${phase}: pending response boundary was reached`);
                assert((await portal('GetOffer')).deepUnpack()[0] === remote.clipboardId,
                    `${phase}: original offer really reached Shell`);
                rich.cancelDownload(remote.receiveToken);
                await clipboard.offer(replacement, [MIME], () => FIXTURE.slice(), 60);
                assert((await portal('GetOffer')).deepUnpack()[0] === replacement,
                    `${phase}: replacement really reached Shell`);
                assert(!settled, `${phase}: cancellation does not falsely claim immediate completion`);
                release();
                const result = await receive;
                assert(Boolean(result.error) && result.error.message.includes('取消'),
                    `${phase}: revoked receive must fail with cancellation`);
                assert(await originalCheck.call(clipboard, replacement),
                    `${phase}: old receive cleanup preserves new ownership`);
                const value = (await portal('GetValue', new GLib.Variant('(s)', [MIME])))
                    .deepUnpack()[0];
                assert(value.length === FIXTURE.length && FIXTURE.every((v, i) => value[i] === v),
                    `${phase}: replacement bytes remain readable after old cleanup`);
                assert(!notices.slice(noticeStart).some(notice => notice.title === '文件已接收'),
                    `${phase}: canceled receive must not report success`);
                print(`PASS real service + Shell: cancel at delayed ${phase} delivery preserves replacement`);
            } finally {
                release();
                await receive;
                clipboard._call = originalCall;
                clipboard.isCurrentOffer = originalCheck;
                await clipboard.clearOffer(replacement);
            }
        }

    } finally {
        rich?.destroy();
        clipboard.destroy();
        await delay(50);
        assert(debugErrors.length === 0, 'No hidden service errors during teardown');
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
