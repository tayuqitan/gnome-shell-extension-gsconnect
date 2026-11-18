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
print(`PASS explicit receive: ${passed}/${passed}; synthetic transport/desktop, real GJS/Gio/cache`);
