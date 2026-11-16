# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

project('gsconnect',
  'c',
  version: '74',
  meson_version: '>= 0.59.0',
)

gnome = import('gnome')
i18n = import('i18n')

app_id = 'org.gnome.Shell.Extensions.GSConnect'
app_path = '/org/gnome/Shell/Extensions/GSConnect'
extuuid = 'gsconnect@andyholmes.github.io'

prefix = get_option('prefix')
datadir = join_paths(prefix, get_option('datadir'))
extdatadir = join_paths(datadir, 'gnome-shell', 'extensions', extuuid)
libdir = join_paths(prefix, get_option('libdir'))
libexecdir = join_paths(prefix, get_option('libexecdir'))
localedir = join_paths(prefix, get_option('localedir'))
sysconfdir = get_option('sysconfdir')

gschemadir = join_paths(datadir, 'glib-2.0', 'schemas')


# GNOME Shell LIBDIR
if get_option('gnome_shell_libdir') != ''
  gnome_shell_libdir = get_option('gnome_shell_libdir')
else
  gnome_shell_libdir = libdir
endif


# Configuration
extconfig = configuration_data()
extconfig.set('PACKAGE_VERSION', meson.project_version())
extconfig.set('PACKAGE_URL', 'https://github.com/GSConnect/gnome-shell-extension-gsconnect')
extconfig.set('PACKAGE_BUGREPORT', 'https://github.com/GSConnect/gnome-shell-extension-gsconnect/issues/new')
extconfig.set('PACKAGE_DATADIR', extdatadir)
extconfig.set('PACKAGE_LOCALEDIR', localedir)
extconfig.set('GSETTINGS_SCHEMA_DIR', gschemadir)

extconfig.set('APPLICATION_ID', app_id)
extconfig.set('APPLICATION_PATH', app_path)

extconfig.set('GNOME_SHELL_LIBDIR', gnome_shell_libdir)
extconfig.set('FFMPEG_PATH', get_option('ffmpeg_path'))
extconfig.set('OPENSSL_PATH', get_option('openssl_path'))
extconfig.set('SSHADD_PATH', get_option('sshadd_path'))
extconfig.set('SSHKEYGEN_PATH', get_option('sshkeygen_path'))


# ZIP targets for user extension builds
env_util = find_program('env')
python = find_program('python3')
native_package_tool = files('build-aux/ego/native-package.py')
native_build = get_option('native_clipboard_build_dir')
if native_build != ''
  fs = import('fs')
  native_meson = find_program('meson')
  if not fs.is_absolute(native_build)
    error('native_clipboard_build_dir must be absolute')
  endif
  custom_target('stage-native-clipboard',
    input: [native_build / 'GscClipboard-1.0.gir',
      native_build / 'GscClipboard-1.0.typelib',
      native_build / 'libgsc-clipboard-1.so.0'],
    output: ['GscClipboard-1.0.typelib', 'libgsc-clipboard-1.so.0',
      'native-clipboard-manifest.json'],
    command: [python, native_package_tool, 'stage', '--build-dir', native_build,
      '--output-dir', meson.current_build_dir(), '--mutter-api', get_option('native_clipboard_mutter_api'),
      '--clean-install', '--meson', native_meson.full_path()],
    build_by_default: true, install: true, install_dir: extdatadir / 'native')
endif

run_target(
  'make-pkgdir',
  command: [
    env_util,
    'UUID=' + extuuid,
    'DATADIR=' + datadir,
    'LOCALEDIR=' + localedir,
    'GSCHEMADIR=' + gschemadir,
    'PYTHON=' + python.full_path(),
    'NATIVE_PACKAGE_TOOL=' + meson.current_source_dir() / 'build-aux/ego/native-package.py',
    'NATIVE_MANIFEST=' + (native_build == '' ? '' : meson.current_build_dir() / 'native-clipboard-manifest.json'),
    'NOZIP=true',
    join_paths(meson.project_source_root(), 'build-aux', 'ego', 'mkzip.sh')
  ]
)


run_target(
  'make-zip',
  command: [
    env_util,
    'UUID=' + extuuid,
    'DATADIR=' + datadir,
    'LOCALEDIR=' + localedir,
    'GSCHEMADIR=' + gschemadir,
    'PYTHON=' + python.full_path(),
    'NATIVE_PACKAGE_TOOL=' + meson.current_source_dir() / 'build-aux/ego/native-package.py',
    'NATIVE_MANIFEST=' + (native_build == '' ? '' : meson.current_build_dir() / 'native-clipboard-manifest.json'),
    join_paths(meson.project_source_root(), 'build-aux', 'ego', 'mkzip.sh')
  ]
)

run_target(
  'install-zip',
  command: [
    env_util,
    'UUID=' + extuuid,
    'DATADIR=' + datadir,
    'LOCALEDIR=' + localedir,
    'GSCHEMADIR=' + gschemadir,
    'PYTHON=' + python.full_path(),
    'NATIVE_PACKAGE_TOOL=' + meson.current_source_dir() / 'build-aux/ego/native-package.py',
    'NATIVE_MANIFEST=' + (native_build == '' ? '' : meson.current_build_dir() / 'native-clipboard-manifest.json'),
    'INSTALL=true',
    join_paths(meson.project_source_root(), 'build-aux', 'ego', 'mkzip.sh')
  ]
)


# Post-Install script for distributions without the hooks
gnome.post_install(
  glib_compile_schemas: true,
  gtk_update_icon_cache: true,
  update_desktop_database: true,
)


# Extension Source
install_subdir(
  'src',
  install_dir: extdatadir,
  strip_directory: true,
  exclude_directories: ['native']
)

eslint = find_program('eslint', required: false)

if eslint.found()
  test('ESLint (Source)', eslint,
    args: join_paths(meson.project_source_root(), 'src'),
    suite: 'lint',
  )
  test('ESLint (Installed Tests)', eslint,
    args: join_paths(meson.project_source_root(), 'installed-tests'),
    suite: 'lint',
  )
  test('ESLint (WebExtension)', eslint,
    args: join_paths(meson.project_source_root(), 'webextension'),
    suite: 'lint',
  )
endif

black = find_program('black', required: false)
if black.found()
  test('Python Black (Nautilus Extension)', black,
    args: [
      '--check',
      '--diff',
      join_paths(meson.project_source_root(), 'nautilus-extension')
    ],
    suite: 'lint',
  )
endif

flake8 = find_program('flake8', required: false)
if flake8.found()
  test('Python Flake8 (Nautilus Extension)', flake8,
    args: join_paths(meson.project_source_root(), 'nautilus-extension'),
    suite: 'lint',
  )
endif


subdir('data')
subdir('installed-tests')
subdir('nautilus-extension')
subdir('po')

