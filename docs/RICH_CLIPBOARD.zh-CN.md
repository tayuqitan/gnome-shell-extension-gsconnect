<!-- SPDX-FileCopyrightText: 2026 GSConnect fork contributors -->
<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# 双机富格式剪贴板（实验分支）

## 状态与适用范围

这是面向两台 GNOME **Wayland** 桌面的实验实现，不是已在 RHEL 10.3 双机验收的发行版。
两端均需安装此 fork 的同一版本、与各自 Mutter ABI 匹配的原生剪贴板桥、配对，并允许剪贴板收发。X11、未升级的 Shell
桥、原版 KDE Connect 客户端仍使用原有文本同步。请先确认 `echo $XDG_SESSION_TYPE`
输出 `wayland`，并记录 `gnome-shell --version`。当前仓库声明支持 GNOME Shell 46–51；
不能仅凭发行版名称判断兼容性，也不要绕过版本检查安装不匹配的版本。

本 fork 为满足双机需求，明确偏离 CONTRIBUTING.md 的“不新增协议”上游贡献规范。
新增私有能力 `gsconnect.clipboard.rich`，仅当双方宣告支持且本地新桥可用时使用；
不改变 `kdeconnect.clipboard` 及其他 KDE Connect 公共包语义。

### 运行时 ABI 前置条件

实机 GJS 1.80 已确认不能通过 JavaScript 重写带 GAsyncReadyCallback 的
`Meta.SelectionSource.read_async` vfunc。此前纯 JS 实现无法加载，Node mock 不能验证这类 GI ABI。
现在由 `native-clipboard/` 的 C GObject 子类处理异步读取、GTask 与输入流，JS 只处理普通信号。
构建说明和真实 GJS smoke test 见该目录 README。桥必须按目标 Mutter 的开发包与 GI namespace 编译，
不能复制其他发行版/ABI 的二进制或手工猜测 C 结构布局。
桥未安装或加载失败时明确保留原有文本同步，不宣称富格式可用；日志给出原生桥缺失原因。
这只是故障隔离，不能算图片/文件功能已修好。须通过真实 GJS 原生桥测试后再进行双机验收。

## 当前行为

- 复制时发送格式清单和文件元信息，不发送图片、富文本或文件正文。
- 接收端提供惰性多 MIME 数据源，应用读取指定格式时才请求对应内容。
- 图片、HTML、RTF、应用提供的其他 MIME 表示保持原始字节，不做格式转换。
  单一表示上限 16 MiB。应用必须能读取发送端提供的格式。
- 文件管理器复制普通文件时，发送文件名和大小；接收端读取 URI 列表时才传文件，
  完成后提供本机缓存文件 URI。Word、Excel 等文件按普通字节流处理。
- 一次最多 128 个普通文件，每个最多 100 GiB；文件传输不用 D-Bus 搬运正文。
  文件夹、符号链接、非本地 URI 暂不支持。跨机“剪切”被转换为复制，不删除源文件。
- 大文件下载使用 GNOME 通知展示已传字节/总量、百分比、完成文件数，并提供取消按钮。
  完成、取消、失败分别显示；进度来自实际成功写入字节，只有传输完整关闭后才报告完成。
- 多个读取者共享一次文件下载，但各自拥有取消状态。取消一个读取者不会取消其他读取者；
  最后一个读取者取消或用户点击传输通知的取消按钮，才停止共享下载。
- 断连、关闭收发或剪贴板换代会撤销待处理请求。请求默认有 1 小时安全期限，可配置为 60 秒至 24 小时。整个多文件粘贴也受此
  总期限限制；期限到达会取消进行中的下载，并阻止后续文件请求。发送端每个请求也使用发送端本地的总期限，
  从读取源数据开始覆盖等待接收连接、TLS 握手和正文写入，最多同时处理 8 个请求。
  慢速大文件应预先在两端提高设置；超时后需重新复制和粘贴，不支持断点续传。
- 文件名禁止路径穿越；接收只接受已有请求和准确长度的 payload；来源文件会验证
  身份、大小和修改时间。不要在传输期间修改源文件：这不是文件系统快照机制。

