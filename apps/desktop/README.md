# TROOP

TROOP 0.4.0：Rust Core + Electron 桌面应用。提供模型服务配置、流式对话，以及 Windows 本机 Agent 任务、工具审批、执行账本、停止与核对恢复；保留工作区管理、托盘和单实例。

开发任务：[本机 Agent 规格 #18](https://github.com/Slmplez/TROOP/issues/18)、[实现 #19](https://github.com/Slmplez/TROOP/issues/19)。网关与真实对话验收见 #13–#15，基础版本见 #11/#12。子代理与所属后台作业见[规格 #20](https://github.com/Slmplez/TROOP/issues/20)、[实现 #21](https://github.com/Slmplez/TROOP/issues/21)。记忆、Skills、Hooks、MCP 与自动化留待后续开发。启动不需要 Docker 或产品账号；发送模型请求需要配置你使用的服务。

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

企业网络需要代理时，使用当前网络的 npm、Cargo 与 Electron 下载代理配置。模型请求遵循系统/环境代理，loopback 直连；只连接用户选择的模型 endpoint。

## 使用

### 执行本机任务

1. 在“工作区”登记项目文件夹，在“模型”配置服务。
2. 到“任务”选择服务与工作区，输入目标并开始。模型可读取所选工作区；文件写入、PowerShell 命令和 Git 查询需要逐次批准具体操作。
3. 工具记录展示冻结的参数、执行状态和结果。可拒绝某次操作，也可随时停止任务；停止保留已经发生的文件修改和其他效果。
4. “执行账本”可查看历史模型步骤、审批和工具事件。补充指令在下一个安全边界采纳，已经开始的工具不会被普通消息强行中断。
5. 异常退出或显式退出后的未完成任务等待核对，之后手动继续。优先核对 Worker 回执；回执仍无法确定效果时，核对实际效果和相关命令的停止状态并记录说明。已取消或失败的任务不通过“继续”重新激活。

工具包括列目录、UTF-8 文件读取、文字搜索、带 SHA-256 前置条件的文件写入、Windows PowerShell 和 Git 状态查询。文件读写上限 8KB；已有文件先读取取得哈希，新文件使用 `missing`。目录和搜索结果有界并标注截断；拒绝越界路径、Windows 重解析点与直接访问 `.git`。Git 状态使用工作区外的 PATH 程序，禁用 fsmonitor 和子模块递归；因仓库过滤器仍可能执行程序，该查询也必须逐次审批。其他 Git 操作通过审批后的命令执行。

命令以当前 Windows 用户权限运行，可访问工作区外的宿主资源，不是 OS 沙箱；不自动提权。前台命令限时 60 秒，后台命令需单独批准并指定 1–3600 秒时限；，stdout/stderr 各保留 3000 字节并标注截断；PowerShell 配置 UTF-8 输出。独立 Worker 管理进程树，显式退出或停止会终止所属后台命令。所有本机工具共用一个执行队列，涵盖重叠目录和共享 Git 元数据的冲突域；外部编辑器不会遵守内部队列，文件工具仍需核对版本。

支持 spawn_agent、start_background、task_status、wait_task、stop_task。子代理独立上下文，提供只读和继承模式；写入仍逐次批准。任务树显示归属、输出、停止和核对入口；后台工作终结并接纳结果前，父任务不显示完成。每棵树最多 8 项作业、子代理深度 2、累计 64 模型步骤和 128 工具；恢复核对后旧作业不自动重放。详见[所属作业规格](../../docs/implementation/TROOP_OWNED_TASKS_SPEC.md)。

每次任务最多 16 个模型步骤、32 次工具调用，每次响应最多 8 个工具；最多 16 个活动任务，与普通对话合计最多 4 个模型流。没有自动重试或提供方切换。具体接口与恢复规则见[本机 Agent 规格](../../docs/implementation/TROOP_AGENT_SPEC.md)。

### 普通对话

1. 在“模型”页填写服务名称、协议、基础地址、模型 ID 和可选 API 密钥。基础地址例如 `https://api.openai.com/v1`，不包含 `/responses` 等最终接口后缀；实际请求地址会显示在输入框下方。
2. 支持 OpenAI 兼容 Chat Completions、Responses、Anthropic Messages。兼容服务和已运行的 Magpie 可按其接口配置；不自动安装、扫描或启动外部网关。
3. 保存后到“对话”页选择服务并发送。Ctrl+Enter 发送，多行输入保留；生成期间可停止，也可切换到其他对话。
4. API key 保存到当前用户的 Windows 凭据存储，配置文件与 SQLite 不保存明文密钥，保存后不回显。编辑时留空保留；勾选移除后清理原凭据。

Chat Completions 默认使用 `max_completion_tokens`；服务需要旧版参数时，在“更多选项”勾选 `max_tokens`。模型 ID 与能力以你的服务为准；没有自动参数降级、重试或切换提供方。使用 Responses 时显式 `store:false`，本机历史仍按用户操作保存。

单条输入上限 12000 UTF-8 字节，单回复文本上限 24 KB；上下文达到 192 KB 历史限制时要求新建对话，不静默丢弃历史。用量只显示提供方返回的基本 token 字段；停止/中断时可能缺失。消息目前按纯文本显示，Markdown 标记原样保留。

取消、失败或中断的回合保留在历史中，但不隐式加入后续模型上下文。“重新提问”把原问题放回输入框，由你检查后再次发送。发送结果不明时先核对记录；客户端停止不等于供应商已停止计费。每会话最多一个活动生成，全局最多四个。

- 点击“添加工作区”，选择已有目录。列表仅登记名称和位置。
- 重命名只修改登记名称；“移除登记”经确认后从列表移除，保留原目录与文件。
- Core 故障时，界面显示错误。点击“重新连接”启动新 Core、重新读取数据；旧操作不自动重发。超时或中断后应先查看列表核对结果。
- 关闭窗口后应用留在托盘；双击托盘或再次启动可恢复窗口。通过侧栏或托盘中的“退出 TROOP”结束应用。

开发数据默认保存在 `%APPDATA%\TROOP Development\core\troop.sqlite3`，不读取旧产品的数据目录。可用绝对目录建立独立配置：

```powershell
npm --prefix apps/desktop start -- --user-data-dir=E:\TroopData\Development
```

同一数据目录只允许一个 Core 写入。本版本按版本事务迁移 SQLite schema 1/2/3→4，保留已有工作区、模型服务与会话。旧 Core 会拒绝新版数据库，请使用匹配的桌面/Core，不做降级打开。

## 开发结构

| 位置                               | 责任                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `crates/protocol`                  | 有界请求格式、协议版本、方法白名单                      |
| `crates/storage`                   | SQLite migration、独占、工作区、provider 引用与会话历史 |
| `crates/gateway`                   | HTTP/SSE 三协议、超时、用量、凭据存储                   |
| `crates/core`                      | 异步控制与模型事件、生成生命周期；唯一数据库写入者      |
| `apps/desktop/src/entry.cjs`       | Electron 正式入口                                       |
| `apps/desktop/src/main.cjs`        | 窗口、托盘、单实例、原生目录选择与 IPC 校验             |
| `apps/desktop/src/core-client.cjs` | Core 监督、generation、pending、超时与停止              |
| `apps/desktop/src/preload.cjs`     | 固定方法桥接，不暴露通用 invoke 或 Node                 |
| `apps/desktop/renderer`            | React 对话、模型、工作区和连接界面                      |
| `docs/implementation`              | 本次范围、验收与来源记录                                |

内部协议为逐行 JSON-RPC，每帧最多 64 KiB，握手版本为 4。非握手调用必须匹配 Core generation，流通知带代际和递增序号；界面读取 Core 持久化快照。最多 64 个未决控制请求。Core 不开放网络监听；Agent 工具只能经固定任务接口派发，Renderer 没有通用 Shell、文件或 invoke 入口。

SQLite schema 为 4，自动迁移 v1/v2/v3 并保留工作区、服务配置和会话；更高版本数据库拒绝打开。升级前备份应用数据，升级后不要用旧 Core 写入同一数据目录。开发构建使用带版本号的 Core 文件；运行中的旧窗口保持旧版本，需从托盘明确退出后再启动新版。

## 检查

先完成上述依赖准备。图形冒烟需要可用的 Windows 用户桌面，会短暂显示专用测试窗口；仅操作自己的窗口与临时目录。

```powershell
cargo test --offline --locked --workspace
cargo clippy --offline --locked --workspace --all-targets -- -D warnings
npm --prefix apps/desktop run build
npm --prefix apps/desktop test
npm --prefix apps/desktop run format:check
npm --prefix apps/desktop run smoke
npm --prefix apps/desktop run smoke:agent
npm --prefix apps/desktop run smoke:tasks
```

冒烟报告和截图保存在被忽略的 `.tmp-troop-bootstrap/`，`latest-smoke.json` 指向最近一次完整成功结果；HTTP 测试配置在 `.tmp-troop-chat/`。测试使用自有 loopback HTTP/SSE 服务和随机假密钥，不调用商业模型；固定 IPC、Rust、SQLite、Windows 凭据、Renderer、托盘和正式入口使用真实实现。原生目录选择器仍由自有夹具替换。

2026-11-01 已使用用户在应用内保存的 Anthropic Messages 服务，通过真实对话及 Agent 写入→读取→结果总结验收；工具回合保留并回传签名思考块。详见[Agent 验收](../../docs/implementation/TROOP_AGENT_VALIDATION.md)与[对话验收](../../docs/implementation/TROOP_MODEL_GATEWAY_VALIDATION.md)。结论限于此次服务配置，其他真实提供方尚未实测。密钥只在应用内输入，不需要发送到开发聊天。没有签名安装包或干净机器验收。0.4.0 子代理与后台作业新增验收见[所属作业验收](../../docs/implementation/TROOP_OWNED_TASKS_VALIDATION.md)，使用自有服务夹具；下一功能包是记忆与上下文压缩，再按契约接入 Skills、MCP。Windows 保持单屏基线，Docker 与 UI 优化继续暂停。
