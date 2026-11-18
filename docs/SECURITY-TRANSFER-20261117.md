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

### Candidate-only plain TCP loopback follow-up

After independent static review, one authorized run of
`gjs -m installed-tests/gjs/testPacketSpliceLoopback.js --run-reviewed-loopback-candidate`
passed all five cases. It binds only IPv4 127.0.0.1 with an OS-assigned port and
uses proxy-disabled clients. Small (18 bytes), Unicode (26,624 bytes), large
(2,097,152 bytes) and concurrent-send cases verified the complete expected
length, every byte, SHA256 and actual TCP EOF after sender write-half shutdown.
The concurrent case additionally required the second call to reject with
native PENDING and the first 2 MiB packet to arrive intact, without extra data.

The fifth case used only its own socket buffer options and a silent receiver.
At 200 ms it required an unsettled candidate operation, a non-writable sender
and readable receiver before canceling. The operation rejected with native
CANCELLED. Only after its completion did the test half-close and drain the
partial transfer through EOF; this run received 16,384 bytes matching the
expected prefix and its hash. This is cancellation evidence, not a successful
complete transfer or a guaranteed fixed partial length on other systems.

The receiver has a 2 MiB budget plus a one-extra-byte rejection check. Started
native operations are observed immediately and drained during cleanup; owned
sockets are closed again after late callbacks and verified closed. Per-case
cancellation and a 15-second process watchdog bound failure handling. The test
retains an explicit opt-in and three static contract checks. It does not use
TLS, original write_all, actual Core.sendPacket, real services or paired data.
These results strengthen this candidate's plain-TCP feasibility only: they do
not locate or fix the prior TLS crash and do not authorize production wiring.

### Candidate-only strict-auth native TLS follow-up

A separate client and supervisor (`testPacketSpliceTlsNativeClient.js` and
`runPacketSpliceTlsNative.py`) select only the test candidate. They reuse the
reviewed C peer but never invoke either older writer diagnostic. The client
extracts only Packet.serialize from the hash-checked package and sends through
the candidate's owned-bytes single splice. Production Core/LAN remain unchanged.

After independent static review, one authorized fail-fast run passed all three
cases: small, Unicode and approximately 2 MiB JSON. The supervisor required the
ordered CONNECT_START, CONNECTED, TLS_VERIFIED, WRITE_START, WRITE_SETTLED,
CLOSE_START and CLOSED stages, then exact EXPECT/RESULT length and SHA256 plus
actual native-peer TLS EOF with close-notify. Both processes exited zero with
no stderr. Authentication still uses a disposable private CA, distinct
role-constrained leaves, normal client verification and an exact server leaf
match; the native peer requires client authentication with zero certificate
errors and an exact client leaf match. No system trust or pairing data changes.

Each case retains private temporary credentials, owned process groups, timeout
and watchdog cleanup. Failure reporting exposes only recognized stage enums
and status metadata. A last observed stage is not proof that a later stage
was never entered, particularly if a process crashes before output is flushed.
Three static contract checks cover entry-point isolation, authentication,
protocol matching and bounded stage reporting. The runner remains opt-in.

This establishes the candidate's feasibility for these isolated TLS transfers,
not the cause or definitive repair of the earlier crash. It does not validate
TLS cancellation/backpressure/concurrency, production sendPacket integration,
LAN identity negotiation, legacy plugin compatibility or two-machine use.
The original unstable diagnostics remain disabled and were not rerun.

### Candidate-only authenticated TLS semantics

A separate semantics client, supervisor and C peer leave the previous fixtures
unchanged. After independent static review, one fail-fast run passed all four
cases under the same dedicated-CA, required-client-auth and exact-leaf policy:

- Concurrent submission: the second operation returned native PENDING while
  the first approximately 2 MiB packet reached exact length/hash and TLS EOF.
- Pre-cancellation: native CANCELLED after authentication, with zero application
  bytes at the peer and a clean TLS EOF.
- Already-closed output: native CLOSED, caller token unchanged, zero application
  bytes and clean TLS EOF.
