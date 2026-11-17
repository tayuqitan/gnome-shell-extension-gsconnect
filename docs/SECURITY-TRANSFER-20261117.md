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
