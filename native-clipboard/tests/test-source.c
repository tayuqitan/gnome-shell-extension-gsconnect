/* SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
 * SPDX-License-Identifier: GPL-2.0-or-later */
#include "gsc-clipboard-source.h"

typedef struct {
  guint requests;
  guint cancellations;
  guint completions;
  GInputStream *stream;
  GError *error;
  gchar *last_id;
  gboolean synchronous_reply;
} State;

static void
on_request (GscClipboardSource *source, const gchar *id,
            const gchar *mime, State *state)
{
  state->requests++;
  g_free (state->last_id);
  state->last_id = g_strdup (id);
  g_assert_cmpstr (mime, ==, "image/png");
  if (state->synchronous_reply) {
    const guint8 data[] = {0, 255, 42};
    GBytes *bytes = g_bytes_new (data, sizeof data);
    g_assert_true (gsc_clipboard_source_resolve (source, id, bytes, NULL));
    g_bytes_unref (bytes);
  }
}

static void
on_cancel (GscClipboardSource *source, const gchar *id, State *state)
{
  (void) source;
  g_assert_nonnull (id);
  state->cancellations++;
}

static void
on_ready (GObject *source, GAsyncResult *result, gpointer user_data)
{
  State *state = user_data;
  state->completions++;
  GError *error = NULL;
  GInputStream *stream = meta_selection_source_read_finish (
      META_SELECTION_SOURCE (source), result, &error);
  g_clear_object (&state->stream);
  g_clear_error (&state->error);
  state->stream = stream;
  state->error = error;
}

static GscClipboardSource *
new_source (State *state)
{
  const gchar *mimes[] = {"image/png", "text/uri-list", NULL};
  GError *error = NULL;
  GscClipboardSource *source = gsc_clipboard_source_new ("offer", mimes, 60, &error);
  g_assert_no_error (error);
  g_assert_nonnull (source);
  g_signal_connect (source, "request", G_CALLBACK (on_request), state);
  g_signal_connect (source, "cancel-requested", G_CALLBACK (on_cancel), state);
  return source;
}

static void
wait_completions (State *state, guint count)
{
  gint64 deadline = g_get_monotonic_time () + 5 * G_TIME_SPAN_SECOND;
  while (state->completions < count && g_get_monotonic_time () < deadline) {
    g_main_context_iteration (NULL, FALSE);
    g_usleep (100);
  }
  g_assert_cmpuint (state->completions, ==, count);
}

static void
clear_state (State *state)
{
  g_clear_object (&state->stream);
  g_clear_error (&state->error);
  g_free (state->last_id);
}

static void
test_sync_binary (void)
{
  State state = {.synchronous_reply = TRUE};
  GscClipboardSource *source = new_source (&state);
  g_assert_cmpstr (gsc_clipboard_source_get_offer_id (source), ==, "offer");
  GList *mimes = meta_selection_source_get_mimetypes (META_SELECTION_SOURCE (source));
  g_assert_cmpuint (g_list_length (mimes), ==, 2);
  g_list_free_full (mimes, g_free);
  meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                     NULL, on_ready, &state);
  wait_completions (&state, 1);
  g_assert_no_error (state.error);
  guint8 data[3];
  g_assert_cmpint (g_input_stream_read (state.stream, data, sizeof data, NULL, NULL), ==, 3);
  const guint8 expected[] = {0, 255, 42};
  g_assert_cmpmem (data, 3, expected, 3);
  g_assert_false (gsc_clipboard_source_resolve (source, state.last_id, NULL, "late"));
  gsc_clipboard_source_close (source);
  g_object_unref (source);
  clear_state (&state);
}

static gpointer
cancel_thread (gpointer data)
{
  g_cancellable_cancel (G_CANCELLABLE (data));
  return NULL;
}

static void
test_thread_cancel_late_resolve (void)
{
  State state = {0};
  GscClipboardSource *source = new_source (&state);
  GCancellable *cancel = g_cancellable_new ();
  meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                     cancel, on_ready, &state);
  GThread *thread = g_thread_new ("cancel-test", cancel_thread, cancel);
  g_thread_join (thread);
  /* Deliberately resolve before processing the queued cancellation idle. */
  GBytes *bytes = g_bytes_new_static ("late", 4);
  gsc_clipboard_source_resolve (source, state.last_id, bytes, NULL);
  g_bytes_unref (bytes);
  wait_completions (&state, 1);
  g_assert_error (state.error, G_IO_ERROR, G_IO_ERROR_CANCELLED);
  g_assert_null (state.stream);
  g_assert_cmpuint (state.cancellations, ==, 1);
  while (g_main_context_iteration (NULL, FALSE)) {}
  g_assert_cmpuint (state.completions, ==, 1);
  gsc_clipboard_source_close (source);
  g_object_unref (cancel);
  g_object_unref (source);
  clear_state (&state);
}

