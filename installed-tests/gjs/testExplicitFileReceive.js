// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Refuse accidental use of the caller's real application cache or desktop.
const work = GLib.get_current_dir();
if (!/^\.gsconnect-receive-(check|local)\.[A-Za-z0-9]+$/.test(GLib.path_get_basename(work)) ||
    GLib.getenv('HOME') !== `${work}/home` ||
    GLib.get_user_cache_dir() !== `${work}/cache` ||
    ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'].some(key => GLib.getenv(key)) ||
    Gio.File.new_for_path(`${work}/cache/gsconnect`).query_exists(null))
    throw new Error('Use a fresh isolated receive-test directory and empty HOME/cache');

// Import the exact packaged source when a package root is supplied. No service,
// desktop, network transport, real clipboard or paired-device data is used.
const root = ARGV[0] || GLib.build_filenamev([GLib.get_current_dir(), 'src']);
const {default: RichClipboard} = await import(
    `${Gio.File.new_for_path(root).get_uri()}/service/utils/richClipboard.js`);
const {getClipboardCacheStorage} = await import(
    `${Gio.File.new_for_path(root).get_uri()}/service/utils/clipboardCacheStorage.js`);
globalThis._ = text => text;
globalThis.debug = () => {};
const app = new Gio.Application({application_id: 'org.gnome.GSConnect.SyntheticReceive',
    flags: Gio.ApplicationFlags.NON_UNIQUE});
// Setting a process-local default does not register or connect a D-Bus service.
app.set_default();
app.settings = {get_value: () => ({deepUnpack: () => 1024 * 1024})};

/**
 * Assert a synthetic contract.
 *
 * @param {boolean} condition - Required condition
 * @param {string} message - Failure description
 */
function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}
/**
 * Require a Promise rejection.
 *
 * @param {Promise} promise - Operation to test
 */
async function rejects(promise) {
    let failed = false;
    try {
        await promise;
    } catch {
        failed = true;
    }
    assert(failed, 'expected rejection');
}
/**
 * Construct actual orchestration with synthetic desktop and transport edges.
 *
 * @returns {object} Fixture controls
 */
function fixture() {
    const notices = [], publications = [], packets = [];
    let owner = null;
    const settings = {get_uint: key => ({'history-max-items': 50,
        'history-max-bytes': 1048576, 'rich-transfer-timeout': 60})[key],
    get_boolean: () => true, connect: () => 1, disconnect() {}};
    const clipboard = {richAvailable: true, generation: 1, mimetypes: [],
        connect: () => 1, disconnect() {},
        offer(id, types, provider) {
            owner = id;
            this.generation++;
            publications.push({id, types, provider});
            // Model our own OwnerChange in addition to the offer generation.
            this.generation++;
            return Promise.resolve();
        },
        isCurrentOffer: id => Promise.resolve(owner === id),
        clearOffer(id) {
            if (owner === id)
                owner = null;
            return Promise.resolve();
        }};
    const device = {connected: true, name: 'Synthetic peer',
        settings: {get_strv: () => ['gsconnect.clipboard.rich']},
        sendPacket: packet => packets.push(packet),
        showNotification: notice => notices.push(notice), hideNotification() {}};
    const rich = new RichClipboard({settings, device}, clipboard);
    rich.remoteReady = true;
    return {rich, clipboard, device, notices, publications, packets, owner: () => owner};
}
/**
 * Make immutable-source test metadata.
 *
 * @param {number} revision - Offer revision
 * @returns {object} Synthetic file offer
 */
function offer(revision = 1) {
    return {id: 'synthetic-files', revision, origin: 'synthetic-origin',
        types: ['text/uri-list', 'x-special/gnome-copied-files'],
        files: [{name: 'first.txt', size: 3}, {name: 'second.txt', size: 4}]};
}
/**
 * Replace only the transport with deterministic local writes.
 * Real cache admission, commit, GLib and Gio cancellation still execute.
 *
 * @param {object} f - Fixture
 * @param {function(number): void} beforeWrite - Optional controlled fault
 * @returns {function(): number} Number of attempted payload writes
 */
