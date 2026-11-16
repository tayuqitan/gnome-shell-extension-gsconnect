#!/bin/sh

# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
# SPDX-License-Identifier: GPL-2.0-or-later
set -eu

: "${MESON_BUILD_ROOT:?Missing build directory}"
: "${UUID:?Missing extension UUID}"
: "${NATIVE_PACKAGE_TOOL:?Missing package validator}"
: "${PYTHON:?Missing Python interpreter}"
export DESTDIR="${MESON_BUILD_ROOT}/_zip"
ZIP_DIR="${MESON_BUILD_ROOT}/${UUID}"
ZIP_FILE="${MESON_BUILD_ROOT}/${UUID}.zip"

# Every install below is staged through DESTDIR, never into the live desktop.
rm -rf "$DESTDIR" "$ZIP_DIR" "$ZIP_FILE"
ninja -C "$MESON_BUILD_ROOT" install > /dev/null
mkdir -p "$ZIP_DIR"
cp -pr "$DESTDIR/$DATADIR/gnome-shell/extensions/$UUID/." "$ZIP_DIR/"
# File-browser integration is optional (for example -Dnautilus=false).
if [ -d "$DESTDIR/$DATADIR/nautilus-python/extensions" ]; then
    cp -pr "$DESTDIR/$DATADIR/nautilus-python/extensions/." "$ZIP_DIR/"
fi
if [ -d "$DESTDIR/$LOCALEDIR" ]; then
    cp -pr "$DESTDIR/$LOCALEDIR" "$ZIP_DIR/"
fi
cp -pr "$DESTDIR/$GSCHEMADIR" "$ZIP_DIR/"

if [ "${NOZIP:-false}" = true ]; then
    echo "Extension staged in $ZIP_DIR"
    exit 0
fi

cd "$ZIP_DIR"
zip -qr "$ZIP_FILE" .
if [ -n "${NATIVE_MANIFEST:-}" ]; then
    if ! "$PYTHON" "$NATIVE_PACKAGE_TOOL" verify --zip "$ZIP_FILE" --manifest "$NATIVE_MANIFEST"; then
        rm -f "$ZIP_FILE"
        exit 1
    fi
else
    if ! "$PYTHON" "$NATIVE_PACKAGE_TOOL" verify --zip "$ZIP_FILE"; then
        rm -f "$ZIP_FILE"
        exit 1
    fi
fi
echo "Verified extension archive saved to $ZIP_FILE"

# Only the separate, explicit install-zip target activates this path.
if [ "${INSTALL:-false}" = true ]; then
    gnome-extensions install --force "$ZIP_FILE"
fi
