# Rich clipboard transfer resource hardening, 2026-11-17

This is a focused resource-lifetime fix, not a complete security certification or
real-network/two-machine acceptance. The private rich protocol version is unchanged.
No desktop extension, paired-device identity, firewall or SELinux setting was
changed while developing or testing this patch.

## Findings and fixes

1. Eight stalled outbound requests could occupy all sending slots indefinitely.
   Each `serve()` request now starts a total deadline before source preparation,
   using the sending device's `rich-transfer-timeout` setting. Cancellation reaches
   file metadata/open/read, local MIME acquisition and transport work. Slots are
   released only when the pending operation and cleanup settle, not merely when
   the timer fires. Prepared transfers that never start are explicitly abandoned
   after preparation settles, releasing the device's tracked-transfer entry.
2. Payload TLS handshake used only the long-lived channel token. A per-transfer
   timeout could leave the handshake and cache writer pending. Linked cancellables
   now preserve both owner/channel cancellation and transfer cancellation, without
   canceling either parent or retaining cancellation handlers after settlement.
3. Rich uploads now close listeners and drain packet-send/accept branches on failure,
   including a send failure while accept is pending. Cancellation closes the owned
   raw socket; stream cleanup uses a fresh token with a five-second cancellation
   budget, then waits for GIO completion. It never races away from a live writer
   and must not be described as a hard wall-clock guarantee for arbitrary storage.
4. Unknown/stale rich payload rejection previously initiated an unbounded outbound
   connection/handshake. Rich rejection now discards the payload without connecting.
   New sending peers reclaim unaccepted requests using their own deadline. This
   does not retroactively add a deadline to old experimental sending versions.

Legacy KDE Connect transfer/rejection behavior is kept separate. Existing paired
certificate validation remains; this patch does not change the preexisting
certificate-mismatch unpairing policy. Cancellation must exit before that path.

## Verification scope

Regression tests exercise production methods behind mocked sockets/TLS/streams:
concurrency exhaustion/recovery, canceled source preparation, late source results,
channel and transfer cancellation at transport phases, failure while accepting,
large batches of rejected rich payloads, cleanup and transfer tracking.

Real GJS tests use actual Gio.Cancellable, memory streams and a real five-second
GLib timer. The deliberately stalled close adapter is a controlled JavaScript
fixture, not an actual stalled TLS peer. These tests do not prove real kernel/TLS
cancellation timing or compatibility with two physical machines.

The earlier user-run nested Shell/native binary/error/cancel bridge results apply
to that earlier package. New package structure, imports and native loader checks
must be recorded separately; they are not a substitute for running this network
resource patch against real peers in an appropriately isolated environment.

## Final local verification

- Complete Node suite: 184 passed; Python suite: 41 passed.
- ESLint for `src/ installed-tests/`: no errors or warnings.
- Independent review: no remaining blocking finding in the reviewed diff;
  reviewer independently ran 72 focused Node tests and five GJS groups.
- New ZIP passes structural/native-manifest checks, and all five modified
  production source/helper files byte-match the source tree. No Python caches
  are included. Strict schema compilation and three Meson data tests pass.
- Actual packaged native loader/source construction and native GJS smoke pass
  using system Mutter plus libraries from the extracted ZIP, not build-library
  paths. Native bridge code itself is unchanged.

Earlier resource-hardening ZIP SHA256 (superseded by the integrity fix below;
do not install this earlier package):
`242e042da8308e649c4e151ef1238fae4610469acb633bb4dbc947764f8ddfa3`

At the package checkpoint above, no new installed-extension activation, real
network/TLS stall, full preferences UI or dual-machine test was performed. The
package was not installed.


## Additional real loopback cancellation check

`gjs -m installed-tests/gjs/testTransferSocketCancellation.js` passes five
real GIO operations: pending accept, pending socket read, TLS client handshake
against a silent peer, and blocked socket write_bytes/splice. A real parent Gio.Cancellable cancels the production linked
token after 200 ms; each operation settles with G_IO_ERROR_CANCELLED. Cleanup uses
the production helpers and verifies that all owned sockets are closed.

The test binds only IPv4 127.0.0.1 with an OS-selected port, disables proxy use,
and connects only to its own listener. Failure stops the test; there is no
elevated retry or network-namespace workaround. A 12-second process watchdog
limits a hung test. No certificates, paired-device records, desktop clipboard,
GSConnect daemon, installation or system settings are accessed or changed.