- Blocked cancellation: the authenticated C peer emitted PAUSED and waited for
  a supervisor DRAIN command without reading application data. Only then did
  the supervisor permit the client to write. At 200 ms the client required an
  unsettled candidate and non-writable raw socket before canceling. The native
  write settled with CANCELLED before the client force-closed its own socket.
  The supervisor released peer reads only after verifying the completed client
  cancellation protocol. The peer reported a permitted transport truncation,
  and the received nonempty, shorter-than-full prefix matched the expected
  bytes' SHA256. This result is explicitly EOF=0, not a complete TLS transfer.

The cancellation result accepts only TLS_EOF or CONNECTION_CLOSED, not generic
errors, timeout, local cancellation or a clean EOF. A private 0600 expected-data
file contains only generated fixture bytes, is bounded by 2 MiB, and is removed
with its 0700 case directory. Child processes, sockets and pending callbacks
are cleaned up with the same timeout/watchdog safeguards. GO control bytes are
copied into owned Uint8Array storage before crossing the Promise boundary.
Three offline parser/static tests reject incorrect EOF, truncation reasons and
prefix hashes. No real services, existing certificates, pairing data or installed code
were used or changed; all certificates here were disposable fixture material.

These results support candidate semantics on this local GIO/TLS stack only.
Integrating into Core.sendPacket would affect every control-packet caller,
including the device output queue and direct LAN callers, not just clipboard.
Such integration must preserve UTF-8/newline serialization, explicit/default
cancellation, GIO error matching, output ownership and native pending behavior.
LAN's initial plaintext identity write is a separate path and is not covered
by this candidate integration. No production integration has been made, and
the earlier crash's root cause remains undetermined.

### Minimal production Core packet writer integration

Core.sendPacket now delegates to `service/utils/packetBytes.js`, the reviewed
single-splice owned-byte implementation. Its test-candidate entry point is an
alias to the production helper, preventing behavioral drift. Serialization
still occurs once; success remains the local GJS-compatible `[byteCount]`;
explicit/default cancellation and native PENDING are preserved. Only the owned
memory source is closed. Invalid completion counts are GIO PARTIAL_INPUT errors.
No Device queue, LAN plaintext identity or other output path was modified.

Caller regression extracts the actual Device/Core/Packet methods, the LAN
identity-exchange method and production helper with mocked GIO boundaries.
Eight cases pass, covering FIFO/queued-caller early return, GIO cancellation and
failure unlock/next-call resumption, count-error matching and direct callers.
LAN upload Promise.all relationships and unchanged plaintext identity writing
are static contracts, not execution of full upload methods. One explicit TODO
reproduces an existing unfixed issue: a normal JavaScript Error in Device's
catch hits its unguarded `e.matches`, leaving the queue lock set. This TODO is
not a passing test. A separate fix should guard error matching and guarantee
unlock in finally; remaining queued-packet retry policy requires its own review.

A newly built, uninstalled ZIP includes the production helper through Meson's
existing source-directory installation rule. Its SHA256 is:
`ddca70b4991a86d9bb527577dfee703137ad0c5c53055976c151c3ffc5187570`.
The new `testPackagedPacketWriter.js` first compares packaged Core/helper hashes
with the checkout, then executes the extracted packaged Core method and imports
the packaged helper against real memory/private-file streams. All nineteen
cases pass, including exact 2 MiB readback, cancellation, PENDING, source cleanup,
closed-output recovery, sequence ordering and packaged Packet serialization.
Its first harness draft mixed top-level await with a nested MainLoop and hit
the watchdog; using top-level await consistently resolved that harness issue.
This was not a demonstrated production writer failure.

ZIP/native manifest checks, source equality, no Python-cache leakage, strict
schema compilation, native loader/smoke and three Meson data checks pass.
The first standalone native invocation lacked the Meta typelib search path;
with the actual /usr/lib64/mutter-17 path explicitly supplied, loader and smoke
both passed. Independent review reran the packaged nineteen cases successfully. This
is not full Core object initialization, a new-package TLS run, desktop or
paired-device acceptance. Earlier candidate TLS evidence remains distinct.
No extension was installed and no real pairings were accessed. The earlier
crash's root cause remains undetermined; this change is not claimed to identify it.

### Separate Device error-unlock fix