static void
test_bounds_close (void)
{
  State state = {0};
  GscClipboardSource *source = new_source (&state);
  for (guint i = 0; i < 33; i++)
    meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                       NULL, on_ready, &state);
  wait_completions (&state, 1);
  g_assert_error (state.error, G_IO_ERROR, G_IO_ERROR_BUSY);
  g_assert_cmpuint (state.requests, ==, 32);
  gsc_clipboard_source_close (source);
  gsc_clipboard_source_close (source);
  wait_completions (&state, 33);
  g_assert_cmpuint (state.cancellations, ==, 32);
  g_assert_true (gsc_clipboard_source_get_closed (source));
  meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                     NULL, on_ready, &state);
  wait_completions (&state, 34);
  g_assert_error (state.error, G_IO_ERROR, G_IO_ERROR_NOT_FOUND);
  g_object_unref (source);
  clear_state (&state);
}

static void
test_oversize_and_validation (void)
{
  const gchar *types[] = {"image/png", NULL};
  GError *error = NULL;
  g_assert_null (gsc_clipboard_source_new ("id", types, 59, &error));
  g_assert_error (error, G_IO_ERROR, G_IO_ERROR_INVALID_ARGUMENT);
  g_clear_error (&error);
  State state = {0};
  GscClipboardSource *source = new_source (&state);
  meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                     NULL, on_ready, &state);
  GBytes *bytes = g_bytes_new_take (g_malloc0 (16 * 1024 * 1024 + 1), 16 * 1024 * 1024 + 1);
  g_assert_true (gsc_clipboard_source_resolve (source, state.last_id, bytes, NULL));
  g_bytes_unref (bytes);
  wait_completions (&state, 1);
  g_assert_error (state.error, G_IO_ERROR, G_IO_ERROR_INVALID_DATA);
  g_assert_cmpuint (state.cancellations, ==, 1);
  gsc_clipboard_source_close (source);
  g_object_unref (source);
  clear_state (&state);
}

static void
test_precancel (void)
{
  State state = {0};
  GscClipboardSource *source = new_source (&state);
  GCancellable *cancel = g_cancellable_new ();
  g_cancellable_cancel (cancel);
  meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                     cancel, on_ready, &state);
  wait_completions (&state, 1);
  g_assert_error (state.error, G_IO_ERROR, G_IO_ERROR_CANCELLED);
  g_assert_cmpuint (state.requests, ==, 0);
  g_assert_cmpuint (state.cancellations, ==, 0);
  gsc_clipboard_source_close (source);
  g_object_unref (source);
  g_object_unref (cancel);
  clear_state (&state);
}

static void
reentrant_cancel (GscClipboardSource *source, const gchar *id, gpointer data)
{
  (void) data;
  /* The pending entry must already be removed before cancellation is emitted. */
  g_assert_false (gsc_clipboard_source_resolve (source, id, NULL, "duplicate"));
  gsc_clipboard_source_close (source);
}

static void
test_reentrant_cancel (void)
{
  State state = {0};
  GscClipboardSource *source = new_source (&state);
  g_signal_connect (source, "cancel-requested", G_CALLBACK (reentrant_cancel), NULL);
  meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                     NULL, on_ready, &state);
  g_assert_true (gsc_clipboard_source_resolve (source, state.last_id, NULL, "rejected"));
  wait_completions (&state, 1);
  g_assert_error (state.error, G_IO_ERROR, G_IO_ERROR_FAILED);
  g_assert_cmpuint (state.cancellations, ==, 1);
  g_assert_true (gsc_clipboard_source_get_closed (source));
  g_object_unref (source);
  clear_state (&state);
}

static void
weak_finalized (gpointer data, GObject *where_object_was)
{
  (void) where_object_was;
  *((gboolean *) data) = TRUE;
}

