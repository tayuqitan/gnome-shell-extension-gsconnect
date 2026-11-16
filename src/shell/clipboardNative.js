// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GIRepository from 'gi://GIRepository';

// GJS cannot implement an async vfunc that takes GAsyncReadyCallback. The
// optional, ABI-matched native helper implements the vfunc and owns GTasks.
// Keep import failure isolated so the existing text portal can still load.
let NativeClipboard = null;
let loadError = '';
try {
    const directory = Gio.File.new_for_uri(import.meta.url).get_parent()
        .get_parent().get_child('native').get_path();
    if (GIRepository.Repository.hasOwnProperty('prepend_search_path')) {
        GIRepository.Repository.prepend_search_path(directory);
        GIRepository.Repository.prepend_library_path(directory);
    } else {
        const repository = GIRepository.Repository.dup_default();
        repository.prepend_search_path(directory);
        repository.prepend_library_path(directory);
    }
    const candidate = (await import('gi://GscClipboard?version=1.0')).default;
    // GI namespaces are lazy. Resolve the type and exercise construction before
    // announcing availability; a typelib alone does not prove the .so loads.
    let probe = null;
    try {
        probe = candidate.Source.new('gsconnect-abi-probe', ['text/plain'], 60);
        for (const method of ['resolve', 'close', 'get_offer_id', 'get_closed']) {
            if (typeof probe[method] !== 'function')
                throw new Error(`Native clipboard API missing ${method}`);
        }
        for (const signal of ['request', 'cancel-requested']) {
            const handler = probe.connect(signal, () => {});
            probe.disconnect(handler);
        }
        if (probe.get_offer_id() !== 'gsconnect-abi-probe' || probe.get_closed())
            throw new Error('Native clipboard constructor contract mismatch');
        probe.close();
        if (!probe.get_closed())
            throw new Error('Native clipboard close contract mismatch');
    } finally {
        probe?.close?.();
    }
    NativeClipboard = candidate;
} catch (error) {
    loadError = error.message;
    logError(new Error(`GSConnect native rich clipboard unavailable: ${loadError}. ` +
        'Text clipboard remains available; install the matching native bridge for rich clipboard.'));
}

/**
 * Whether an ABI-matched native source was loaded.
 *
 * @returns {boolean} Native rich clipboard availability
 */
export function isAvailable() {
    return NativeClipboard !== null;
}

/**
 * Create a source whose asynchronous vfuncs are implemented in native code.
 *
 * @param {string} id - Offer identifier
 * @param {string[]} mimetypes - Advertised formats
 * @param {number} timeoutSeconds - Total request deadline
 * @returns {object} A native Meta.SelectionSource
 */
export function createSource(id, mimetypes, timeoutSeconds) {
    if (!NativeClipboard)
        throw new Error(`Native rich clipboard bridge unavailable: ${loadError}`);
    return NativeClipboard.Source.new(id, mimetypes, timeoutSeconds);
}
