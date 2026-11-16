/* SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
 * SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once

#include <gio/gio.h>
#include <meta/meta-selection-source.h>

G_BEGIN_DECLS

#define GSC_CLIPBOARD_TYPE_SOURCE (gsc_clipboard_source_get_type ())
G_DECLARE_FINAL_TYPE (GscClipboardSource, gsc_clipboard_source,
                      GSC_CLIPBOARD, SOURCE, MetaSelectionSource)

/**
 * gsc_clipboard_source_new:
 * @offer_id: opaque offer identifier
 * @mimetypes: (array zero-terminated=1) (element-type utf8): advertised formats
 * @timeout_seconds: whole-request deadline, between 60 and 86400 seconds
 * @error: return location for an error
 *
 * Create on the compositor's main thread. All methods except GCancellable
 * cancellation must be called from that same thread.
 *
 * Returns: (transfer full): a new clipboard source
 */
GscClipboardSource *gsc_clipboard_source_new (const gchar         *offer_id,
                                           const gchar * const *mimetypes,
                                           guint                timeout_seconds,
                                           GError             **error);

/**
 * gsc_clipboard_source_resolve:
 * @self: clipboard source
 * @request_id: ID received in the request signal
 * @value: (nullable): clipboard representation, at most 16 MiB
 * @error_message: (nullable): nonempty failure message, or NULL/empty on success
 *
 * Completes at most one pending request. Late or duplicate replies are ignored.
 * File bodies must use the service transport, not this memory-only bridge.
 *
 * Returns: whether the request existed
 */
gboolean gsc_clipboard_source_resolve (GscClipboardSource *self,
                                       const gchar        *request_id,
                                       GBytes             *value,
                                       const gchar        *error_message);

/**
 * gsc_clipboard_source_close:
 * @self: clipboard source
 *
 * Permanently reject reads and cancel all pending requests. Idempotent.
 */
void gsc_clipboard_source_close (GscClipboardSource *self);

/**
 * gsc_clipboard_source_get_offer_id:
 * @self: clipboard source
 * Returns: (transfer none): opaque offer identifier
 */
const gchar *gsc_clipboard_source_get_offer_id (GscClipboardSource *self);

/**
 * gsc_clipboard_source_get_closed:
 * @self: clipboard source
 * Returns: whether the source was closed
 */
gboolean gsc_clipboard_source_get_closed (GscClipboardSource *self);

G_END_DECLS