static void
test_last_reference_release (void)
{
  State state = {0};
  gboolean finalized = FALSE;
  GscClipboardSource *source = new_source (&state);
  GCancellable *cancel = g_cancellable_new ();
  g_object_weak_ref (G_OBJECT (source), weak_finalized, &finalized);
  meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                     cancel, on_ready, &state);
  /* GTask/timeout keep source alive until cancellation, without a caller ref. */
  g_object_unref (source);
  g_assert_false (finalized);
  g_cancellable_cancel (cancel);
  wait_completions (&state, 1);
  while (g_main_context_iteration (NULL, FALSE)) {}
  g_assert_true (finalized);
  g_object_unref (cancel);
  clear_state (&state);
}

typedef struct {
  GMutex mutex;
  GCond cond;
  gboolean go;
  GCancellable *cancellable;
} Race;

static gpointer
race_cancel (gpointer data)
{
  Race *race = data;
  g_mutex_lock (&race->mutex);
  while (!race->go)
    g_cond_wait (&race->cond, &race->mutex);
  g_mutex_unlock (&race->mutex);
  g_cancellable_cancel (race->cancellable);
  return NULL;
}

static void
test_concurrent_cancel_resolve (void)
{
  for (guint i = 0; i < 200; i++) {
    State state = {0};
    GscClipboardSource *source = new_source (&state);
    Race race = {0};
    g_mutex_init (&race.mutex);
    g_cond_init (&race.cond);
    race.cancellable = g_cancellable_new ();
    meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                       race.cancellable, on_ready, &state);
    GThread *thread = g_thread_new ("race-cancel", race_cancel, &race);
    GBytes *bytes = g_bytes_new_static ("race", 4);
    g_mutex_lock (&race.mutex);
    race.go = TRUE;
    g_cond_signal (&race.cond);
    g_mutex_unlock (&race.mutex);
    gsc_clipboard_source_resolve (source, state.last_id, bytes, NULL);
    g_thread_join (thread);
    g_bytes_unref (bytes);
    wait_completions (&state, 1);
    while (g_main_context_iteration (NULL, FALSE)) {}
    g_assert_cmpuint (state.completions, ==, 1);
    g_assert_cmpuint (state.cancellations, <=, 1);
    /* Cancellation can occur after completion won the race. Both outcomes are
     * legal; duplicate completion, a crash or a hung disconnect is not. */
    if (state.error != NULL)
      g_assert_error (state.error, G_IO_ERROR, G_IO_ERROR_CANCELLED);
    else
      g_assert_nonnull (state.stream);
    gsc_clipboard_source_close (source);
    g_object_unref (source);
    g_object_unref (race.cancellable);
    g_mutex_clear (&race.mutex);
    g_cond_clear (&race.cond);
    clear_state (&state);
  }
}

static void
test_deadline (void)
{
  State state = {0};
  GscClipboardSource *source = new_source (&state); /* Production minimum: 60 s. */
  meta_selection_source_read_async (META_SELECTION_SOURCE (source), "image/png",
                                     NULL, on_ready, &state);
  gint64 deadline = g_get_monotonic_time () + 80 * G_TIME_SPAN_SECOND;
  while (state.completions == 0 && g_get_monotonic_time () < deadline) {
    g_main_context_iteration (NULL, FALSE);
    g_usleep (1000);
  }
  g_assert_cmpuint (state.completions, ==, 1);
  g_assert_error (state.error, G_IO_ERROR, G_IO_ERROR_TIMED_OUT);
  g_assert_cmpuint (state.cancellations, ==, 1);
  g_assert_false (gsc_clipboard_source_resolve (source, state.last_id, NULL, "late"));
  gsc_clipboard_source_close (source);
  g_object_unref (source);
  clear_state (&state);
}

int
main (int argc, char **argv)
{
  g_test_init (&argc, &argv, NULL);
  g_test_add_func ("/clipboard/sync-binary", test_sync_binary);
  g_test_add_func ("/clipboard/thread-cancel-late-resolve", test_thread_cancel_late_resolve);
  g_test_add_func ("/clipboard/bounds-close", test_bounds_close);
  g_test_add_func ("/clipboard/oversize-validation", test_oversize_and_validation);
  g_test_add_func ("/clipboard/precancel", test_precancel);
  g_test_add_func ("/clipboard/reentrant-cancel", test_reentrant_cancel);
  g_test_add_func ("/clipboard/last-reference-release", test_last_reference_release);
  g_test_add_func ("/clipboard/concurrent-cancel-resolve", test_concurrent_cancel_resolve);
  g_test_add_func ("/clipboard/deadline", test_deadline);
  return g_test_run ();
}
