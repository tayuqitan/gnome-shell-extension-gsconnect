# Clipboard cache ledger integration contract

This module is a tested accounting primitive, NOT a deployed disk quota fix.
It does not touch the filesystem and is deliberately not wired into transfers
until the owned-storage backend and restart accounting are implemented.

## Required backend

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
No desktop changes or filesystem deletion tests are performed by this suite.
