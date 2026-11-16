<!-- SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
SPDX-License-Identifier: GPL-2.0-or-later -->
# Native clipboard selection source

GJS 1.80 cannot implement Meta.SelectionSource's callback-bearing `read_async`
vfunc. This helper owns that vfunc and all GTask pointer results in C. JavaScript
uses only signals, strings, GBytes and ordinary methods.

Build against the **actual** Mutter development headers and matching GIR on the
target machine. Do not copy an ABI declaration or use headers for another major
Mutter version. Building needs a C compiler, Meson/Ninja, GLib/GIO development
files, `libmutter-N` development files, and GObject Introspection scanner/compiler.
A helper built for Meta-17 is not a universal binary for other Meta versions.

```
meson setup native-clipboard/_build native-clipboard -Dmutter_api=17 -Dgjs_smoke_test=true
meson compile -C native-clipboard/_build
meson test -C native-clipboard/_build --print-errorlogs
```

This does not install anything. For an extension-local package, copy the built
`GscClipboard-1.0.typelib` and the **real file** behind `libgsc-clipboard-1.so*`
into its `native/` directory, preserving the SONAME filename
`libgsc-clipboard-1.so.0` (copy its bytes, not a broken build-tree symlink). The
Shell loader must prepend that directory to GIRepository's search **and library**
paths before importing this namespace. The main project owns packaging and
activation; these commands do not enable an extension or change system files.

`meson install` is deliberately optional, and installs to the explicitly selected
Meson prefix. It is not necessary for local extension packaging.

## API

- `GscClipboard.Source.new(offerId, mimeArray, timeoutSeconds)` validates 1–64
  formats and a 60–86400-second total deadline, and can throw.
- `request(requestId, mimetype)` fires on the main thread. The signal handler may
  synchronously call `resolve()` to reject a gated request before any network I/O.
- `resolve(requestId, GLib.Bytes|null, errorString|null)` completes a pending read
  exactly once and returns whether it existed. Missing/oversize (>16 MiB) success
  data is rejected. File bodies must not go through this memory bridge.
- `cancel-requested(requestId)` asks the JavaScript transport to abort after a
  cancellation, error, close, or deadline. Reentrant replies are safe.
- `close()` permanently stops the source; repeated close is harmless.
- `get_offer_id()`, `get_closed()` expose metadata.

Construct and use methods on the same main thread. `GCancellable.cancel()` may
come from another thread: it marks the pending read atomically, then queues an
idle on the captured main context. Success after cancellation is refused even
before that idle runs. No JavaScript sees a native task pointer. Up to 32 reads
may be pending. The owner must call `close()` on shutdown; deactivation also
closes pending reads before chaining the parent's virtual method.

Native tests cover synchronous signal replies/binary bytes, late replies,
threaded cancellation, the request bound, close, oversized values and constructor
validation. The optional GJS smoke verifies real GIR import and C-to-JS signals.
Neither test substitutes for two GNOME sessions, actual application paste,
clipboard-manager interactions or the transport integration tests.


### Missing-library fallback smoke

With `-Dgjs_smoke_test=true`, `gjs-missing-native-library` also generates a temporary
valid GscClipboard typelib from the build GIR, changing only its shared library
to a unique nonexistent SONAME. In a new real GJS process the native library must
fail either eagerly on namespace import or lazily on class resolution; the test
reports which phase occurred. The project's actual `clipboardNative.js` loader
must report unavailable and reject `createSource()`. This covers lazy GI library
resolution without rejecting versions that resolve eagerly, and is not just an
absent-typelib test. The real loader is
copied into the temporary fixture; it is not replaced with a mock. All fixture
files are removed afterwards. Python 3 and `g-ir-compiler` are required.

The native suite additionally covers pre-cancelled requests, reentrant
cancellation handlers, final caller-reference release, and 200 concurrent
cancel/resolve races. These are test definitions until run against actual
matching Mutter development libraries. Enable `-Dnative_timeout_test=true` for
an additional real 60-second timeout case (90-second test-runner limit); the
normal native suite excludes it, without injecting a fake production clock or
relaxing the production minimum deadline.

## Staged verification plan (not a claim that these tests ran)

1. Confirm exact installed Mutter version and the `libmutter-N` development
   metadata. Match its `apiversion`, `girdir` and `typelibdir`; never substitute
   a neighboring major version. Confirm `g-ir-scanner`, `g-ir-compiler`, GJS,
   Meson and Ninja are present before starting. Extracted RPM development
   dependencies need a separately validated pkg-config/tool environment.
2. Configure with `-Dgjs_smoke_test=true -Dnative_timeout_test=true`, compile,
   then run `meson test -C native-clipboard/_build --print-errorlogs`. Meson adds
   Mutter's private runtime directories from pkg-config for standalone tests.
   Inspect compiler/GIR warnings and every test result, including the real
   60-second deadline, successful actual-loader test, and missing-library test.
3. Only after the native suite succeeds, stage regular files for ZIP packaging:

   ```sh
   mkdir -p src/native
   cp native-clipboard/_build/GscClipboard-1.0.typelib src/native/
   cp -L native-clipboard/_build/libgsc-clipboard-1.so.0 src/native/
   readelf -d src/native/libgsc-clipboard-1.so.0
   # Confirm SONAME is libgsc-clipboard-1.so.0 and NEEDED names match this Mutter ABI.
   ```

   Do not commit these machine-specific binary outputs. The main project's
   `install_subdir('src', ...)` and `make-zip` package `src/native/` as `native/`.
   Use `make-zip`, **not** `install-zip`. This stages/builds an archive; it does
   not authorize installing or enabling it on the user's desktop.
4. Verify the resulting ZIP contains regular, non-symlink entries
   `native/GscClipboard-1.0.typelib` and `native/libgsc-clipboard-1.so.0` with bytes
   identical to the staged files. Extract only this locally built archive into
   a fresh temporary directory. Run the actual loader against that extracted
   package with the build directory absent from GI/library search paths:

   ```sh
   # PACKAGE is the temporary unpacked ZIP root; API is this machine's Meta API.
   PRIVATE=$(pkg-config --variable=typelibdir "libmutter-$API")
   GI_TYPELIB_PATH="$PRIVATE" LD_LIBRARY_PATH="$PRIVATE" \
     gjs -m native-clipboard/tests/loader.mjs "$PACKAGE/shell/clipboardNative.js"
   GI_TYPELIB_PATH="$PACKAGE/native:$PRIVATE" \
     LD_LIBRARY_PATH="$PACKAGE/native:$PRIVATE" \
     gjs -m native-clipboard/tests/smoke.mjs
   ```

   This checks packaged SONAME resolution rather than accidentally using the
   build-tree library. Save the ZIP hash and exact package versions with results.
5. Actual Shell activation, copy/paste into applications, progress UI, concurrent
   readers, Ctrl+V gating, history and two-machine TLS transfer remain a separate
   explicitly authorized desktop acceptance stage. Native tests do not establish
   those outcomes. Do not change SELinux, firewall or other security settings to
   make an unsuccessful test appear to pass.