This is a real local TCP/TLS cancellation check, not a completed TLS handshake,
TLS server-side validation, authenticated transfer, production LAN-method
integration, encrypted TLS output backpressure, eight-peer load test, or
two-machine acceptance. The mocked production-method regression remains complementary, not
interchangeable. This test/doc-only follow-up does not change the packaged
production code or that historical ZIP hash. The later integrity fix below
does change production code and has a new package hash.


The write_bytes/splice cases use separate self-owned loopback pairs and a fixed
2 MiB zero-filled payload per case. Linux socket send/receive buffers are set to
4 KiB only on those sockets; the peer never consumes the payload. The write
case sends at most 2 MiB through sequential write_bytes calls of at most 64 KiB;
splice uses CLOSE_SOURCE | CLOSE_TARGET, matching the production flag choice. Before
canceling at 200 ms, the test checks that the sender socket is not writable and
that the operation has not completed and the peer is readable, then requires
G_IO_ERROR_CANCELLED. This
provides real TCP backpressure evidence rather than merely canceling an already
finished write. Each pair is closed after the operation settles; all remaining
owned streams are also reclaimed by the outer cleanup. Socket-buffer constants
are Linux-specific. No user files or arbitrary-size output are involved.

A direct callback-style write_all_async probe on this GJS installation returned
`Error sending data: Bad address` before reaching the intended blocked state; it
is not counted as a passing write_all test. The passing bounded write_bytes loop
must not be substituted as evidence for production write_all_async behavior.
The cause of that probe failure and its relevance to production's promisified
write_all path remain unverified; no production change was made on that basis.

## File write integrity finding and targeted correction

The later isolated `testWriteAllBoundaries.js --legacy-probe` reproduced output
corruption on this machine, not merely the original socket error. Its actual
production-shaped case uses `copyExact`, real asynchronous memory-input reads
returning `GLib.Bytes.get_data()` arrays of at most 64 KiB, and the same
`Gio._promisify(..., 'write_all_async')` registration as service/init.js. Writing
2 MiB to a PRIVATE file in a new 0700 temporary directory produced incorrect
bytes when read back after close. Both the original input and every retained
chunk matched an independent deterministic formula; the output did not.

The developer and independent reviewer reproduced this. The callback-after-wrap
64 KiB file case also failed; other memory/file cases passed in those runs.
These observations do not establish the exact GJS/native-marshalling root cause
or show that all write_all users fail. The legacy diagnostic deliberately exits
nonzero on corruption; it is not reported as an expected successful test.

Rich download now uses `writeBytes`, which owns native storage through GLib.Bytes
and performs sequential `write_bytes_async` calls. It checks every partial-write
count, rejects zero/negative/non-integer/oversize counts, forwards cancellation,
and retains native storage until each completion. Only rich payload writes are
changed; legacy packet/identity write paths are not silently broadened by this
fix. No formal installation or pairing data was changed.

The default GJS test validates the corrected helper and copyExact path against
real memory and PRIVATE temporary-file outputs, comparing every output byte to
an independent formula. Node fixtures separately exercise partial counts and
cancellation boundaries; they must not be described as real disk partial-write
or kernel-cancellation evidence. Full network/desktop acceptance remains open.


### Integrity-fix verification and current package

- Complete Node suite: 196 passed; Python suite: 41 passed; full src/installed-tests
  ESLint clean. Default real GJS write-integrity suite: 8 passed.
- Real loopback cancellation/backpressure suite: 5 passed, all owned sockets
  reclaimed. Independent reviewer additionally ran the 8 real integrity cases
  and 47 focused Node cases; no blocking issue found in the reviewed patch.
- The new ZIP contains byte-identical revised LAN code and writeBytes helper,
  passes native manifest checks, excludes Python caches, and passes strict
  schemas, three Meson data checks, packaged native loader and native GJS smoke.
- This is not a new installed Shell/native bridge or two-machine acceptance.
  No package was installed. Other legacy write_all call sites remain unchanged.

Current integrity-fixed ZIP SHA256:
`d445fa3927ec9c43562d2f4cd1d8174634273ed7aa41f0906971dee0b05182cb`