The previously recorded TODO was reproduced before this separate change and
is now a real passing regression, not removed or hidden. Device.sendPacket
tracks whether this invocation acquired the output lock and releases it in
finally only for that owner. Concurrent callers that merely enqueue and return,
or fail before acquiring ownership, cannot unlock another active sender.
Error matching tolerates ordinary JavaScript errors, null/undefined/string
throws and foreign throwing matches getters/methods. Native CANCELLED remains
quiet; other errors still reach the existing logger. If the logger itself
throws, that rejection propagates but finally still releases the owned lock.

The existing queue policy is intentionally unchanged: a failed packet has
already been shifted and is not automatically replayed; the remaining FIFO
waits for a later send call. Queued concurrent callers still return before
their packet is delivered. This is lock safety, not delivery acknowledgment,
retry redesign or a guarantee of reliable remote delivery.

Seventeen focused caller cases pass, independently rerun, with no TODOs left
in that suite. Aggregate Node tests are 256/256 with zero TODO; Python checks
are 54/54 and ESLint passes. The new uninstalled ZIP SHA256 is:
`f3cf22d2f8e9af39b68e4cae910edb2d1a011631d9564fc4b28b82c2bc321fe5`.
ZIP/native-manifest and source equality checks include Device, Core, helper and
unchanged LAN. Packaged Core memory/private-file nineteen cases, strict schema
compilation and packaged native loader/smoke pass again. The actual Device
method is tested with mocked GIO boundaries, not a real connected Device or
full service initialization. There is no new network, desktop or paired-device
acceptance, and no formal installation was changed.

### Latest ZIP Core-method transport verification

This follow-up tests actual methods from ZIP `f3cf22d2...bc321fe5`, not the
checkout candidate alias. Each new Python entry point verifies the full archive
SHA256 and compares the extracted Core/helper bytes with the ZIP members before
launch. The shared GJS adapter independently pins both module hashes, extracts
only unchanged Core.sendPacket and Packet.serialize, and imports the packaged
packetBytes helper. Every send, including the overlapping second send, goes
through that extracted Core method with a real serialized Packet. It does not
import or initialize the complete Core class, Device, backend or daemon.

After independent static review, one fail-fast execution passed all twelve:

- Plain TCP, five cases: small, Unicode, approximately 2 MiB, second-send PENDING
  with first packet intact, and blocked native cancellation. Complete cases
  matched length/every byte/SHA256 through actual EOF. The canceled case drained
  16,384 correct prefix bytes to TCP EOF, not a successful full packet.
- Strict-auth native-peer TLS, three cases: small, Unicode and approximately
  2 MiB, all with complete EXPECT/RESULT length/hash and real close-notify EOF.
- TLS semantics, four cases: concurrent PENDING with intact first packet,
  pre-canceled CANCELLED and closed-output CLOSED with zero-byte clean EOF,
  and the authenticated PAUSED/GO/DRAIN blocked-cancel protocol. The last case
  verified native CANCELLED and the permitted truncated prefix/hash with EOF=0;
  it is not a complete TLS transfer.

These new entry points retain dedicated disposable CA/leaf authentication,
loopback-only endpoints, bounded payloads, explicit opt-in, process watchdogs
and owned-resource cleanup. No fixture credential directories or owned child
processes remained. Three additional offline contract tests verify method-path
and hash gates. This upgrades transport evidence for this package's extracted
Core methods/helpers only. Full service startup, Device integration with real
peers, plaintext identity negotiation, desktop and two-machine acceptance are
still untested. No formal extension was installed and no pairings were touched.

## 2026-11-18: joined gate and portal component contract

Added nine Node cases in `testClipboardPortal.mjs` that load the actual
`clipboardPasteGate.js` and `clipboard.js` together. Only desktop APIs, the
native source adapter, selection ownership and the monotonic clock are synthetic;
no real keyboard input, clipboard, D-Bus connection or network is involved.
The cases cover pre-read rejection without `ValueRequested`, both file MIME
formats, the exact one-second expiry boundary, repeat paste, replacement with a
reused offer ID, focus/Shell-focus/lock/owner/disable revocation and shortcut
conflict. A separate case deliberately verifies that two distinct request IDs
can both pass within the shared window: this gate does not authenticate readers.

Host Node regression: 206 tests passed, zero failed/skipped. These component
results do not prove real Mutter keybinding propagation, GNOME application paste,
clipboard-manager behavior, or the user's strict Ctrl+V trigger requirement.
The experimental setting and production code are unchanged.

