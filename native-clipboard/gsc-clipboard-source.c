/* SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "gsc-clipboard-source.h"
#include <string.h>

#define MAX_VALUE_BYTES (16 * 1024 * 1024)
#define MAX_PENDING_REQUESTS 32

typedef struct {
  GTask *task;
  GSource *timeout;
  gulong cancelled_id;
  gint cancel_requested;
} Pending;

typedef struct {
  GscClipboardSource *source;
  gchar *request_id;
  Pending *pending; /* Only used inside the connected cancellable callback. */
} RequestRef;

struct _GscClipboardSource {
  MetaSelectionSource parent_instance;
  gchar *offer_id;
  gchar **mimetypes;
  guint timeout_seconds;
  GHashTable *pending;
  GMainContext *context;
  GThread *owner_thread;
  gboolean closed;
};

G_DEFINE_TYPE (GscClipboardSource, gsc_clipboard_source, META_TYPE_SELECTION_SOURCE)

enum { REQUEST, CANCEL_REQUESTED, N_SIGNALS };
static guint signals[N_SIGNALS];
static char source_read_tag;

static RequestRef *
request_ref_new (GscClipboardSource *self, const gchar *request_id)
{
  RequestRef *ref = g_new0 (RequestRef, 1);
  ref->source = g_object_ref (self);
  ref->request_id = g_strdup (request_id);
  return ref;
}

static void
request_ref_free (gpointer data)
{
  RequestRef *ref = data;
  g_object_unref (ref->source);
  g_free (ref->request_id);
  g_free (ref);
}

static void
pending_free (Pending *pending)
{
  GCancellable *cancellable = g_task_get_cancellable (pending->task);
  if (pending->cancelled_id != 0)
    g_cancellable_disconnect (cancellable, pending->cancelled_id);
  if (pending->timeout != NULL) {
    g_source_destroy (pending->timeout);
    g_source_unref (pending->timeout);
  }
  g_object_unref (pending->task);
  g_free (pending);
}

/* Remove before notifying JS: signal handlers may resolve or close reentrantly. */
static gboolean
complete_request (GscClipboardSource *self, const gchar *request_id,
                  GBytes *bytes, GError *error)
{
  gpointer key = NULL;
  gpointer value = NULL;
  if (!g_hash_table_steal_extended (self->pending, request_id, &key, &value)) {
    g_clear_error (&error);
    return FALSE;
  }
  Pending *pending = value;
  if (error == NULL &&
      (g_atomic_int_get (&pending->cancel_requested) ||
       (g_task_get_cancellable (pending->task) != NULL &&
        g_cancellable_is_cancelled (g_task_get_cancellable (pending->task)))))
    error = g_error_new_literal (G_IO_ERROR, G_IO_ERROR_CANCELLED,
                                 "Clipboard request cancelled");
  /* Keep self alive across timeout/cancellable cleanup and arbitrary JS. */
  g_object_ref (self);
  if (error != NULL) {
    g_signal_emit (self, signals[CANCEL_REQUESTED], 0, (const gchar *) key);
    g_task_return_error (pending->task, error);
  } else {
    GInputStream *stream = g_memory_input_stream_new_from_bytes (bytes);
    g_task_return_pointer (pending->task, stream, g_object_unref);
  }
  pending_free (pending);
  g_free (key);
  g_object_unref (self);
  return TRUE;
}

static gboolean
cancel_on_main (gpointer data)
{
  RequestRef *ref = data;
  complete_request (ref->source, ref->request_id, NULL,
                    g_error_new_literal (G_IO_ERROR, G_IO_ERROR_CANCELLED,
                                         "Clipboard request cancelled"));
  return G_SOURCE_REMOVE;
}

static void
on_cancelled (GCancellable *cancellable, gpointer data)
{
  RequestRef *ref = data;
  (void) cancellable;
  /* pending_free disconnects before freeing pending; disconnect waits until
   * this callback returns, so this atomic write is lifetime-safe. */
  g_atomic_int_set (&ref->pending->cancel_requested, TRUE);
  /* Never use invoke_full here: it may run synchronously on the owner thread,
   * then pending_free would disconnect inside this callback and deadlock.
   * A fresh idle source always defers completion until this callback returns. */
  GSource *idle = g_idle_source_new ();
  g_source_set_callback (idle, cancel_on_main,
                        request_ref_new (ref->source, ref->request_id),
                        request_ref_free);
  g_source_attach (idle, ref->source->context);
  g_source_unref (idle);
}

static gboolean
on_timeout (gpointer data)
{
  RequestRef *ref = data;
  complete_request (ref->source, ref->request_id, NULL,
                    g_error_new_literal (G_IO_ERROR, G_IO_ERROR_TIMED_OUT,
                                         "Clipboard request timed out"));
  return G_SOURCE_REMOVE;
}