### Packaged helper and extracted download-method follow-up

The integrity-fixed ZIP was checked again in an independent 0700 layout, using
helpers extracted directly from the archive rather than imports from the source
checkout. All eight real memory/private-file integrity and pre-cancellation
cases passed, and the temporary layout was removed.

`testPackagedRichDownload.js VERIFIED_PACKAGE_DIRECTORY` validates fixed SHA256
hashes for the packaged LAN file and its three helper modules, then extracts the
unchanged download method using unique source boundaries. It deliberately does
not import the complete LAN module or service initialization, which would pull
in Device, plugins and other desktop/service dependencies. The actual packaged
helper modules are imported, not replaced by mock writes or mock storage.

The local peer listens only on 127.0.0.1 with an OS-assigned port. The method uses
its normal SocketClient with proxies disabled; outputs are PRIVATE files in a
new 0700 directory. Cases cover 2 MiB byte-for-byte success, zero bytes, truncated
and extra data, stalled transfer-token cancellation, channel-token cancellation,
and pre-cancellation. They check target/connection closure and settled file
content. All seven cases passed; all three cancellation cases reported native
G_IO_ERROR_CANCELLED. Per-case and process watchdogs bound a stuck test; only
test-owned resources are cleaned up.

Important: `_encryptClient` is a plaintext passthrough test adapter in this
harness. These results cover the original packaged download method's TCP,
length checking, new write helper and cleanup, **not TLS authentication, complete
LAN initialization, pair management, cache-transaction integration, preferences
GUI or two-machine clipboard behavior**. No real GSConnect service is launched.

### Unstable packet-TLS diagnostic: disabled by default

`testPackagedPacketTls.js` is an unfinished diagnostic, **not a passing test or
an installation recommendation**. It refuses to run without an explicit unstable
opt-in flag. Do not opt in until its fixture/runtime problem has been repaired
and independently reviewed. The earlier passing packet tests over plaintext TCP
do not prove TLS behavior; packet-to-file anomalies do not prove socket damage.

The diagnostic extracts the original packaged Packet.serialize/sendPacket and
uses synthetic data with temporary test-only CA/server/client certificates. The
fixture initially omitted the GIO server-side application authorization callback;
GIO requires that callback to accept a client even after CA verification. This
explains the server rejection in that version, not the later runtime crash.

Offline GnuTLS verify_chain returned no errors for the test server/client chains;
adding the CA as an issuer did not alter that result. A wrong-IP negative control
returned BAD_IDENTITY. Incorrect-purpose checks also returned no errors in this
API, so those results are not presented as proof of EKU enforcement. OpenSSL
performed its separate explicit purpose checks. System trust was never changed.

After static review of a server-only callback requiring zero validation errors
and the exact expected test client certificate, one bounded network run passed
the small-packet expected-length prefix check, then hit a GJS `too much recursion`
error during the Unicode case's authentication and exited with segmentation
fault status 139. Remaining cases were not executed. The log contains no useful
recursion stack. This does not establish a production packet-writing defect;
earlier Unicode mismatch observations from unstable fixtures are not accepted
as evidence. No further TLS run was performed after that crash.

The test-owned certificate directory was removed; no test GJS/OpenSSL process or
repository-local core file remained in the follow-up inspection. No core dump or
private-key contents were inspected. Static lifecycle improvements and an opt-in
guard do not count as a demonstrated fix for the runtime crash. Production code
and the integrity-fixed package are unchanged by this diagnostic.

### Authentication side effects without TLS or real pairing

`installed-tests/node/testAuthenticationSideEffects.mjs` extracts the unchanged
production authentication method and cancellation helper into a VM containing
only mocked settings, device and handshake objects. Its 24 cases cover both
existing-device and settings-factory branches, transfer/channel cancellation
before or during a pending handshake, cancellation despite a late successful
handshake, matching/empty/mismatching certificate states, parse/comparison
errors, and handshake failures. Canceled authentication never reaches settings
reads/construction, certificate parsing, unpair or resets. This is simulated I/O,
not new TLS acceptance evidence.