### Read-time lease revocation hardening (2026-11-18)

A denied `allows()` observation now permanently revokes the current experimental
file-read lease. Returning to the previous focus, source or NORMAL session state
cannot revive that lease without another qualifying gesture. Read-time API errors
also fail closed, and a failed window-signal disconnect cannot retain authorization.
Joined gate/portal tests verify immediate file-request rejection, recovery through
a fresh gesture and unchanged image requests. The complete Node suite passes 214 tests.

This hardening does not authenticate clipboard readers, observe every unreported
state transition, or cancel transfers already authorized before revocation. It does
not change the one-second shared window or provide strict Ctrl+V-only guarantees.
Real desktop delivery and application compatibility still require GUI validation.

### Explicit file receiving replaces keyboard gating (2026-11-18)

Production file offers now retain metadata without publishing a lazy network-backed
URI source. Only the notification/history action labeled “接收并准备粘贴” authorizes
receiving, bound to an immutable offer snapshot and a local action token. File
request primitives also check that explicit authorization is still current. All
files must finish validation and cache commit before a local-only URI provider is
published. Non-file lazy transfer behavior is unchanged. The legacy experimental
setting remains schema-compatible but production no longer grabs Ctrl+V.

Cancellation, disconnect, offer/history replacement, permission revocation and
shared clipboard generation changes block pending publication. Shell ownership is
verified after publication rather than treating our own OwnerChange as a foreign
copy. Versioned requests reject changed sender offers. Repeated actions coalesce;
a whole-action deadline cancels pending file transfers. Notification failures do
not create authorization or prevent transaction cleanup.

Cancellation cannot interrupt a publication/ownership-check D-Bus call already in
flight: unique-ID cleanup follows its return or its existing timeout, and cleanup
failure is logged. Completed cache data remains accounted, not securely erased.
This is a control-flow guarantee against background file-prefetch downloads, not
malicious same-UID isolation, peer trust proof, or real desktop/two-host validation.

Validation: 308 synthetic Node tests pass (31 explicit-receive cases), the actual
clipboard component's mock D-Bus contract passes, 57 Python tests pass, changed
production/UI tests pass ESLint, schema strict dry-run and Meson compile pass.
No live clipboard, discovery service or network-transfer test was run for this change.

### RHEL 10.2 non-network package verification (2026-11-18)

Both test VMs passed the eight scenarios in
`installed-tests/gjs/testExplicitFileReceive.js` using their actual GJS/Gio/GLib
and the production rich-clipboard/history/cache modules from the built ZIP.
Transport, desktop ownership and notification delivery were synthetic. The cases
cover metadata/history/unauthorized reads, explicit coalesced receiving, exact
private cached bytes, cancellation, generation change, disconnect, write failure,
stale revision token and simultaneous history actions. Failed transactions release
the real filesystem cache quota without publishing partial URIs.

The ZIP SHA-256 was
`9faf62e3bbefe868a7ebac93a16a5c386a7f7e6d84eef62739bc9aa8ff985089`.
All 82 tracked source files matched the tree published as `1654fdf`; 213 archive
entries passed duplicate/path/symlink and size checks. Upload hashes were read back
on each VM before execution. Both final runs passed 8/8 and removed their temporary
directories. Tests used a fresh private directory under the test account, empty
HOME/XDG directories, memory GSettings, no session/display environment, core dumps
disabled and a 50-second timeout. The script also refuses an ordinary HOME/cache.

Run only with a fresh `.gsconnect-receive-check.XXXXXXXX` working directory and
`HOME=$PWD/home`, `XDG_CACHE_HOME=$PWD/cache`, with display/session-bus environment
removed; invoke `gjs -m /path/to/testExplicitFileReceive.js /path/to/unpacked-zip`.
No extension was installed; no real clipboard, discovery, pairing, network payload,
GUI notification or two-machine transfer was exercised. This extends component
and target-runtime evidence, not desktop acceptance.

### Private-display GTK component verification (2026-11-18)

