# Isolated integration validation, 2026-11-16

Sources: native bridge/package f64c546 plus cache commits c1ee640, cf1ada0,
790b91a. Integrated in feature/rich-clipboard-integrated. The protocol test
fixture now mocks the new storage adapter; no production behavior was bypassed.

Target: RHEL localhost, mutter 49.4-6.el10_3.1, gjs 1.80.2-11.el10,
gnome-shell 49.5-13.el10, Meta API 17. Matching development RPMs were extracted
into an isolated sysroot, not installed. No desktop or pairing settings changed.

Passed:
- 108 Node protocol, cancellation, portal, history and quota mock tests.
- 36 Python native-package/archive tests.
- Real GJS/GIO storage rollback, path validation, exposure, restart, quota,
  failed-cleanup retry and external-growth accounting tests.
- Five native/GJS suites, including the real 60-second request deadline,
  actual loader and missing-library fallback.
- Three Meson data validation tests.
- Full extension ZIP construction and automatic archive hash/ABI structure checks.
- Extracted ZIP's actual native loader and GJS smoke with only packaged native
  paths and the system Mutter runtime paths, not the build library paths.

Compiler warnings were from Mutter headers (pedantic enum declarations and
extra semicolons); no project source or GIR warning appeared.

NOT verified: real GNOME Shell activation, rendered history/quota UI, two-machine
TLS transfer, Ctrl+V gating and application waiting behavior. The installed older
experimental extension remains unchanged; this is not a desktop acceptance claim.
History still lasts only for the service session. Completed downloaded files are
never automatically deleted; quota exhaustion rejects new downloads.

## Documentation/UI wording follow-up

The Chinese guide now names clipboard-cache-v2, distinguishes its admission
allowance from a hard disk quota, and explains legacy-cache exclusion and
retention. The UI explicitly repeats these limits. Two regression checks cover
this contract; the complete Node suite now passes 110 tests.

Desktop validation remains blocked: read-only session D-Bus query returned
`Unable to create socket: Operation not permitted`; GTK 3 `init_check` returned
false. No Xvfb or nested-compositor executable was available. Native computer
control is disabled in this connection. No installation, Shell restart,
clipboard read, pairing change or security-policy modification was attempted.
ESLint remains unrun: dependencies were unavailable and the stalled npm install
was cancelled. Empty connector CI status/run lists do not establish a CI pass.
