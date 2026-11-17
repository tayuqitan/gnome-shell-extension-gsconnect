/* SPDX-FileCopyrightText: 2026 GSConnect fork contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 * TEST-ONLY cancellation-semantics variant. Reviewed and exercised only in isolated tests.
 * No GSConnect daemon, discovery, real pairing, or external interfaces.
 */
#include <gio/gio.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>

#define LIMIT (2U * 1024U * 1024U)

static gboolean
accept_certificate(GTlsConnection *connection, GTlsCertificate *peer,
                   GTlsCertificateFlags errors, gpointer expected)
{
    (void) connection;
    return errors == 0 && g_tls_certificate_is_same(peer, expected);
}

int
main(int argc, char **argv)
{
    if (argc != 7 || strcmp(argv[1], "--isolated-test") != 0 ||
        (strcmp(argv[6], "receive") != 0 && strcmp(argv[6], "controlled-pause") != 0)) {
        fprintf(stderr, "TEST-ONLY: --isolated-test server.pem server.key ca.pem client.pem receive|controlled-pause\n");
        return 2;
    }
    /* Hard per-process ceiling; supervisor owns temporary-file cleanup. */
    alarm(20);
    int status = 1;
    const char *stage = "certificate";
    GError *error = NULL;
    GTlsCertificate *certificate = NULL, *expected = NULL;
    GTlsDatabase *database = NULL;
    GSocketListener *listener = NULL;
    GSocketConnection *raw = NULL;
    GIOStream *tls = NULL;
    GInetAddress *loopback = NULL;
    GSocketAddress *requested = NULL, *effective = NULL;
    GChecksum *checksum = NULL;
    gulong handler = 0;
    certificate = g_tls_certificate_new_from_files(argv[2], argv[3], &error);
    if (!certificate) goto out;
    expected = g_tls_certificate_new_from_file(argv[5], &error);
    if (!expected) goto out;
    database = g_tls_file_database_new(argv[4], &error);
    if (!database) goto out;
    stage = "bind";
    listener = g_socket_listener_new();
    loopback = g_inet_address_new_from_string("127.0.0.1");
    requested = g_inet_socket_address_new(loopback, 0);
    if (!g_socket_listener_add_address(listener, requested, G_SOCKET_TYPE_STREAM,
            G_SOCKET_PROTOCOL_TCP, NULL, &effective, &error)) goto out;
    printf("READY %u\n", g_inet_socket_address_get_port(G_INET_SOCKET_ADDRESS(effective)));
    fflush(stdout);
    stage = "accept";
    raw = g_socket_listener_accept(listener, NULL, NULL, &error);
    if (!raw) goto out;
    g_socket_listener_close(listener);
    GSocket *socket = g_socket_connection_get_socket(raw);
    g_socket_set_timeout(socket, 10);
    if (strcmp(argv[6], "controlled-pause") == 0 &&
        !g_socket_set_option(socket, SOL_SOCKET, SO_RCVBUF, 4096, &error)) goto out;
    stage = "tls-construct";
    tls = g_tls_server_connection_new(G_IO_STREAM(raw), certificate, &error);
    if (!tls) goto out;
    g_tls_connection_set_database(G_TLS_CONNECTION(tls), database);
    g_tls_connection_set_require_close_notify(G_TLS_CONNECTION(tls), TRUE);
    g_object_set(tls, "authentication-mode", G_TLS_AUTHENTICATION_REQUIRED, NULL);
    handler = g_signal_connect(tls, "accept-certificate", G_CALLBACK(accept_certificate), expected);
    stage = "handshake";
    if (!g_tls_connection_handshake(G_TLS_CONNECTION(tls), NULL, &error)) goto out;
    /* Native callback has returned; no JS or live signal disconnection. */
    g_signal_handler_disconnect(tls, handler);
    handler = 0;
    const gboolean controlled_pause = strcmp(argv[6], "controlled-pause") == 0;
    if (controlled_pause) {
        /* Do not consume any application data until the supervisor permits it.
         * The alarm covers a missing/partial command without a GLib main loop.
         */
        stage = "control-command";
        printf("PAUSED\n");
        fflush(stdout);
        char command[8];
        if (!fgets(command, sizeof command, stdin) || strcmp(command, "DRAIN\n") != 0)
            goto out;
    }
    stage = "read";
    checksum = g_checksum_new(G_CHECKSUM_SHA256);
    gsize total = 0;
    guint8 buffer[65536];
    while (TRUE) {
        const gsize requested_bytes = MIN(sizeof buffer, LIMIT - total + 1);
        gssize count = g_input_stream_read(g_io_stream_get_input_stream(tls),
            buffer, requested_bytes, NULL, &error);
        if (count < 0) {
            /* Only authenticated, explicitly released cancellation cases may
             * classify these peer transport terminations as expected. Never
             * accept generic errors, local close/cancellation or timeout.
             */
            const char *reason = NULL;
            if (controlled_pause && g_error_matches(error, G_TLS_ERROR, G_TLS_ERROR_EOF))
                reason = "TLS_EOF";
            else if (controlled_pause &&
                (g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CONNECTION_CLOSED) ||
                 g_error_matches(error, G_IO_ERROR, G_IO_ERROR_BROKEN_PIPE)))
                reason = "CONNECTION_CLOSED";
            if (!reason) goto out;
            printf("CANCEL_RESULT %" G_GSIZE_FORMAT " %s EOF=0 REASON=%s\n",
                total, g_checksum_get_string(checksum), reason);
            fflush(stdout);
            status = 0;
            goto out;
        }
        if (count == 0) {
            if (controlled_pause) {
                stage = "unexpected-clean-eof";
                goto out;
            }
            break;
        }
        if ((gsize) count > LIMIT - total) {
            stage = "payload-limit";
            goto out;
        }
        total += (gsize) count;
        g_checksum_update(checksum, buffer, count);
    }
    stage = "close";
    if (!g_io_stream_close(tls, NULL, &error)) goto out;
    printf("RESULT %" G_GSIZE_FORMAT " %s EOF=1\n", total, g_checksum_get_string(checksum));
    fflush(stdout);
    status = 0;
out:
    if (status != 0)
        fprintf(stderr, "FAIL %s domain=%u code=%d\n", stage,
            error ? error->domain : 0, error ? error->code : 0);
    if (handler) g_signal_handler_disconnect(tls, handler);
    /* No async operations exist in this native process at cleanup. */
    if (raw) g_socket_close(g_socket_connection_get_socket(raw), NULL);
    g_clear_error(&error);
    if (checksum) g_checksum_free(checksum);
    g_clear_object(&tls);
    g_clear_object(&raw);
    if (listener) g_socket_listener_close(listener);
    g_clear_object(&listener);
    g_clear_object(&requested);
    g_clear_object(&effective);
    g_clear_object(&loopback);
    g_clear_object(&database);
    g_clear_object(&expected);
    g_clear_object(&certificate);
    return status;
}