Both RHEL 10.2 VMs passed four real GTK 3 component scenarios using the packaged
production history/dialog classes and synthetic receive callbacks:
`installed-tests/gjs/testExplicitReceiveDialog.js`. Coverage includes initial
no-download behavior and visible explicit action; pending/disabled and success
states; failure/retry; stale-record rejection; and closing during a pending action.
Synthetic ready/pending/success/error window renders were saved for internal visual
inspection. The final runs enable fatal GTK criticals and exit zero without client
warnings. An earlier drawing-allocation failure was corrected in the test harness.

The harness starts only a disposable headless GNOME Shell, an empty private session
bus and a separate empty private mock system bus, with no service activation dirs.
The real system bus and the user's locked Wayland session are never used. The
first attempt with an unreachable system-bus address failed Shell initialization;
creating an isolated empty bus resolved that test dependency without permitting
access to actual system services. HOME/XDG directories are temporary, GSettings is
memory-only, Xwayland is disabled, core limit is zero and process deadlines apply.
All created process groups are stopped and temporary directories removed after
runs. No GSConnect extension or discovery daemon is loaded. Screenshots draw only
the synthetic GTK window, not the user's screen.

This verifies actual GTK construction/layout/callback presentation on the target
runtime, not real notification-center buttons, actual file receipt, application
paste, pairing, or two-machine transfer. It is not a same-UID security sandbox.

## 2026-11-18：显式接收通知动作的合成链路验证

在两台 RHEL 10.2 测试机的独立临时目录重新运行
`installed-tests/gjs/testExplicitFileReceive.js`，每台 **11/11 通过**。
新增 3 组场景覆盖通知动作的生产方法链路：
`Device.showNotification` → `daemon._device` → `Plugin._activateAction`
→ `ClipboardPlugin.clipboardReceiveFiles` → `RichClipboard.receiveFiles`。
测试从已核验 ZIP 提取原方法正文以及生产 Variant unpacker，不导入或启动
Device/daemon/plugin 初始化过程。动作分发使用真实 `GLib.Variant('(ssbv)')`、
`Gio.SimpleAction` 与 `Gio.SimpleActionGroup`，通知呈现器仍为记录型替身。

验证结果：
- 通知生成本身无下载/剪贴板发布；明确按钮传递设备 ID、动作名及 offer token。
- 重复激活经完整方法链路合并为一批；完整文件落盘后才发布本地 URI。
- 完成通知使用原通知 ID，移除旧接收按钮。
- 旧通知点击不能授权新 revision，并经生产插件生成错误反馈。
- disabled GAction 忽略激活；即使重新启用动作，断线状态仍独立拒绝接收。

包 SHA-256：`9faf62e3bbefe868a7ebac93a16a5c386a7f7e6d84eef62739bc9aa8ff985089`。
最终测试脚本 SHA-256：`0735ab26ef650409503d7c31e330f4b5e99f2e88f93f41609373c40b0b88b081`。
上传逐项哈希回读，解压前拒绝绝对路径、父目录穿越、重复项、符号链接及超额大小。
执行环境为空 HOME/XDG、无 DISPLAY/WAYLAND/D-Bus 地址，memory settings，
禁用 core，50 秒超时并设置 kill-after；两个临时目录均已删除且核验不存在。
`G_DEBUG=fatal-criticals` 下最终执行均 exit 0，无 GJS 警告。
初次夹具将字符串直接传给 `Gio.SimpleAction.parameter_type`，被原生类型检查拒绝；
改用 `GLib.VariantType('s')` 后重跑成功，没有更改生产实现或系统设置。

边界：这验证真实生产方法和原生动作/Variant 契约，不验证通知中心实际显示、
真实点击来源、生产服务初始化/权限设置或恶意同 UID 隔离。
通知渲染、网络传输和剪贴板均为合成边缘，不是双机真实传输或桌面验收。
NAT、SSH、真实配对、真实剪贴板及系统服务保持不变。

## 2026-11-18：双生产实例的内存通道闭环

扩展同一隔离 GJS 测试，每台 RHEL 10.2 VM **14/14 通过**。
新增 3 组场景在单进程内连接两个真实 `RichClipboard` 实例，执行生产
`publish/handle/request/serve/receive` 与通知动作路由，使用真实临时源文件、
Gio 输入流、缓存事务及本地 URI 输出。只有设备传输适配器使用内存通道和
本地复制替身，不建立网络 socket，不启动 D-Bus 服务。

