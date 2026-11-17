#!/usr/bin/env bash
# Shell-loading smoke test ONLY. Does not install into the real account.
set -euo pipefail
umask 077
BRIDGE=0
if [[ ${1:-} == --bridge ]]; then BRIDGE=1; shift; fi
[[ $# -eq 1 ]] || { echo 'Usage: bash isolated-shell-smoke.sh [--bridge] /absolute/path/to/validated.zip' >&2; exit 1; }
ZIP=$1
[[ $ZIP == /* ]] || { echo 'ZIP path must be absolute.' >&2; exit 1; }
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CLIENT="$SCRIPT_DIR/../gjs/testShellClipboardBridge.js"
EXPECTED=242e042da8308e649c4e151ef1238fae4610469acb633bb4dbc947764f8ddfa3
UUID=gsconnect@andyholmes.github.io
for cmd in bash python3 sha256sum mktemp env dbus-run-session gnome-shell gsettings glib-compile-schemas gdbus timeout tee cut grep mkdir cat chmod seq sleep dirname cp gjs; do
    command -v "$cmd" >/dev/null || { printf '缺少依赖：%s\n' "$cmd" >&2; exit 1; }
done
[[ ${XDG_SESSION_TYPE:-} == wayland ]] || { echo '请在当前 GNOME Wayland 桌面的图形终端运行。' >&2; exit 1; }
[[ -n ${XDG_RUNTIME_DIR:-} && -n ${WAYLAND_DISPLAY:-} ]] || { echo '没有当前 Wayland 会话信息。' >&2; exit 1; }
PARENT_DISPLAY=$WAYLAND_DISPLAY
[[ $PARENT_DISPLAY == /* ]] || PARENT_DISPLAY="$XDG_RUNTIME_DIR/$PARENT_DISPLAY"
[[ -S $PARENT_DISPLAY && -O $PARENT_DISPLAY ]] || { echo '当前用户的 Wayland socket 不可用。' >&2; exit 1; }
# Mutter 49's --nested backend is X11-hosted, even for a Wayland child.
# Forward only the current local display and existing authority PATH, never cookies.
HOST_DISPLAY=${DISPLAY:-}
HOST_XAUTHORITY=${XAUTHORITY:-${HOME:?}/.Xauthority}
[[ $HOST_DISPLAY =~ ^:[0-9]+(\.[0-9]+)?$ ]] || { echo '缺少本地 Xwayland DISPLAY；请从当前桌面终端运行，不要手动猜测显示地址。' >&2; exit 1; }
[[ $HOST_XAUTHORITY == /* && -f $HOST_XAUTHORITY && -r $HOST_XAUTHORITY && -O $HOST_XAUTHORITY ]] || { echo '当前会话 XAUTHORITY 文件不可读；停止，不修改 xhost 或认证设置。' >&2; exit 1; }
# Read-only connection probe, before creating any test directory or launching Shell.
if ! env -i PATH=/usr/bin:/bin DISPLAY="$HOST_DISPLAY" XAUTHORITY="$HOST_XAUTHORITY" timeout 5s python3 - <<'XPROBE'
import ctypes, ctypes.util, sys
name = ctypes.util.find_library('X11')
if not name:
    sys.exit('缺少 libX11，停止')
x = ctypes.CDLL(name)
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XOpenDisplay.restype = ctypes.c_void_p
connection = x.XOpenDisplay(None)
if not connection:
    sys.exit('无法连接当前 Xwayland 显示；不要关闭认证或修改 xhost')
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
x.XCloseDisplay(connection)
print('当前 Xwayland 显示只读连接检查通过')
XPROBE
then
    echo '显示预检失败，尚未创建测试目录或启动嵌套 Shell。' >&2
    exit 1
fi
[[ -f $ZIP && ! -L $ZIP ]] || { echo '测试 ZIP 不存在或是符号链接。' >&2; exit 1; }
[[ $(sha256sum "$ZIP" | cut -d ' ' -f 1) == "$EXPECTED" ]] || { echo 'ZIP 校验不符，停止；不要替换校验值继续。' >&2; exit 1; }
gnome-shell --help | grep -q -- --nested || { echo 'GNOME Shell 不支持嵌套模式。' >&2; exit 1; }
if [[ $BRIDGE == 1 ]]; then
    printf '测试可能覆盖当前剪贴板；如有需保留的复制内容，请先自行粘贴保存。\n'
fi
ROOT=$(mktemp -d "/tmp/gsconnect-shell-smoke.XXXXXXXX")
mkdir -p "$ROOT"/{home,config,data,cache,state,runtime}
cp "$CLIENT" "$ROOT/bridge-client.js"
EXT="$ROOT/data/gnome-shell/extensions/$UUID"
mkdir -p "$EXT"
python3 - "$ZIP" "$EXT" <<'PY'
import pathlib, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    names = set()
    for item in z.infolist():
        p = pathlib.PurePosixPath(item.filename)
        if p.is_absolute() or '..' in p.parts or item.filename in names or stat.S_ISLNK(item.external_attr >> 16):
            raise SystemExit('不安全 ZIP 条目，停止')
        names.add(item.filename)
    if z.testzip() is not None:
        raise SystemExit('ZIP CRC 校验失败')
    z.extractall(sys.argv[2])
PY
# Deliberate safety harness: only the disposable copy's daemon is replaced.
# Shell/native-bridge code remains unchanged. No original identities are copied.
cat > "$EXT/service/daemon.js" <<'STUB'
#!/bin/sh
printf '%s\n' 'SAFETY BLOCK: GSConnect daemon disabled in shell-only smoke test' >&2
exit 77
STUB
chmod 700 "$EXT/service/daemon.js"
glib-compile-schemas --strict "$EXT/schemas"
cat > "$ROOT/run-session.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
ROOT=$1
BRIDGE=$2
SCHEMA=org.gnome.Shell.Extensions.GSConnect
gsettings set "$SCHEMA" enabled false
gsettings set "$SCHEMA" create-native-messaging-hosts false
gsettings set "$SCHEMA" discoverable false
gsettings set "$SCHEMA" experimental-clipboard-paste-gate false
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['gsconnect@andyholmes.github.io']"
printf 'Isolated HOME=%s\n' "$HOME"
printf 'GSConnect enabled=%s; paste gate=%s\n' "$(gsettings get "$SCHEMA" enabled)" "$(gsettings get "$SCHEMA" experimental-clipboard-paste-gate)"
pid=''; monitor=''; client=''
cleanup() {
    trap - EXIT INT TERM
    [[ -z $client ]] || kill "$client" 2>/dev/null || true
    [[ -z $monitor ]] || kill "$monitor" 2>/dev/null || true
    [[ -z $pid ]] || kill -TERM "$pid" 2>/dev/null || true
    [[ -z $client ]] || wait "$client" 2>/dev/null || true
    [[ -z $monitor ]] || wait "$monitor" 2>/dev/null || true
    [[ -z $pid ]] || wait "$pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Distinct child runtime avoids desktop socket collisions. DISPLAY is host Xwayland.
timeout --signal=TERM --kill-after=5s 180s gnome-shell --nested --wayland --no-x11 --wayland-display=gsconnect-smoke &
pid=$!
(
    for attempt in $(seq 1 12); do
        sleep 5
        if info=$(timeout 3s gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Extensions.GetExtensionInfo gsconnect@andyholmes.github.io); then
            printf '%s\n' "$info"
            timeout 3s gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Extensions.GetExtensionErrors gsconnect@andyholmes.github.io || true
        fi
    done
) &
monitor=$!
if [[ $BRIDGE == 1 ]]; then
    # First let Shell initialize. The client independently verifies the exact
    # ACTIVE extension path and unique Shell owner before touching selection.
    sleep 8
    timeout --signal=TERM --kill-after=5s 30s gjs -m "$ROOT/bridge-client.js" \
        --bus-address "$DBUS_SESSION_BUS_ADDRESS" --root "$ROOT" \
        --extension-path "$ROOT/data/gnome-shell/extensions/gsconnect@andyholmes.github.io" &
    client=$!
    result=0
    wait "$client" || result=$?
    client=''
    printf 'Bridge client exit code: %s (only 0 is success)\n' "$result"
    if [[ $result == 0 ]]; then echo 'PASS bridge integration client'; else echo 'FAIL bridge integration client'; fi
    timeout 3s gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Extensions.GetExtensionInfo gsconnect@andyholmes.github.io || true
    timeout 3s gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Extensions.GetExtensionErrors gsconnect@andyholmes.github.io || true
    exit "$result"
fi
status=0
wait "$pid" || status=$?
pid=''
printf 'Nested shell exit code: %s (124 means the 180-second timer expired)\n' "$status"
exit "$status"
INNER
printf '只测试隔离 Shell 加载，不测试同步/粘贴，也不安装。\n临时目录和日志：%s\n' "$ROOT"
printf '本测试故意禁用服务，因此 Mobile Settings 无法打开属预期；请勿点击 GSConnect 开关、配对或打开移动设置。结束：回到此终端按 Ctrl+C；窗口最长 180 秒；整个测试最长 210 秒自动停止。\n'
printf '如终端无法接收按键，等待自动停止，不要运行 killall gnome-shell。\n'
set +e
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$ROOT/home" \
    XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" \
    XDG_CACHE_HOME="$ROOT/cache" XDG_STATE_HOME="$ROOT/state" \
    XDG_RUNTIME_DIR="$ROOT/runtime" XDG_DATA_DIRS=/usr/local/share:/usr/share \
    XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME \
    WAYLAND_DISPLAY="$PARENT_DISPLAY" DISPLAY="$HOST_DISPLAY" XAUTHORITY="$HOST_XAUTHORITY" \
    GSETTINGS_BACKEND=dconf \
    GSETTINGS_SCHEMA_DIR="$EXT/schemas" \
    timeout --signal=TERM --kill-after=5s 210s dbus-run-session -- bash "$ROOT/run-session.sh" "$ROOT" "$BRIDGE" 2>&1 | tee "$ROOT/session.log"
status=${PIPESTATUS[0]}
set -e
printf '\n测试结束，状态 %s。日志：%s/session.log\n正式安装和配对没有被此脚本替换；临时目录保留供检查。\n' "$status" "$ROOT"
exit "$status"
