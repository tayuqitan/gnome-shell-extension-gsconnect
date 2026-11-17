# Byte-history persistence checkpoint, 2026-11-17

This is a development checkpoint, not desktop/two-machine acceptance. The
feature/rich-clipboard-integrated branch adds **opt-in, plaintext byte snapshot
persistence**, default off. It does not enable the setting on anyone's desktop.

## Scope and privacy

Only already-cached ordinary MIME bytes, direction, peer label and timestamp
are saved. File/URI offers, source paths/handles, uncached remote entries and
old network leases are excluded. Restored entries cannot serve old remote
lease requests; they restore cached bytes locally, including while offline.

Existing session limits remain in effect. Additional persistence limits are
8 MiB total payload and 16 MiB JSON per paired device, selecting the newest
complete eligible entries. This is intentionally not full persistence of the
configured 1 GiB maximum session history. Unmarked text passwords cannot be
recognized: the opt-in control explicitly warns that storage is plaintext.

Dedicated user-data directories are private; snapshots use private atomic
replacement, no backup, bounded reads through EOF, ownership/type checks and
no symlink traversal. These checks do not claim isolation against another
malicious process with the same Unix identity. Disabling while running attempts
to remove the snapshot; deletion is not secure erasure. Failures are surfaced
without printing clipboard data. Externally disabling while the service is
stopped does not itself remove a preexisting file on the next zero-I/O startup.

Clear emits one change notification even for 1000 entries; the Clear button
retries a failed removal when memory is already empty. Shutdown unsubscribes
before clearing session memory. Corrupt input is validated completely before
any history entries are merged and is not silently overwritten after a load
failure.

## Verified against this checkpoint

- Complete Node suite: 131 tests pass, none skipped. Includes codec bounds,
  malformed records, exclusion rules, lifecycle, short GIO reads, mocked GTK
  opt-in/clear controls and offline restoration without old network requests.
- ESLint `src/ installed-tests/`: zero errors and zero warnings. Dependencies
  were installed in a separate validation tools directory from npm's official
  registry; application package files were not changed. Node fixture globals
  are scoped only to Node tests.
- Real GJS history-storage test: default-off no writes, private file permissions,
  save/restart/restore, clearing, and refusal to read/write/delete symlink targets.
- Existing real GJS cache-storage test remains passing.
- 36 Python native-package/archive tests, three Meson data checks and full ZIP
  structural/hash validation passed during integration; native source is unchanged
  from the previously passing five native/GJS suites.

## Still not established

No replacement of the normal desktop extension, host Shell restart or pairing
change was performed. A subsequent user-run **nested Shell-only** check is
recorded below. Actual service startup, rendered preferences/history dialog UX,
two-machine TLS transfer and Ctrl+V behavior remain unverified. The executor
cannot directly connect to the desktop display/session sockets. Mocked GTK tests
are not screenshots or application acceptance.

The earlier functional limits remain: ordinary MIME transfer is capped at
16 MiB per representation; folders, symlinks and non-local URIs are unsupported.
The experimental Ctrl+V gate defaults off, is not a reliable reader-identity
security boundary, and does not prove every application waits for large files.
File histories do not persist across service restart. Do not describe this as
universal clipboard or full persistent history compatibility.

## Subsequent user-run nested Shell check

On the same RHEL machine, a user-run temporary HOME/XDG/private-D-Bus session
loaded the package with SHA256
`bc244b602fefbc6a0c61130138f97f85b0cf6fe3707b01c28bb4fd01baf6db49`.
The temporary daemon entry point was intentionally replaced by an exit-77 stub;
no real GSConnect networking or pairing was exercised.

The supplied complete log contains twelve samples with `state=1` (ACTIVE),
`enabled=true`, empty `error` and empty `GetExtensionErrors` arrays. Each sample
identifies the temporary extension path. GNOME Shell ran until the configured
180-second timeout (exit 124). This establishes extension activation in a nested
Shell, not full product acceptance. The safety stub's exit 77 explains why
Mobile Settings cannot open in this test; it is not a preferences pass/fail.

Two initial harness mistakes were corrected before that result: Mutter 49.4's
legacy `--nested` backend needs the parent Xwayland `DISPLAY` and `XAUTHORITY`
even with `--wayland --no-x11`; direct Shell extension queries use destination
`org.gnome.Shell` and object `/org/gnome/Shell`, not `/org/gnome/Shell/Extensions`.
Only existing local display/authority paths are forwarded; no authentication
cookies are copied or logged and no `xhost` settings are changed.

The clipboard portal is created when the service bus name appears. Since the
real service was blocked, ACTIVE alone does not establish the native source's
asynchronous selection read/resolve path. A private-bus simulated service test
was the next separate checkpoint; its later result is recorded below. Temporary HOME/XDG and a private bus provide
configuration separation, not a security sandbox against the same Unix user
or complete separation from host display/system services.

## Private-bus bridge fixture preparation

The repository now includes a guarded GJS simulated-service client and manual
runner. Preparation checks passed: 131 Node tests, 41 Python tests (including
five new runner syntax/safety regressions), ESLint for `src/ installed-tests/`,
and real GJS binary-variant/remote-error API probes. The no-argument client
rejects execution before opening a bus. These are offline/guard/API checks,
not by themselves proof of a live Shell bridge run. The subsequent result is
recorded below.

## Subsequent user-run native bridge check

The user then ran the guarded `--bridge` fixture on the same RHEL/GNOME desktop.
The supplied complete log reports all three tests passing: fixed binary byte
roundtrip, explicit Resolve error, and cancellation of a pending native request
by ClearOffer. Client and outer runner exit codes are both 0. Extension state
before and after is ACTIVE, with empty error fields and error lists.

This exercises the actual nested Shell portal and packaged native asynchronous
source, while a simulated private-bus name replaces the real network daemon.
The logged missing GetManagedObjects object is expected from this minimal
simulated service, not a clipboard transfer failure. No real pairing, LAN
transfer, preferences window, application Ctrl+V, file/progress or two-machine
acceptance is implied. The rapid fixture does not exercise the 60-second native
deadline. Test records contain no copied user clipboard content.

A later service-free bubblewrap network-namespace preflight failed with
`Failed to create NETLINK_ROUTE socket: Operation not permitted`. It was stopped
without escalation or changed security settings. The real-service/no-network
stage therefore remains blocked; the successful bridge result does not remove
that requirement.

## Offline settings UI logic checks

Added 22 in-memory mock tests: 15 for the production preferences service window
and seven additional history-dialog cases. They execute production class methods
with GTK/Gio/service boundaries replaced, rather than opening a real window or
activating the daemon. No real settings, pairing, clipboard or network is used.

Coverage includes service availability/reload failure, late reload rejection
after closing, refresh eligibility, display/name settings, device list changes,
closing and reopening, geometry, About dialog reuse, connect-dialog cancel/empty
input/error, support-log cancellation, OpenSSL retry sequencing, history limits,
persistence failure status, subscription cleanup, stale records and pending
restore callbacks across close/redraw. The existing OpenSSL retry remains a
service-restart request that may complete after its preferences window closes;
this test work does not silently change that behavior.

The aggregate checkpoint is 153 Node tests and 41 Python tests passing, with
ESLint for `src/ installed-tests/` reporting no errors or warnings. Both new mock
test areas received independent read-only review. This does not verify GTK
rendering/templates, real property bindings or signal lifecycle, device settings
panels, real D-Bus, actual timer scheduling, successful support-log generation,
or persisted setting changes. No new graphical run is required for these tests.