- 正常闭环：元数据交换不传文件；明确通知动作触发一个版本绑定请求；
  实际读取合成源文件，完成缓存事务后发布 URI；输出字节与源文件精确一致。
  后续两次 URI provider 读取不增加请求。
- 源文件变化：元数据发布后改写合成源文件，真实 `serve` 拒绝；错误包经
  生产接收路径返回，错误反馈到通知层，不发布 URI，不保留失败批次配额。
- 负载大小不符：内存适配器故意宣称多 1 字节，真实 `receive` 明确拒绝
  负载，不进入文件复制，不发布 URI，失败配额回收。
- 每个场景结束 `pending` 与 `serving` 均清空；临时源文件删除。

测试包仍为上述 `9faf62e3…`，本轮测试脚本 SHA-256：
`a548cd6540a74b6ee6582f8ed11975db5542f387108e24b17c4d1a095a188dde`。
沿用哈希回读、安全解压、空 HOME/XDG、无桌面/总线环境、禁 core、
超时和失败清理。两机最终均 exit 0、无 GJS 警告，临时目录不存在已核验。
Node 回归仍为 308/308，测试脚本 ESLint 与 diff check 通过。

这不是两台虚拟机之间的真实传输：每台独立运行相同单进程模拟闭环。
尚未覆盖 TLS/真实 Transfer 适配器、发现/配对、通知中心显示、真实桌面粘贴、
服务初始化或进程崩溃恢复。现有 NAT 与 SSH 未修改，没有访问真实配对或剪贴板。

## 2026-11-18：生产下载方法的独立回环 TLS 验证

新增 `testPackagedRichDownloadTls.js` 与 `runPackagedRichDownloadTls.py`。
两台 RHEL 10.2 VM 分别连续执行两轮，**每轮 7/7，通过共 28 个场景**。
使用哈希锁定的原 `lan.download` 方法与原 `copyExact/writeBytes/transferCancellation`，
不导入 LAN 服务、设备设置或配对。Python `ssl` 服务端与 GJS 下载客户端分进程运行。

覆盖：2 MiB 完整文件、零长度、少 1 字节、额外 1 字节、操作 token 取消、
通道 token 取消、连接前取消。逐字节验证合成内容，并对成功文件断言固定 SHA-256：
`7e879fcd2433cef4a0888eee46fbbb05240f594b89e5052faf491c44888cb0ed`。
错误大小均拒绝；3 种取消均得到原生 CANCELLED；连接前取消未开始客户端连接；
检查文件和连接关闭、结算后无晚写入/内容改变。失败文件只存在于私有测试目录并被删除。

隔离与认证：
- Python AF_INET listener 显式绑定 `127.0.0.1:0`，读取实际 `getsockname()`
  断言回环；接受连接的本地/远端地址以及 GJS 客户端远端地址均断言回环。
- 每轮生成一次性 CA 与分角色 serverAuth/clientAuth 证书，私钥权限 0600；
  OpenSSL 验证用途，TLS 两端使用该临时 CA，并额外比较预期对端叶证书。
  没有无条件接受证书、忽略验证错误或修改系统信任库。
- 空 HOME/XDG、无桌面/会话总线地址、memory settings、core=0、子进程超时，
  上传哈希回读和解压防穿越均保留。每轮结束清理证书、源/目标文件及目录，
  并核验目录不存在；服务端线程已停止、listener 已关闭。

复现接口：在 `.gsconnect-tls-check.<随机字符>` 私有目录准备 `home/`、
`certs/{ca,server,client}.pem` 及相应私钥（只用新生成的测试证书），
并将同目录的两个脚本放在一起；空环境设 `HOME=$PWD/home`、`TMPDIR=$PWD`，
执行 `python3 runPackagedRichDownloadTls.py <已核验解压包绝对路径>`。
现有 `runPackagedCoreTls.certificates()` 可生成分角色证书，叶 PEM 后附临时 CA PEM。
外层调用者负责临时目录清理，不能提供真实证书或真实 HOME。
测试包 SHA-256 仍为 `9faf62e3bbefe868a7ebac93a16a5c386a7f7e6d84eef62739bc9aa8ff985089`。
最终 JS SHA-256：`626c3da898de4f2f59f036ea43713d5c005b47788775104348a8174c223b4874`。
最终 Python SHA-256：`bb62d9671381fced205ff8f0bd90509c790ad9066a22726b69e9e99c3ab0fc7f`。

