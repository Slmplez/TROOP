# TROOP

Rust Core + Electron 桌面应用的首个可运行基础版本。当前提供本机工作区管理、Core 连接与恢复、SQLite 持久化、托盘驻留和明确退出。

开发任务：[规格 #11](https://github.com/Slmplez/TROOP/issues/11)、[实现 #12](https://github.com/Slmplez/TROOP/issues/12)。模型对话、Agent 执行、记忆、Skills、MCP、模型网关与自动化尚未接入。当前应用不需要 Docker、账号或模型密钥。

## 本机启动

以下命令在仓库根目录执行。已验证环境：Windows x64、Node 24.4.1、npm 11.4.2、Rust 1.92.0 MSVC。Rust 构建需要 C++ 编译工具和 Windows SDK。

首次准备需要网络下载公开依赖：

```powershell
cargo fetch --locked
npm --prefix apps/desktop ci --ignore-scripts
npm --prefix apps/desktop run prepare:electron
npm --prefix apps/desktop start
```

依赖和官方 Electron 运行时已经准备好后，日常启动只需：

```powershell
npm --prefix apps/desktop start
```

启动命令先离线编译 Rust Core，再打包 Renderer 并启动独立 Electron。若修改了 Core 且旧实例仍在运行，请从托盘退出后重新构建。未改变的 Core 文件不重复覆盖，第二实例会唤回已有窗口。

企业网络需要代理时，使用当前网络的 npm、Cargo 与 Electron 下载代理配置；运行中的工作区管理本身不访问网络。

## 使用

- 点击“添加工作区”，选择已有目录。列表仅登记名称和位置。
- 重命名只修改登记名称；“移除登记”经确认后从列表移除，保留原目录与文件。
- Core 故障时，界面显示错误。点击“重新连接”启动新 Core、重新读取数据；旧操作不自动重发。超时或中断后应先查看列表核对结果。
- 关闭窗口后应用留在托盘；双击托盘或再次启动可恢复窗口。通过侧栏或托盘中的“退出 TROOP”结束应用。

开发数据默认保存在 `%APPDATA%\TROOP Development\core\troop.sqlite3`，不读取旧产品的数据目录。可用绝对目录建立独立配置：

```powershell
npm --prefix apps/desktop start -- --user-data-dir=E:\TroopData\Development
```

同一数据目录只允许一个 Core 写入。SQLite schema 高于当前版本时拒绝打开；不会尝试降级。

## 开发结构

| 位置 | 责任 |
| --- | --- |
| `crates/protocol` | 有界请求格式、协议版本、方法白名单 |
| `crates/storage` | SQLite migration、数据目录独占、工作区分页与登记 |
| `crates/core` | stdin/stdout RPC 服务；当前唯一数据库写入者 |
| `apps/desktop/src/entry.cjs` | Electron 正式入口 |
| `apps/desktop/src/main.cjs` | 窗口、托盘、单实例、原生目录选择与 IPC 校验 |
| `apps/desktop/src/core-client.cjs` | Core 监督、generation、pending、超时与停止 |
| `apps/desktop/src/preload.cjs` | 固定方法桥接，不暴露通用 invoke 或 Node |
| `apps/desktop/renderer` | React 工作区和连接界面 |
| `docs/implementation` | 本次范围、验收与来源记录 |

内部协议为逐行 JSON-RPC，每帧最多 64 KiB，握手协议版本为 1；非握手调用必须匹配本次 Core generation。请求 ID 不复用，最多 64 个未决请求。Core 不开放网络监听，也不提供 Shell 或任意文件执行方法。

## 检查

先完成上述依赖准备。图形冒烟需要可用的 Windows 用户桌面，会短暂显示专用测试窗口；仅操作自己的窗口与临时目录。

```powershell
cargo test --offline --locked --workspace
cargo clippy --offline --locked --workspace --all-targets -- -D warnings
npm --prefix apps/desktop run build
npm --prefix apps/desktop test
npm --prefix apps/desktop run format:check
npm --prefix apps/desktop run smoke
```

冒烟报告和截图保存在被忽略的 `.tmp-troop-bootstrap/`；`latest-smoke.json` 指向最近一次完整成功结果。目录选择器返回值由测试夹具替换，IPC、Rust、SQLite、Renderer、托盘和正式入口使用真实实现；不能把该项当作人工选择器操作验收。

当前没有签名安装包、完整升级器或干净机器验收。下一功能包是 Rust 内置模型网关与真实流式会话，再接执行账本、工具与已确认的本地集成。Windows 仍采用已确认的单屏基线，Docker 暂停。