static GList *
source_get_mimetypes (MetaSelectionSource *source)
{
  GscClipboardSource *self = GSC_CLIPBOARD_SOURCE (source);
  GList *result = NULL;
  for (guint i = 0; self->mimetypes != NULL && self->mimetypes[i] != NULL; i++)
    result = g_list_prepend (result, g_strdup (self->mimetypes[i]));
  return g_list_reverse (result);
}

static void
source_read_async (MetaSelectionSource *source, const gchar *mimetype,
                   GCancellable *cancellable, GAsyncReadyCallback callback,
                   gpointer user_data)
{
  GscClipboardSource *self = GSC_CLIPBOARD_SOURCE (source);
  GTask *task = g_task_new (self, cancellable, callback, user_data);
  g_task_set_source_tag (task, &source_read_tag);
  if (self->owner_thread != g_thread_self ()) {
    g_task_return_new_error (task, G_IO_ERROR, G_IO_ERROR_FAILED,
                             "Clipboard reads must start on the owner thread");
    g_object_unref (task);
    return;
  }
  if (g_task_return_error_if_cancelled (task)) {
    g_object_unref (task);
    return;
  }
  if (self->closed || mimetype == NULL || self->mimetypes == NULL ||
      !g_strv_contains ((const gchar * const *) self->mimetypes, mimetype)) {
    g_task_return_new_error (task, G_IO_ERROR, G_IO_ERROR_NOT_FOUND,
                             "Clipboard format is no longer available");
    g_object_unref (task);
    return;
  }
  if (g_hash_table_size (self->pending) >= MAX_PENDING_REQUESTS) {
    g_task_return_new_error (task, G_IO_ERROR, G_IO_ERROR_BUSY,
                             "Too many pending clipboard requests");
    g_object_unref (task);
    return;
  }
  gchar *request_id = g_uuid_string_random ();
  Pending *pending = g_new0 (Pending, 1);
  pending->task = task;
  g_hash_table_insert (self->pending, g_strdup (request_id), pending);
  pending->timeout = g_timeout_source_new_seconds (self->timeout_seconds);
  g_source_set_callback (pending->timeout, on_timeout,
                        request_ref_new (self, request_id), request_ref_free);
  g_source_attach (pending->timeout, self->context);
  if (cancellable != NULL) {
    RequestRef *cancel_ref = request_ref_new (self, request_id);
    cancel_ref->pending = pending;
    pending->cancelled_id = g_cancellable_connect (cancellable,
        G_CALLBACK (on_cancelled), cancel_ref, request_ref_free);
  }
  if (cancellable != NULL && g_cancellable_is_cancelled (cancellable)) {
    complete_request (self, request_id, NULL,
                      g_error_new_literal (G_IO_ERROR, G_IO_ERROR_CANCELLED,
                                           "Clipboard request cancelled"));
  } else {
    /* May complete synchronously through resolve(); do not touch pending again. */
    g_signal_emit (self, signals[REQUEST], 0, request_id, mimetype);
  }
  g_free (request_id);
}

static GInputStream *
source_read_finish (MetaSelectionSource *source, GAsyncResult *result, GError **error)
{
  g_return_val_if_fail (g_task_is_valid (result, source), NULL);
  g_return_val_if_fail (g_task_get_source_tag (G_TASK (result)) == &source_read_tag, NULL);
  return g_task_propagate_pointer (G_TASK (result), error);
}

static void
source_deactivated (MetaSelectionSource *source)
{
  gsc_clipboard_source_close (GSC_CLIPBOARD_SOURCE (source));
  MetaSelectionSourceClass *parent = META_SELECTION_SOURCE_CLASS (gsc_clipboard_source_parent_class);
  if (parent->deactivated != NULL)
    parent->deactivated (source);
}

static void
source_dispose (GObject *object)
{
  gsc_clipboard_source_close (GSC_CLIPBOARD_SOURCE (object));
  G_OBJECT_CLASS (gsc_clipboard_source_parent_class)->dispose (object);
}

static void
source_finalize (GObject *object)
{
  GscClipboardSource *self = GSC_CLIPBOARD_SOURCE (object);
  g_free (self->offer_id);
  g_strfreev (self->mimetypes);
  g_hash_table_unref (self->pending);
  g_main_context_unref (self->context);
  G_OBJECT_CLASS (gsc_clipboard_source_parent_class)->finalize (object);
}