`installed-tests/gjs/testAuthenticationSettings.js ABSOLUTE_PACKAGE_DIRECTORY`
adds eight real-GJS cases using real Gio.Cancellable and explicitly constructed
Gio memory-settings backends. Every Settings.new_full receives that backend;
the schema source is the supplied package directory, with no system fallback.
The production method text and real cancellation helper run against simulated
handshake/certificate adapters. Separate random paths and a neighboring sentinel
prove that resets remain confined to the intended memory settings.

Cancellation leaves those memory values intact with no authentication-side
settings access. A simulated mismatch in the no-device branch performs the
actual two memory-settings resets; the existing-device branch only records a
fake unpair call and does not claim to perform real unpairing. The preexisting
certificate-mismatch policy is deliberately unchanged. There are no native TLS
handshakes, certificates, default dconf access, real devices, network operations
or production configuration changes in these tests. The unstable TLS diagnostic
remains disabled and was not rerun.

### Separate native-server fixture and its limited result

A separate C/GIO server fixture was introduced to remove the GJS server-side
certificate signal from the test. It uses only loopback, a dedicated test CA,
REQUIRED client authentication with zero certificate errors and an exact client
certificate match. The GJS client retains the extracted original packet methods
and normal server verification. Each case has separate child processes, private
temporary credentials, bounded lifetimes and supervised cleanup.

Unlike the earlier prefix-only diagnostic, the native receiver requires TLS
close-notify, reads until actual EOF, rejects more than 2 MiB (with a bounded
one-extra-byte check), and reports total length and SHA256. The supervisor
requires both process exits to be zero, no diagnostic stderr, and exact
EXPECT/RESULT length/hash/EOF agreement. Normal small, Unicode and large cases
were prepared; cancellation/backpressure was not part of this run. The C
helper's reserved `silent` mode only pauses two seconds and is not proof of
sustained backpressure.

After independent static review, one authorized fail-fast run passed small and
Unicode packets with the complete length/hash/EOF checks. The approximately
2 MiB synthetic large-packet case then failed: GJS client exit -11 (SIGSEGV),
native server exit 1, and no valid EXPECT or RESULT. The supervisor stopped,
reaped its children and removed its temporary credential directories. No core
or private-key contents were inspected, and the crash was not retried.

This isolates away the GJS server callback but does not identify the crash site
or prove a string-buffer root cause. The failing case has no stack or phase
markers sufficient to prove that sendPacket/write_all was reached. Legacy text
clipboard sends the full content inside JSON without a size cap in the audited
component/plugin/device/channel chain, so similarly large control packets can
be relevant. Rich file/image data instead uses separate payload streams; a
large JSON test must not be equated with a large rich file transfer.

The new runner and client remain explicitly opt-in and marked unvalidated with
the large-packet crash warning. They are not default passing tests and must not
be rerun without a separately reviewed plan. Production code and the released
integrity-fixed ZIP have not been changed on the basis of this observation.

### Offline single-splice packet candidate (not production)

A test-only candidate in `installed-tests/fixtures/packetSpliceCandidate.js`
serializes once, copies UTF-8 into owned GLib.Bytes, and submits one native
output splice from a memory input. It closes only its own source after native
completion, keeps the channel output open, uses the explicit or channel token,
and preserves GIO's concurrent-operation PENDING rejection instead of adding a
queue. Its success shape is `[byteCount]`, matching the local GJS promisified
write_all result. Invalid completion counts reject with a GIO error.

The 19 mocked Node cases cover serialization, UTF-8 byte counts, ownership,
partial/invalid counts, submission/finish/cleanup failures, cancellation and
pending-operation recovery. Nineteen real GJS cases use only memory outputs
and private temporary files: empty/ASCII/Unicode/2 MiB full readback, explicit
and default pre-cancellation, concurrent PENDING, closed-output failure and
fresh-output recovery, and ordered ASCII/Unicode concatenation. One case uses
the unchanged production Packet.serialize method text to check its timestamp,
Unicode JSON and final newline without importing Core or invoking sendPacket.

These are feasibility checks, not a production repair or a TLS-crash diagnosis.
The candidate is not wired into Core.sendPacket or LAN identity writes; no
installed extension, real pairing, TLS, network or old write_all path was used.
Real mid-operation cancellation, authenticated TLS, socket backpressure and
integration with all direct channel callers remain unverified. Passing memory
and file checks does not prove that this candidate fixes the earlier crash or
that legacy packet behavior is fully compatible. Production integration needs
its own review and bounded verification plan.
