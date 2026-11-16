# Clipboard cache ledger integration contract

The ledger now has a GIO storage backend and is connected to `fetchFiles`.
This is an independently developed experimental branch based on 300fad2, not a
merge of later feature-branch fixes. It has NOT been validated across two desktops.

## Implemented policy

* Global `clipboard-cache-max-bytes` GSettings key: default 10 GiB, range 0–1 TiB.
  Read on each new batch; lowering it blocks new allocations without deleting
  existing files. The history MiB control remains a separate memory/history limit.
* All peers in the normal single GSConnect service process share one reservation
  ledger. The GApplication single-instance service is required; this is not a
  cross-process storage library and must not be independently instantiated by
  multiple writers on the same root.
* New data lives under `gsconnect/clipboard-cache-v2` in the user's cache directory.
  Restart scans and charges all existing v2 data, including incomplete batches;
  it never guesses which persisted files are safe to delete. Legacy `clipboard`
  cache is neither deleted nor included in this new quota.
* Accounting charges logical file size with a 4 KiB minimum and 4 KiB per folder.
  This is a conservative allocation estimate, not an exact filesystem block
  limit. Filesystem free space is checked as well. Other programs can still fill
  the disk, and filesystem allocation overhead can differ.
* Private transaction directories, bounded filename validation and no-follow
  ownership/type checks protect source paths. Only tracked files in the fresh
  transaction can be rolled back, never arbitrary clipboard URI paths. Directory
  identities are checked. This does not claim protection against a malicious
  process running as the same Unix user racing filesystem operations.
* Transfer failures and cancellations await tracked writers, then remove the
  unexposed batch including earlier completed files. Failed cleanup retains its
  reservation. Source files are never passed to the removal backend.
* Successful URIs are pinned permanently. Clearing history cannot delete them.
  Reaching quota refuses new transfers. There is currently NO automatic reclamation
  of completed data, no cleanup UI, and no retention expiry. This favors safe
  existing pastes over indefinite operation without user maintenance.

## Remaining requirements for broader lifecycle support


* One ledger for all peers, not one per device. The limit is a global disk limit,
  separate from history snapshot bytes. Include existing managed committed data
  on startup before admitting requests. Unknown old cache data must be counted
  conservatively or surfaced separately, never silently deleted.
* Before reserve, query free space. Reserve the entire batch synchronously before
  starting any file write. All transfer writers must honor declared lengths.
  Reservation subtraction from free space is conservative while a batch is being
  written. Filesystem ENOSPC remains possible from other applications; roll back.
* Create private transaction directories under a dedicated owned root, using
  random generated names and exclusive creation. `bind` takes an opaque handle
  registered by this backend; never bind user paths, source paths, or peer URIs.
* The backend remove(handle) must delete only registered paths, reject symlink
  traversal and changed identities, and never recursively follow links. Commit
  data using atomic renames and a versioned atomic manifest. Treat metadata
  parsing failure or cleanup errors as failure, retain charged quota.
* Failed/cancelled batches: close all streams first, release internal reader pins,
  discard the whole transaction including earlier successful files. Failed
  cleanup remains charged; reconcile on the next controlled startup.
* On success complete(token, actualBytes); retain separate references for history,
  active providers and each in-flight reader. Always release in finally blocks.
* Call expose(token) BEFORE returning any file URI to an application. External
  applications can keep reading a URI after clipboard replacement, so refcount
  zero is insufficient permission to delete. This primitive intentionally never
  auto-deletes exposed data. A future explicit cleanup UI must warn about this;
  an automatic age policy requires a clearly disclosed retention contract.
* Do not release storage accounting merely on service restart. Reconstruct from
  manifest and disk. Never recover by deleting unknown user files. Multiple
  service processes require a process lock or backend transactional coordination.

## User-controlled vs invariant

User may configure global quota, history capacity/count and unexposed-cache idle
retention. Lowering quota below pinned usage blocks new downloads, never force
removes active data. Setting zero disables new storage. Source-file protection,
path confinement, exclusive ownership and rejection of corrupt metadata cannot
be disabled by these settings. Existing cached URI lifetimes must be visible.

## Tests

`node --test installed-tests/node/testClipboardCacheLedger.mjs`

Tests cover concurrent reservation, disk-space overbooking, invalid sizes,
transaction rollback handles, independent readers, exposed URI protection,
limit reduction, cleanup failure, size overrun, and deletion/retain races.
Run `gjs -m installed-tests/gjs/testClipboardCacheStorage.js` for isolated real
GIO transaction creation/deletion tests. This creates only a fresh test directory
inside the current working directory, never the actual clipboard cache.
`testClipboardCacheIntegration.mjs` exercises the transfer/rollback bridge with
mocks, including waiting for cancelled writers. No desktop changes are performed.
