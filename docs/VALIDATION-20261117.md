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

No new extension installation, Shell restart or pairing change was performed.
Actual GNOME activation, rendered dialog UX, two-machine TLS transfer and Ctrl+V
behavior remain unverified because graphical-session access is restricted.
Mocked GTK tests are not screenshots or application acceptance.

The earlier functional limits remain: ordinary MIME transfer is capped at
16 MiB per representation; folders, symlinks and non-local URIs are unsupported.
The experimental Ctrl+V gate defaults off, is not a reliable reader-identity
security boundary, and does not prove every application waits for large files.
File histories do not persist across service restart. Do not describe this as
universal clipboard or full persistent history compatibility.
