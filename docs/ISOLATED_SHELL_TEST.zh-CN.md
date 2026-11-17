# 隔离 Shell 与原生剪贴板桥验证

这不是安装流程，也不是安全沙箱。临时 HOME/XDG 目录和私有 D-Bus 避免使用正式
GSConnect 配置；仍以同一 Unix 用户连接宿主 Xwayland 显示。不要在测试期间复制
敏感内容、点击 GSConnect 开关、打开 Mobile Settings 或配对。

测试只接受此前已验证的 ZIP，SHA256 为：

```
d445fa3927ec9c43562d2f4cd1d8174634273ed7aa41f0906971dee0b05182cb
```

这是包含原生桥、准入额度、可选字节历史持久化及发送总期限/取消修复的检查点包。
本包的结构、源码一致性和原生加载检查已通过；此前用户实际运行的 Shell/桥测试属于旧包，
不能因此声称这个新包的真实服务或双机验收已通过。
脚本不重新构建、不安装、不替换正式扩展；不要为了通过检查而修改哈希。
必须从当前 GNOME Wayland 桌面的图形终端执行，传入该 ZIP 的绝对路径：

```sh
bash installed-tests/manual/isolated-shell-smoke.sh /absolute/path/to/validated.zip
```

默认仅加载 Shell 扩展。服务 daemon 在**临时副本**中被退出码 77 的安全桩替代，
所以 Mobile Settings 无法打开是预期行为，不是设置功能测试失败。
成功必须结合扩展 `state=1`、`error=''`、错误列表为空判断，不能只看窗口或退出码。
180 秒自动终止的 124 是超时结束，不代表加载失败。整个会话另有 210 秒上限。

## 可选桥测试

测试可能覆盖当前剪贴板；如有需保留的复制内容，请先自行粘贴保存。

```sh
bash installed-tests/manual/isolated-shell-smoke.sh --bridge /absolute/path/to/validated.zip
```

此模式等待 Shell 初始化后，在同一个私有会话内运行 GJS 客户端，通常约 10–20 秒，
客户端有 30 秒上限。不要手动从真实桌面会话调用客户端或复制真实会话总线地址。

客户端在任何剪贴板操作之前验证：

- HOME/XDG/runtime 都属于此次临时目录，地址由参数明确指定并与私有环境一致；
- 当前总线上的 Shell 返回确切临时扩展路径，状态为 ACTIVE；
- GSConnect 名称尚未被占用，不允许替换现有拥有者；
- 剪贴板 portal 的唯一拥有者正是已核验的 Shell；每次调用和清理前都复验
  Shell 与 portal 名称归属，名称丢失或易主时拒绝调用。

随后仅模拟占有 GSConnect 名称，使真实 Shell 创建 portal。不会运行真实 daemon，
不会启动 LAN 后端，不读取原证书/配对，不读取测试 Offer 之前的剪贴板。
每个 Offer 只有含随机 UUID 后缀的专用 MIME（`application/x-gsconnect-isolated-test-…`），数据是固定的 10 字节二进制样本。
测试经过真实 `Offer → GetValue → ValueRequested → Resolve` 路径验证：

1. 二进制字节逐一匹配；
2. Resolve 显式错误能返回；
3. ClearOffer 能取消已出现的异步请求；
4. 每项结束时 Offer 为空，退出时释放模拟名称。

仅客户端退出 0 且出现全部三项 PASS 才代表这三个桥测试通过。超时、无法连接、
仅出现窗口、仅收到信号均不能算通过。返回错误必须是远端错误，客户端超时不会冒充成功。
测试结束会停止本次嵌套 Shell；日志保留于终端打印的临时目录。
可随时回到启动终端按 Ctrl+C；不要用 `killall gnome-shell`。

本模式不测试真实应用 Ctrl+V、大文件、传输进度、网络、配对、设置窗口或双机兼容。
原生 60 秒期限可由客户端的显式 `--deadline` 测试覆盖，但本快速 runner 不开启它；
此前独立原生测试的期限结果不得说成此次桌面期限测试通过。

## 自动检查和当前限制

`python3 -m unittest tests/test_isolated_shell_runner.py` 检查外/内 Shell 语法和关键
安全不变量；ESLint 检查 GJS 客户端。无参数客户端和无参数 runner 必须拒绝运行。
这些离线检查不证明图形会话或真实桥测试已经通过。当前执行器不能连接用户显示 socket，
因此新 `--bridge` 模式需要用户图形终端执行后才能记录实测结果。


本次校验值对应额外修复文件写入完整性的包：新写入路径已通过真实私有临时文件逐字节回读验证；旧包的 Shell/桥接通过记录不能当作此新包的桌面或双机验收。尚未安装此包，仍不代表完整产品验收通过。
