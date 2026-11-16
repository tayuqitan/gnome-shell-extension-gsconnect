# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
# SPDX-License-Identifier: GPL-2.0-or-later
project('gsconnect-native-clipboard', 'c', version: '0.1.0',
  meson_version: '>=0.59.0', default_options: ['warning_level=3', 'c_std=c11'])

gnome = import('gnome')
api = get_option('mutter_api')
gio = dependency('gio-2.0', version: '>=2.68')
mutter = dependency('libmutter-' + api)
mutter_girdir = mutter.get_variable(pkgconfig: 'girdir')
mutter_typelibdir = mutter.get_variable(pkgconfig: 'typelibdir')
test_env = environment()
test_env.prepend('GI_TYPELIB_PATH', mutter_typelibdir)
test_env.prepend('GI_TYPELIB_PATH', meson.current_build_dir())
# Standalone GJS is not GNOME Shell: it does not add Mutter's private paths.
test_env.prepend('LD_LIBRARY_PATH', mutter_typelibdir)
test_env.prepend('LD_LIBRARY_PATH', meson.current_build_dir())
helper = library('gsc-clipboard-1', 'gsc-clipboard-source.c',
  dependencies: [gio, mutter], install: true, version: '0.1.0')
install_headers('gsc-clipboard-source.h', subdir: 'gsc-clipboard-1')
gir = gnome.generate_gir(helper,
  sources: ['gsc-clipboard-source.c', 'gsc-clipboard-source.h'],
  namespace: 'GscClipboard', nsversion: '1.0',
  identifier_prefix: 'GscClipboard', symbol_prefix: 'gsc_clipboard',
  includes: ['GObject-2.0', 'Gio-2.0', 'Meta-' + api],
  header: 'gsc-clipboard-source.h',
  extra_args: ['--warn-all', '--strict'], install: true)

native_test = executable('test-source', 'tests/test-source.c',
  include_directories: include_directories('.'),
  dependencies: [gio, mutter], link_with: helper)
test('native-clipboard-source', native_test, args: ['-x', '/clipboard/deadline'], env: test_env, timeout: 30)
if get_option('native_timeout_test')
  test('native-clipboard-deadline', native_test, args: ['-p', '/clipboard/deadline'], env: test_env, timeout: 90)
endif
if get_option('gjs_smoke_test')
  gjs = find_program('gjs')
  test('gjs-clipboard-source', gjs, args: ['-m', files('tests/smoke.mjs')],
    env: test_env, depends: gir, timeout: 30)
  test('gjs-native-loader', gjs,
    args: ['-m', files('tests/loader.mjs'),
      meson.current_source_dir() / '../src/shell/clipboardNative.js'],
    env: test_env, depends: gir, timeout: 30)
  python = find_program('python3')
  gir_compiler = find_program('g-ir-compiler')
  test('gjs-missing-native-library', python,
    args: [files('tests/missing-library.py'),
      '--gir', gir[0], '--compiler', gir_compiler.full_path(),
      '--gjs', gjs.full_path(),
      '--loader', meson.current_source_dir() / '../src/shell/clipboardNative.js',
      '--include-dir', mutter_girdir],
    env: test_env, depends: gir, timeout: 90)
endif