诊断记录与边界：最初将 TLS 两端置于同一 GJS 进程时曾完成两机 7/7，
但后续在取消和零长度场景间歇出现无栈 `too much recursion`；单场景分进程仍出现。
没有据此修改生产代码，也没有确认其根因。最终将服务端移到独立 Python ssl 后，
上述两机各两轮未再出现。该改动消除了夹具同进程双端变量，不证明已修复 GJS 问题。
GIO 服务端对有效客户端证书也要求显式接受回调，初版缺少该回调导致认证失败；
该语义见 [GIO 官方说明](https://docs.gtk.org/gio/signal.TlsConnection.accept-certificate.html)。
最终 Python 服务端使用原生 CA 校验与 pin，不依赖这一 GJS 回调。

本轮**不覆盖**生产 `_uploadRich` 通配地址监听、生产 `_authenticate`/配对、
完整 Core.Transfer、真实发现、双机传输、通知中心或桌面粘贴。
不改变 NAT/SSH，不触碰真实配对和剪贴板。发布/ownership D-Bus 已在途时的
取消不能立即中断，返回或超时后唯一 ID 尽力清理仍属既有边界，不是本轮证实的缺陷。

## 2026-11-18：rich upload 最小监听 seam 与未通过的取消诊断

新增 `_bindRichTransferListener(listener, port)`，默认仍调用原
`add_inet_port(port, null)`，返回原 port；只有 `_uploadRich` 调用它。
legacy upload 不变，1739–1764 顺序/重试不变，无协议字段、环境变量或
用户设置可配置该方法。测试在调用前覆写实例方法，使用
`add_address(127.0.0.1, 0)`，检查实际地址和有效端口。
独立只读审查未发现 seam 的阻断问题；新增 Node 测试覆盖默认参数、
忽略伪造 packet.bindAddress、首端口失败后重试、全范围耗尽时不 accept/send
并清理 source/listener/取消处理器。

新增 `testPackagedRichUploadTls.js`、`runPackagedRichUploadTls.py`，
使用 hash 固定的原 `_uploadRich/_encryptServer/_authenticate`、Packet 和
取消清理函数。只导入提取的方法，不初始化 LAN 服务或设备；内存 settings
只提供临时 client.pem，任何其他设置访问或 unpair 都令测试失败。
Python 独立 TLS 客户端严格验证临时 CA、hostname 与 server leaf。
GJS 端保留**生产 TOFU 握手后客户端 leaf pin**，不声称是服务端严格 CA 校验。
READY 文本替代控制包通道，不验证真实 sendPacket；未使用错误证书测试。

首台 VM 的结果：
- 2 MiB 成功传输与固定 SHA-256 一致：
  `7e879fcd2433cef4a0888eee46fbbb05240f594b89e5052faf491c44888cb0ed`。
- 零长度成功；短 1 字节源得到 PARTIAL_INPUT；以上三个均走到原生产认证，
  synthetic unpaired=false。
- accept 阶段取消、预取消通过；预取消没有绑定监听。
- **正在传输的 16 MiB TLS upload 取消未通过**：GJS 报无栈
  `too much recursion`，客户端进程 -5；失败即停，未执行第二台。
  所有创建的临时证书、文件、进程和目录均已清理核验。

不能把这一轮记为 6/6，不能声称修复生产 TLS 取消。独立审查要求取消
必须是原生 CANCELLED/CLOSED，不能将任意异常加已取消 token 误判通过，已落实。
此前 download 夹具同进程双端只是一个变量；本次独立 Python 对端仍出现
类似异常，因此仍须定位 GJS/GIO TLS/取消/夹具边界，不能推断已知根因。
该 seam 和诊断夹具不等于可交付的真实双机/GUI验收，尚未修改生产取消行为。

当前诊断包 SHA-256：
`609d3bda37439cbb4dc54b357eb693b3b4d0f6fc95aeecd171ea3e69006cead8`。
新增 seam 仅使 lan.js hash 变化；两个既有下载夹具的固定 hash 同步更新。
NAT、SSH、真实配对和真实剪贴板未触碰。生产默认依旧是通配绑定，不能宣称
新增 seam 将正常部署改成回环限定。