### 默认模式与实验性 Ctrl+V 门控

原生剪贴板 API 给出的是“数据读取”，不是可信的键盘粘贴事件。
剪贴板历史管理器、预览程序和其他应用也可能请求数据。因此本实现的准确保证是：
**复制/接收 offer 本身不传正文，读取数据时才传正文。**
必须在目标 RHEL 会话验证是否存在预读。默认模式不提供严格的 Ctrl+V 门控。
也不保证 Windows OLE 对象、私有进程句柄或应用专有格式能跨系统无损重建。

### 可选：不合成按键的门控实验

新选项 `experimental-clipboard-paste-gate` 默认关闭。它仅限制远端文件 URI 格式的读取，
不限制图片/文字 MIME。启用后，Shell 独占注册 Ctrl+V；在 GNOME 的 `filter-keybinding`
回调里为当前 offer 与焦点开启短时许可，再返回 true，使 Mutter 将**原始事件**继续交给客户端。
没有虚拟键盘、F24、自动回放或延迟解绑。复制时以及按键前的文件预读直接失败，不排队到下一次粘贴。

该路径已按 GNOME 48 源码与模拟测试检查，**尚无 RHEL 10.3 / Mutter 实机验证，不是验收完成的保证**。
仅原始、非重复的 Ctrl+V 按下可授权；松开键不授权。许可过期、焦点/offer 改变、锁屏/扩展禁用、
抓取冲突或应用抑制快捷键时拒绝读取，不自动退回无门控传输。锁屏/扩展禁用会释放抓取。
应用必须在短时许可内开始读取；长传输开始后使用正常传输期限。右键菜单粘贴、Shift+Insert、
应用自定义快捷键在此模式下不触发文件下载。预读失败会被某些应用缓存，仍需逐个应用实测。

限制：Meta.SelectionSource 不提供读取者身份。许可窗口内的其他程序仍可竞争读取，
不能证明每个请求就是接收到 Ctrl+V 的目标应用，也不保证任意应用会等待大文件传完。
焦点检查不是安全边界；系统虚拟输入也可能被标记为 PHYSICAL，不能认证实体键盘来源。
不能将此实验宣传为防止其他本机会话程序访问剪贴板的隔离机制。

测试机启用（安装本分支 schema 后执行，随后注销重新登录；停用同理）：

```sh
gsettings set org.gnome.Shell.Extensions.GSConnect experimental-clipboard-paste-gate true
# 停用：gsettings set org.gnome.Shell.Extensions.GSConnect experimental-clipboard-paste-gate false
```

实机验收至少包括：按键前后台历史管理器预读无网络正文；Ctrl+V 文件粘贴与进度；
同一 offer 连续粘贴；Ctrl+V release/自动重复不新增许可；焦点切换和锁屏撤销；
快捷键冲突/抑制情况下仍不下载；取消与多文件长传输；禁用扩展后本机正常 Ctrl+V。
记录 `gnome-shell --version`、Mutter 软件包版本、应用名称及日志，不仅记录发行版名称。