static void
gsc_clipboard_source_class_init (GscClipboardSourceClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);
  MetaSelectionSourceClass *selection_class = META_SELECTION_SOURCE_CLASS (klass);
  object_class->dispose = source_dispose;
  object_class->finalize = source_finalize;
  selection_class->get_mimetypes = source_get_mimetypes;
  selection_class->read_async = source_read_async;
  selection_class->read_finish = source_read_finish;
  selection_class->deactivated = source_deactivated;
  /**
   * GscClipboardSource::request:
   * @self: clipboard source
   * @request_id: opaque request identifier
   * @mimetype: requested representation
   *
   * The handler may synchronously reject a gated read by calling resolve().
   */
  signals[REQUEST] = g_signal_new ("request", G_TYPE_FROM_CLASS (klass), G_SIGNAL_RUN_LAST,
                                  0, NULL, NULL, NULL, G_TYPE_NONE, 2,
                                  G_TYPE_STRING, G_TYPE_STRING);
  /**
   * GscClipboardSource::cancel-requested:
   * @self: clipboard source
   * @request_id: request to cancel in the transport
   */
  signals[CANCEL_REQUESTED] = g_signal_new ("cancel-requested", G_TYPE_FROM_CLASS (klass),
      G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL, G_TYPE_NONE, 1, G_TYPE_STRING);
}

static void
gsc_clipboard_source_init (GscClipboardSource *self)
{
  self->pending = g_hash_table_new (g_str_hash, g_str_equal);
  self->context = g_main_context_ref_thread_default ();
  self->owner_thread = g_thread_self ();
  self->timeout_seconds = 3600;
}

GscClipboardSource *
gsc_clipboard_source_new (const gchar *offer_id, const gchar * const *mimetypes,
                          guint timeout_seconds, GError **error)
{
  if (offer_id == NULL || *offer_id == '\0' || strlen (offer_id) > 256 ||
      !g_utf8_validate (offer_id, -1, NULL) || mimetypes == NULL ||
      mimetypes[0] == NULL || timeout_seconds < 60 || timeout_seconds > 86400)
    goto invalid;
  for (guint i = 0; mimetypes[i] != NULL; i++) {
    if (i >= 64 || *mimetypes[i] == '\0' || strlen (mimetypes[i]) > 256 ||
        !g_utf8_validate (mimetypes[i], -1, NULL))
      goto invalid;
    for (const gchar *p = mimetypes[i]; *p != '\0'; p++)
      if ((guchar) *p < 32)
        goto invalid;
  }
  GscClipboardSource *self = g_object_new (GSC_CLIPBOARD_TYPE_SOURCE, NULL);
  self->offer_id = g_strdup (offer_id);
  self->mimetypes = g_strdupv ((gchar **) mimetypes);
  self->timeout_seconds = timeout_seconds;
  return self;
invalid:
  g_set_error_literal (error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT,
                       "Invalid clipboard offer or deadline");
  return NULL;
}

gboolean
gsc_clipboard_source_resolve (GscClipboardSource *self, const gchar *request_id,
                              GBytes *value, const gchar *error_message)
{
  g_return_val_if_fail (GSC_CLIPBOARD_IS_SOURCE (self), FALSE);
  g_return_val_if_fail (self->owner_thread == g_thread_self (), FALSE);
  g_return_val_if_fail (request_id != NULL, FALSE);
  GError *error = NULL;
  if (error_message != NULL && *error_message != '\0') {
    /* Bound diagnostic input; no remote contents are logged. */
    gchar *bounded = g_strndup (error_message, 512);
    gchar *message = g_utf8_make_valid (bounded, -1);
    error = g_error_new_literal (G_IO_ERROR, G_IO_ERROR_FAILED, message);
    g_free (message);
    g_free (bounded);
  } else if (value == NULL || g_bytes_get_size (value) > MAX_VALUE_BYTES) {
    error = g_error_new_literal (G_IO_ERROR, G_IO_ERROR_INVALID_DATA,
                                 "Clipboard representation is missing or exceeds 16 MiB");
  }
  return complete_request (self, request_id, value, error);
}

void
gsc_clipboard_source_close (GscClipboardSource *self)
{
  g_return_if_fail (GSC_CLIPBOARD_IS_SOURCE (self));
  g_return_if_fail (self->owner_thread == g_thread_self ());
  if (self->closed)
    return;
  self->closed = TRUE;
  /* Snapshot keys because JS cancellation handlers can resolve other requests. */
  GList *keys = g_hash_table_get_keys (self->pending);
  for (GList *l = keys; l != NULL; l = l->next)
    l->data = g_strdup (l->data);
  for (GList *l = keys; l != NULL; l = l->next)
    complete_request (self, l->data, NULL,
                      g_error_new_literal (G_IO_ERROR, G_IO_ERROR_CANCELLED,
                                           "Clipboard ownership changed"));
  g_list_free_full (keys, g_free);
}

const gchar *
gsc_clipboard_source_get_offer_id (GscClipboardSource *self)
{
  g_return_val_if_fail (GSC_CLIPBOARD_IS_SOURCE (self), NULL);
  return self->offer_id;
}

gboolean
gsc_clipboard_source_get_closed (GscClipboardSource *self)
{
  g_return_val_if_fail (GSC_CLIPBOARD_IS_SOURCE (self), TRUE);
  return self->closed;
}