function localTransport(f, beforeWrite = () => {}) {
    let writes = 0;
    f.rich.request = (remote, detail, file, cancellable) => {
        assert(f.rich.fileReceiveCurrent(remote), 'transport needs explicit authorization');
        assert(!cancellable.is_cancelled(), 'transport must not use cancelled token');
        writes++;
        beforeWrite(writes);
        GLib.file_set_contents(file.get_path(), detail.index === 0 ? 'abc' : 'defg');
        return Promise.resolve();
    };
    return () => writes;
}
let passed = 0;
/**
 * Run and report one component scenario.
 *
 * @param {string} label - Scenario label
 * @param {function(): Promise<void>} run - Async assertions
 */
async function check(label, run) {
    await run();
    passed++;
    print(`PASS ${label}`);
}
await check('metadata, history restoration and unauthorized requests never download', async () => {
    const f = fixture();
    try {
        await f.rich.accept(offer());
        await rejects(f.rich.getFiles(f.rich.remote));
        await rejects(f.rich.request(f.rich.remote, {index: 0}, null));
        await f.rich.activateHistory(f.rich.history.get('remote:synthetic-files'));
        assert(f.publications.length === 0 && f.packets.length === 0, 'no publication or network');
        assert(f.notices[0].buttons[0].parameter.deepUnpack().length > 0, 'real Variant token');
    } finally {
        f.rich.destroy();
    }
});
await check('explicit receive commits real private files before local URI publication', async () => {
    const f = fixture();
    try {
        await f.rich.accept(offer());
        const writes = localTransport(f);
        const one = f.rich.receiveFiles(f.rich.remote.receiveToken);
        const two = f.rich.receiveFiles(f.rich.remote.receiveToken);
        assert(one === two, 'duplicate action coalesces');
        await one;
        assert(writes() === 2 && f.publications.length === 1, 'one complete batch');
        const source = f.publications[0];
        for (const mime of source.types) {
            const text = new TextDecoder().decode(source.provider(mime));
            const uris = text.split(/\r?\n/).filter(line => line.startsWith('file:///'));
            assert(uris.length === 2, 'both local files offered');
            for (const uri of uris) {
                const file = Gio.File.new_for_uri(uri);
                const info = file.query_info('standard::size,unix::mode',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                assert([3, 4].includes(info.get_size()), 'complete file size');
                const [, bytes] = file.load_contents(null);
                assert(['abc', 'defg'].includes(new TextDecoder().decode(bytes)), 'exact bytes');
                assert((info.get_attribute_uint32('unix::mode') & 0o077) === 0, 'private file');
            }
        }
        assert(writes() === 2 && f.packets.length === 0, 'provider only returns cached bytes');
    } finally {
        f.rich.destroy();
    }
});
for (const reason of ['cancel', 'generation', 'disconnect', 'write-failure']) {
    await check(`${reason} prevents publication and a successful completion notice`, async () => {
        const f = fixture();
        try {
            await f.rich.accept(offer());
            const before = getClipboardCacheStorage(1048576).snapshot().used;
            localTransport(f, number => {
                if (number !== 1)
                    return;
                if (reason === 'cancel')
                    f.rich.cancelDownload(f.rich.remote.receiveToken);
                if (reason === 'generation')
                    f.clipboard.generation++;
                if (reason === 'disconnect')
                    f.device.connected = false;
                if (reason === 'write-failure')
                    throw new Error('synthetic disk failure');
            });
            await rejects(f.rich.receiveFiles(f.rich.remote.receiveToken));
            assert(f.publications.length === 0 && f.owner() === null, 'no partial publication');
            const after = getClipboardCacheStorage(1048576).snapshot();
            assert(after.used === before && after.failedBatches === 0, 'rollback releases quota');
            assert(!f.notices.some(notice => notice.title === '文件已接收'), 'no false success');
        } finally {
            f.rich.destroy();
        }
    });
}
await check('old notification cannot authorize a newer revision', async () => {
    const f = fixture();
    try {
        await f.rich.accept(offer());
        const token = f.rich.remote.receiveToken;
        await f.rich.accept(offer(2));
        const writes = localTransport(f);
        await rejects(f.rich.receiveFiles(token));
        assert(writes() === 0 && f.publications.length === 0, 'old token has no authority');
    } finally {
        f.rich.destroy();
    }
});
await check('same-tick history receives coalesce with real Gio cancellation objects', async () => {
    const f = fixture();
    try {
        await f.rich.accept(offer());
        const writes = localTransport(f);
        const entry = f.rich.history.get('remote:synthetic-files');
        await Promise.all([f.rich.receiveHistoryFiles(entry), f.rich.receiveHistoryFiles(entry)]);
        assert(writes() === 2 && f.publications.length === 1, 'history coalesces');
    } finally {
        f.rich.destroy();
    }
});
/**
 * Load a single production method without importing service initializers.
 *
 * @param {string} file - Packaged source path
 * @param {string} name - Method name
 * @param {object} gio - Gio boundary used by this method
 * @returns {function(object, object): void} Unmodified production method
 */
function productionMethod(file, name, gio = Gio) {
    const [, bytes] = GLib.file_get_contents(`${root}/${file}`);
    const source = new TextDecoder().decode(bytes);
    const match = source.match(new RegExp(`^    (?:async )?${name}\\([^]*?^    }`, 'm'));
    assert(Boolean(match), `missing production method ${name}`);
    return new Function('Gio', 'GLib', 'logError',
        `return ({${match[0]}}).${name};`)(gio, GLib, error => {
        throw error;
    });
}
/**
 * Join actual notification routing with in-process GActions and real Variants.
 * Only the notification renderer and transport/clipboard edges are synthetic.
 *
 * @param {object} f - Receive fixture
 * @returns {object} Notification records and explicit activation controls
 */
function notificationRoute(f) {
    const records = [], pending = [];
    class Notification {
        constructor() {
            this.buttons = [];
        }

        set_title(value) {
            this.title = value;
        }

        set_body(value) {
            this.body = value;
        }

        set_icon(value) {
            this.icon = value;
        }

        set_priority(value) {
            this.priority = value;
        }

        add_button_with_target(label, action, target) {
            this.buttons.push({label, action, target});
        }

        set_default_action_and_target() {
            throw new Error('Receiving must require the explicit button');
        }
    }
    const gio = {Notification, ThemedIcon: Gio.ThemedIcon,
        NotificationPriority: Gio.NotificationPriority};
    const show = productionMethod('service/device.js', 'showNotification', gio);
    const device = {id: 'synthetic-device', name: 'Synthetic peer',
        icon_name: 'computer-symbolic',
        service: {send_notification: (id, notification) => records.push({id, notification})}};
    f.device.showNotification = params => show.call(device, params);
    const receive = productionMethod('service/plugins/clipboard.js', 'clipboardReceiveFiles');
    const activate = productionMethod('service/plugin.js', '_activateAction');
    const plugin = {_rich: f.rich, device: f.device,
        clipboardReceiveFiles(token) {
            pending.push(receive.call(this, token));
        }};
    // Load only the production Variant unpacker, not its service initializer.
    const [, bytes] = GLib.file_get_contents(`${root}/service/init.js`);
    const unpack = new TextDecoder().decode(bytes).match(/^function _full_unpack\([^]*?^}/m);
    assert(Boolean(unpack), 'production Variant unpacker exists');
    GLib.Variant.prototype.full_unpack = new Function('GLib', 'Gio',
        `${unpack[0]}; return _full_unpack;`)(GLib, Gio);
    const actions = new Gio.SimpleActionGroup();
    const action = new Gio.SimpleAction({name: 'clipboardReceiveFiles', parameter_type: new GLib.VariantType('s')});
    action.connect('activate', (...args) => activate.call(plugin, ...args));
    actions.add_action(action);
    const route = productionMethod('service/daemon.js', '_device');
    const daemon = {manager: {devices: new Map([[device.id, actions]])}};
    return {records, action,
        click(record) {
            const button = record.notification.buttons[0];
            assert(button.action === 'app.device', 'notification uses application router');
            assert(button.target.get_type_string() === '(ssbv)', 'typed routing envelope');
            const fields = button.target.deepUnpack();
            assert(fields[0] === device.id && fields[1] === 'clipboardReceiveFiles' && fields[2],
                'target device and action preserved');
            route.call(daemon, null, button.target);
        },
        async settle() {
            await Promise.all(pending);
        }};
}
await check('notification button routes production methods into one explicit receive', async () => {
    const f = fixture();
    try {
        const route = notificationRoute(f);
        const writes = localTransport(f);
        await f.rich.accept(offer());
        assert(writes() === 0 && f.publications.length === 0, 'notification alone has no transfer');
        const ready = route.records[0];
        assert(ready.notification.buttons[0].label === '接收并准备粘贴', 'explicit receive label');
        route.click(ready);
        route.click(ready);
        await route.settle();
        assert(writes() === 2 && f.publications.length === 1, 'two clicks coalesce into one batch');
        const success = route.records.find(item => item.notification.title === '文件已接收');
        assert(Boolean(success) && success.id === ready.id, 'success replaces offer notification');
        assert(success.notification.buttons.length === 0, 'completed notification has no stale button');
    } finally {
        f.rich.destroy();
    }
});
await check('old notification routes to visible error without authorizing replacement offer', async () => {
    const f = fixture();
    try {
        const route = notificationRoute(f);
        const writes = localTransport(f);
        await f.rich.accept(offer());
        const old = route.records[0];
        await f.rich.accept(offer(2));
        route.click(old);
        await route.settle();
        assert(writes() === 0 && f.publications.length === 0, 'old token cannot start receive');
        assert(route.records.some(item => item.notification.title === '无法接收文件' &&
            item.notification.body.includes('已改变')), 'plugin emits actionable stale error');
    } finally {
        f.rich.destroy();
    }
});
await check('disabled action and disconnected receive both fail without transfer', async () => {
    const f = fixture();
    try {
        const route = notificationRoute(f);
        const writes = localTransport(f);
        await f.rich.accept(offer());
        route.action.set_enabled(false);
        route.click(route.records[0]);
        await route.settle();
        assert(route.records.length === 1 && writes() === 0, 'disabled GAction ignores click');
        route.action.set_enabled(true);
        f.device.connected = false;
        route.click(route.records[0]);
        await route.settle();
        assert(writes() === 0 && f.publications.length === 0, 'disconnect independently denies receive');
        assert(route.records.some(item => item.notification.title === '无法接收文件'),
            'connected-state rejection produces error notification');
    } finally {
        f.rich.destroy();
    }
});
/**
 * Connect two production orchestrators through a synthetic in-memory transport.
 * Source files, Gio streams, request validation and cache commits remain real.
 *
 * @param {string} mode - Optional synthetic fault
 * @returns {object} Paired fixtures and packet-drain controls
 */
function pairedTransport(mode) {
    const sender = fixture(), receiver = fixture();
    const jobs = [], streams = new Map(), requests = [], rejected = [];
    let copies = 0;
    const dispatch = (target, packet) => {
        const wire = JSON.parse(JSON.stringify(packet));
        wire.hasPayload = () => Number.isSafeInteger(wire.payloadSize);
        jobs.push(target.rich.handle(wire));
    };
    sender.device.sendPacket = packet => dispatch(receiver, packet);
    receiver.device.sendPacket = packet => {
        if (packet.body.op === 'request')
            requests.push(packet.body);
        dispatch(sender, packet);
    };
    sender.device.createTransfer = () => ({cancellable: new Gio.Cancellable(),
        addStream(packet, stream, size) {
            Object.assign(this, {packet, stream, size});
        },
        async start() {
            streams.set(this.packet.body.request, this.stream);
            try {
                const packet = {...this.packet, payloadSize: this.size + (mode === 'size' ? 1 : 0)};
                packet.hasPayload = () => true;
                await receiver.rich.handle(packet);
            } finally {
                streams.delete(this.packet.body.request);
            }
        },
        cancel() {
            this.cancellable.cancel();
        },
        abandon() {
            this.cancel();
        }});
    receiver.device.rejectTransfer = packet => rejected.push(packet.body.request);
    receiver.device.createTransfer = () => ({addFile(packet, file) {
        Object.assign(this, {packet, file});
    },
    start(cancellable) {
        assert(!cancellable.is_cancelled(), 'active receive token');
        const stream = streams.get(this.packet.body.request);
        assert(Boolean(stream), 'request-specific source stream');
        const bytes = stream.read_bytes(this.packet.payloadSize + 1, cancellable).get_data();
        assert(bytes.length === this.packet.payloadSize, 'complete synthetic payload');
        this.file.replace_contents(bytes, null, false, Gio.FileCreateFlags.PRIVATE, cancellable);
        copies++;
    },
    cancel() {}});
    return {sender, receiver, requests, rejected, copies: () => copies,
        async drain() {
            while (jobs.length)
                await jobs.shift();
        },
        destroy() {
            sender.rich.destroy();
            receiver.rich.destroy();
        }};
}
// Promise wrappers are local to this isolated process; no service init is run.
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.FileInputStream.prototype, 'query_info_async', 'query_info_finish');
for (const mode of ['normal', 'source-changed', 'size']) {
    await check(`paired production orchestration through memory transport: ${mode}`, async () => {
        const pair = pairedTransport(mode);
        const route = notificationRoute(pair.receiver);
        const source = Gio.File.new_for_path(`${work}/synthetic-${mode}.txt`);
        source.replace_contents(new TextEncoder().encode('synthetic payload'), null,
            false, Gio.FileCreateFlags.PRIVATE, null);
        pair.sender.clipboard.mimetypes = ['text/uri-list'];
        pair.sender.clipboard.readValue = () =>
            Promise.resolve(new TextEncoder().encode(`${source.get_uri()}\r\n`));
        try {
            await pair.sender.rich.publish();
            await pair.drain();
            assert(pair.requests.length === 0 && pair.copies() === 0 &&
                pair.receiver.publications.length === 0, 'offer exchange cannot download');
            const offerNotice = route.records.find(item => item.notification.buttons.length);
            assert(Boolean(offerNotice), 'metadata yields receive notification');
            if (mode === 'source-changed') {
                source.replace_contents(new TextEncoder().encode('changed size'), null,
                    false, Gio.FileCreateFlags.PRIVATE, null);
            }
            const before = getClipboardCacheStorage(1048576).snapshot().used;
            route.click(offerNotice);
            await route.settle();
            await pair.drain();
            assert(pair.requests.length === 1, 'one correlated request');
            const request = pair.requests[0];
            assert(request.revision === pair.sender.rich.local.revision &&
                request.origin === pair.sender.rich.local.origin, 'request binds offered version');
            assert(pair.receiver.rich.pending.size === 0 && pair.sender.rich.serving.size === 0,
                'all request and serving state cleared');
            if (mode === 'normal') {
                assert(pair.copies() === 1 && pair.receiver.publications.length === 1,
                    'one payload committed and published');
                const publication = pair.receiver.publications[0];
                const bytes = await publication.provider('text/uri-list');
                const uri = new TextDecoder().decode(bytes).trim();
                assert(uri.startsWith(`file://${work}/cache/`), 'only private cached URI exposed');
                const [, contents] = Gio.File.new_for_uri(uri).load_contents(null);
                assert(new TextDecoder().decode(contents) === 'synthetic payload', 'exact payload');
                await publication.provider('text/uri-list');
                assert(pair.requests.length === 1, 'later clipboard reads do not refetch');
            } else {
                assert(pair.copies() === 0 && pair.receiver.publications.length === 0,
                    'invalid source or payload never reaches clipboard');
                assert(getClipboardCacheStorage(1048576).snapshot().used === before,
                    'failed batch releases cache allocation');
                assert(route.records.some(item => item.notification.title === '无法接收文件'),
                    'error reaches notification layer');
                if (mode === 'size')
                    assert(pair.rejected.length === 1, 'invalid payload is explicitly rejected');
            }
        } finally {
            pair.destroy();
            source.delete(null);
        }
    });
}
print(`PASS explicit receive: ${passed}/${passed}; synthetic transport/desktop, real GJS/Gio/cache`);