实现依据（GNOME 48，其他版本需重新核对）：
[Mutter keybindings.c](https://github.com/GNOME/mutter/blob/gnome-48/src/core/keybindings.c)、
[ShellWM signal](https://github.com/GNOME/gnome-shell/blob/gnome-48/src/shell-wm.c)、
[Shell WindowManager](https://github.com/GNOME/gnome-shell/blob/gnome-48/js/ui/windowManager.js)、
[Clutter current event](https://github.com/GNOME/mutter/blob/gnome-48/clutter/clutter/clutter-main.c)。

## 结构

- `native-clipboard/`：原生 Meta.SelectionSource 子类、GIR/typelib、真实 GJS ABI 测试。
- `src/shell/clipboardNative.js`：可选原生桥加载与 ABI 失败隔离。
- `src/shell/clipboard.js`：惰性源与 Shell 的适配；D-Bus Offer、GetOffer、
  ValueRequested、CancelRequested、Resolve、ClearOffer；所有请求异步，不阻塞 Shell 等待网络。
- `src/service/components/clipboard.js`：桥连接、generation、所有权跟踪、
  二进制读取、远端 offer 回环抑制、超时与取消。Shell 读取者主动取消通过
  CancelRequested 立即通知服务，取消同一下载 token；该链路目前只有模拟验证。
- `src/service/utils/richClipboard.js`：能力协商，offer/request/value/error/clear，
  运行时 hello 就绪握手、请求 ID、来源 ID、格式和文件校验，TLS payload 流式传输。
- `src/service/backends/lan.js`：私有富剪贴板 payload 使用严格限长传输；
  保留旧协议的原有兼容行为。

双方同时复制/握手时，使用 可回绕 uint32 序号（串行数比较）与固定来源标识确定唯一胜者，不依赖
两机时钟同步。并发事件的胜者不一定对应人的主观先后；后续实际复制会推进版本。

不另开未认证 HTTP 文件服务器，也不暴露任意远端路径读取接口。
文件 ID 只能索引当前复制清单。配对链路仍使用 GSConnect 原有认证与加密。

## 构建、安装及回退

依赖和系统包请遵循仓库 CONTRIBUTING.md 与 RHEL 可用软件源。不要修改防火墙、
SELinux 或系统安全设置来掩盖失败。

```sh
npm install

# 先按 native-clipboard/README.md 构建并测试匹配 ABI 的桥。
# 以下以 Meta/libmutter API 17 为例，必须按实机版本选择。
meson setup _build \
  -Dnative_clipboard_build_dir="$PWD/native-clipboard/_build" \
  -Dnative_clipboard_mutter_api=17
meson test -C _build --suite gsconnect:data --suite gsconnect:lint --print-errorlogs
ninja -C _build make-zip
```

打包会将原生桥通过 Meson 安装到临时 DESTDIR（不是系统或桌面），去掉构建期 RPATH，
并核验 GIR/SONAME/Mutter ABI。ZIP 包内必须包含 typelib、真实 `.so.0` 文件和哈希清单；
打包后自动检查缺件、符号链接、路径穿越、重复项及字节哈希，失败时删除本次无效 ZIP。
不指定 `native_clipboard_build_dir` 则明确生成仅文本能力的包。
旧的手工复制 `src/native` 方法不再参与打包，避免悄悄混入旧 ABI 的二进制。
这些结构检查不等于真实 GNOME 会话验收。

先保存当前插件版本/安装包，再在两台机器安装构建出的
`_build/gsconnect@andyholmes.github.io.zip`。按 GNOME 扩展正常流程安装并注销重新登录，
以加载 Shell 桥改动。不要仅重启服务就认为 Shell 代码也更新了。
若失败，恢复原版安装包并重新登录；公共文本同步协议没有迁移要求。

### 调整大文件安全期限

每个设备的 Clipboard 插件有 `rich-transfer-timeout` 无符号整数键，范围 60–86400 秒，
默认 3600。用 dconf-editor 在该设备的 `plugin/clipboard/` 路径调整，或（替换实际设备ID）：

```sh
gsettings set 'org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard:/org/gnome/shell/extensions/gsconnect/device/实际设备ID/plugin/clipboard/' rich-transfer-timeout 21600
```

需要使用已安装本分支的 schema（用户级安装可按项目方式设置 GSETTINGS_SCHEMA_DIR）。
这是可配置的**总期限**，不是按传输进度续期的空闲超时；提高期限也会延长失败请求的
最长等待时间。接收端配置限制整次粘贴，发送端配置另外限制每个被请求的 payload；
两端配置不同，任一端先到期限都可能终止传输。默认值不可保证任意大文件都传完。
取消/期限信号会传到源读取、连接、TLS 握手和正文 I/O；槽位/写入占用要等进行中的操作结束后释放，
不会仅靠计时器提前宣布完成。资源关闭使用独立的有界清理，不复用已取消的请求 token。

对于未知、过期或不允许的本分支富剪贴板 payload，拒绝路径直接丢弃，不再为了“拒绝”
主动连接对端指定的端口，避免无效包制造额外连接。旧 KDE Connect 协议行为保持不变。
新发送端由自己的总期限回收无人接收的请求；旧实验版本没有此修复，需双方更新后才能依赖该保证。
这些限制降低资源长期占用风险，不是对已配对恶意设备的完整拒绝服务防护。

## 验证清单

本分支的 Node mock 测试不代替 GJS、Mutter、GObject introspection 和真实 TLS 验证。
尤其要验证自定义 Meta.SelectionSource 的异步 vfunc 和 GTask 的结果生命周期。

```sh
node --test installed-tests/node/*.mjs tests/*.test.mjs tests/*.test.cjs
./node_modules/.bin/eslint src/
```

双机验收至少包括：

1. 双向文本；PNG 截图粘贴到支持图片的编辑器；HTML/RTF 粘贴到 LibreOffice。
2. `.docx`、`.xlsx`、零字节文件、Unicode 文件名、重名多文件；目标文件 SHA-256
   与源文件相同。应用内复制表格与复制 `.xlsx` 文件要分别测试。
3. 大文件复制后不操作，观测网络无正文；再 Ctrl+V，观测传输并校验结果。
   启用/禁用剪贴板历史功能分别测试，确认有无预读。
4. 传输中再次复制、断开网络、关闭收发、重新配对、注销登录；不存在旧内容覆盖新内容。
5. 修改/删除源文件、超时、磁盘满、无权限、符号链接及目录复制，确认失败而非部分文件
   当作完成。非法文件名、大小、请求 ID、超量/截断 payload 的测试也需保留。
6. 与未修改客户端配对，验证文本回退及原有功能不变。

## 缓存与已知限制

本集成分支的新文件下载保存在用户缓存目录的 `gsconnect/clipboard-cache-v2/`
（通常为 `~/.cache/gsconnect/clipboard-cache-v2/`，实际由 `XDG_CACHE_HOME` 决定）。
事务和文件子目录权限为 0700。旧版 `gsconnect/clipboard/` 不迁移、不删除，
也**不计入 v2 下载额度**；如果升级前已有旧缓存，它仍会额外占用磁盘。

历史窗口中的“本机共享下载额度 GiB”控制本机所有配对设备共用的 v2 下载准入额度，
不是每台对方设备独占一份；另一台电脑需要在自己的设置中单独调整。默认 10 GiB，
可设置 0–1024 GiB；0 禁止新文件下载。历史条数/MiB 限制与此额度相互独立。

每批文件开始写入前，程序扫描 v2 现有内容，检查剩余空间并预留整批额度。
记账按文件逻辑大小（每个文件至少 4 KiB）及目录开销估算，不是精确的物理块占用。
**这是下载准入控制，不是内核强制的磁盘上限**：其他程序仍能写满磁盘，已交给应用的
缓存文件也可能被追加变大；下次新下载或“检查磁盘用量”时会重新核算。
降低额度不会删除已有文件，超额时只拒绝新下载；检查用量也不会触发删除。

成功下载并交给应用的文件会一直保留，剪贴板变化、清空历史或服务重启都不会自动删除它们。
目前没有成功缓存的自动回收、到期策略或一键清理功能。失败或取消的下载等待写入停止后，
只尝试回滚本次从未交给应用的事务；失败清理继续计入额度。
“重试清理失败下载”仅重试本会话已登记的失败回滚，不清理成功下载、重启前遗留文件或源文件。
重启时 v2 中的已有文件（含未完成残留）保守计入额度，不凭猜测删除。

若需要人工腾出空间，应先确认所有相关应用已不再使用这些文件，并把需要长期保留的内容
另存到普通目录。不要把缓存当作唯一长期副本，也不要在粘贴或应用仍读取时删除缓存。

当前无目录递归、无 FUSE 文件系统、无断点续传、无格式转换器。
上面的数量/尺寸/超时限制是硬上限，不代表可用磁盘、网络或目标应用能处理该规模。


## 双端剪贴板历史

两台机器安装同版后，在各自 GSConnect 设备菜单打开 **Clipboard History**。
自定义过菜单动作列表的用户需把该动作加入菜单（或绑定设备动作快捷键）。列表标记
“本机复制”或“对方传入 · 设备名”，显示格式/文件名与时间，不预览文本、图片内容。
点击“恢复”后到目标应用按 Ctrl+V。恢复本身不自动向目标应用输入内容。

历史窗口可设置 **0–1000 条记录**和 **0–1024 MiB 快照容量**，默认 50 条、64 MiB。
设为 0 可禁用/清空历史。可删除单条或清空；配置分别保存在两台机器对应设备的设置中。
默认历史只在服务进程本次会话内保留，退出/重启后消失。可手动开启下述有限的字节历史持久化，默认不会写入磁盘。
已有文件粘贴缓存仍遵循上面的缓存说明，清空历史不是安全擦除磁盘缓存。

- 本机的普通 MIME 在本地做有界字节快照，不为历史在网络预传正文。
- 本机复制文件只保存路径与文件身份/大小/修改时间的租约，不读取文件正文。
  文件仍在且未修改时，旧历史可以继续响应对方按需请求。
- 对方传入的记录先保存元信息，只有实际读取/粘贴后才缓存正文或本机文件 URI。
  尚未缓存的记录需要源设备在线、仍保留历史租约；过期、删除、替换或修改的源文件
  会失败，不会偷偷读取新路径或把不完整下载当作成功。
- 超过容量的快照会被淘汰。大文件缓存超过历史预算时保留元信息，可能需要再次请求源端。
  历史预算不等于 `gsconnect/clipboard-cache-v2/` 的下载准入额度；旧版缓存也不计入新额度。
- 已缓存的普通字节快照可离线恢复；未下载的远端文件不可凭元信息离线恢复。
  缓存文件仍是本机文件引用，不是不可变文件系统快照。

已标记为 password/secret/sensitive 的剪贴板格式不进入历史；不过纯文本密码和普通文本
无法可靠区分。会话内存也可能含敏感信息，请按需减小容量、禁用或清空历史。


### 可选字节历史持久化（默认关闭）

历史窗口中可手动勾选“将字节历史保存到本机磁盘（明文，默认关闭）”。
这会保存当前及后续符合条件的已缓存文字、图片等普通 MIME 字节快照；本机/对方来源、
设备显示名和时间也会保留。重启后可离线恢复这些字节，不请求上一次会话的远端租约。
开启前请注意：普通文本里的密码无法可靠识别，快照是**明文**，不是加密保险箱。
已标记 password/secret/sensitive 或文件/URI 类型的整条记录不会保存。

这是第一阶段的字节历史持久化：**文件记录、文件路径/URI、源文件句柄、未缓存远端记录
和旧网络租约均不跨重启保存**。已有下载文件仍按 v2 缓存规则保留，但不因此出现在重启后的历史中。
会话内历史条数/MiB 限制保持不变。持久化另受 8 MiB 总正文、16 MiB JSON 文件上限保护，
优先保留最新可容纳的完整记录，单条或累计超额的内容仍可在本次会话内使用，但不落盘。
这不是把界面设置的全部历史容量都保证持久化。

每台电脑、每个配对设备分别保存到用户数据目录的
`gsconnect/clipboard-history-v1/<设备ID的SHA-256>/history.json`，通常位于 `~/.local/share/`，
实际由 `XDG_DATA_HOME` 决定。专用目录 0700、文件 0600；使用无备份的原子替换。
不会写出剪贴板源路径，也不会为了记录历史提前传输文件。
磁盘历史容量与 v2 文件下载准入额度独立；多台设备各自的快照会累计占用空间。

清空或删除历史会同步更新磁盘快照；关闭保存会尝试清除本设备快照，但保留内存历史。
删除不等于安全擦除，备份、快照或文件系统可能保留旧内容。写入/清除失败时界面状态会提示，
不能声称旧磁盘记录已经消失。损坏、超大或权限异常的文件不会被自动载入或覆盖；需检查后处理。
正常关闭服务会先保存并停止监听，再清理内存，不会因退出把磁盘快照误删。
注意：若停服务后用外部工具把保存开关改为关闭，下次启动不会读写磁盘历史，也不会清除旧文件；
这不等于已删除历史。需要在运行中的设置界面关闭并确认清除成功，或检查该设备的快照文件后处理。
该路径目前通过隔离 Node/GJS 测试，真实 GNOME 界面及双机行为仍需验收。
