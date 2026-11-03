# TROOP

TROOP 0.10.2：Rust Core + Electron 桌面应用。提供模型服务配置、流式对话，以及 Windows 本机 Agent 任务、MCP 工具审批、执行账本、停止与核对恢复；保留工作区管理、托盘和单实例。

开发任务：[本机 Agent 规格 #18](https://github.com/Slmplez/TROOP/issues/18)、[实现 #19](https://github.com/Slmplez/TROOP/issues/19)。网关与真实对话验收见 #13–#15，基础版本见 #11/#12。子代理与所属后台作业见[规格 #20](https://github.com/Slmplez/TROOP/issues/20)、[实现 #21](https://github.com/Slmplez/TROOP/issues/21)。记忆与上下文压缩见[规格 #22](https://github.com/Slmplez/TROOP/issues/22)、[实现 #23](https://github.com/Slmplez/TROOP/issues/23)。Skills 与工作流资料库见[实现 #25](https://github.com/Slmplez/TROOP/issues/25)；Windows Hooks 与模型端配方维护见[#26](https://github.com/Slmplez/TROOP/issues/26)、[#27](https://github.com/Slmplez/TROOP/issues/27)；MCP 接线见 [#46](https://github.com/Slmplez/TROOP/issues/46)，桌面管理见 [#47](https://github.com/Slmplez/TROOP/issues/47)，真实服务验收见 #48；自动化留待后续开发。启动不需要 Docker 或产品账号；发送模型请求需要配置你使用的服务。

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

命令以当前 Windows 用户权限运行，可访问工作区外的宿主资源，不是 OS 沙箱；不自动提权。前台命令限时 60 秒，后台命令需单独批准并指定 1–3600 秒时限；stdout/stderr 各保留 3000 字节并标注截断；PowerShell 配置 UTF-8 输出。独立 Worker 管理进程树，显式退出或停止会终止所属后台命令。所有本机工具共用一个执行队列，涵盖重叠目录和共享 Git 元数据的冲突域；外部编辑器不会遵守内部队列，文件工具仍需核对版本。

支持 spawn_agent、start_background、task_status、wait_task、stop_task。子代理独立上下文，提供只读和继承模式；写入仍逐次批准。任务树显示归属、输出、停止和核对入口；后台工作终结并接纳结果前，父任务不显示完成。每棵树最多 8 项作业、子代理深度 2、累计 64 模型步骤和 128 工具；恢复核对后旧作业不自动重放。详见[所属作业规格](docs/implementation/TROOP_OWNED_TASKS_SPEC.md)。

每次任务最多 16 个模型步骤、32 次工具调用，每次响应最多 8 个工具；最多 16 个活动任务，与普通对话合计最多 4 个模型流。没有自动重试或提供方切换。具体接口与恢复规则见[本机 Agent 规格](docs/implementation/TROOP_AGENT_SPEC.md)。

### Agent 记忆与上下文压缩

在“记忆”管理 Agent、项目成员、私有/用户共享/项目共享事实。新 Agent 默认自动提取，合适的根任务完成后会向其所选模型发起额外维护请求，无需逐条确认；每六个合适任务生成阶段记录。高级合成默认关闭，开启后按证据提出变更，再发起独立验证请求；维护记录展示提案、请求次数、状态和手动重试入口。显式事实和遗忘保护不被自动维护覆盖。

任务启动时选择 Agent，同一配置的私有记忆跨任务复用；子代理继承配置和可见范围，但只读子代理不能写记忆。update_state 保存/遗忘，recall_memory 检索。资料只作为上下文，不扩大工具授权。显式编辑和成员撤销会刷新后续模型请求；原历史、摘要与备份中的已知内容不能撤回。

工作上下文约到 96KB 自动压缩，也可点击“在安全边界压缩上下文”。摘要检查点保留覆盖游标和指纹，原始工具/审批账本不删除；每条历史采用有界摘录，摘要不保证无损。输入和子任务完成在安全边界追加，停止或重启不自动接纳旧摘要、请求模型或重放工具。每 Run 最多四次压缩，原模型/工具预算仍累计。普通“对话”是直接模型入口，不使用 Agent 长期记忆。

详见[完整规格](docs/implementation/TROOP_MEMORY_CONTEXT_SPEC.md)与[验收和限制](docs/implementation/TROOP_MEMORY_CONTEXT_VALIDATION.md)。

### Skills 与工作流

在“技能”页新建指令，或预览导入本地 SKILL.md 及辅助文件。默认保存副本；显式 live source 为新任务读取最新来源，旧任务保留原版本。已有 ID 需确认保存新版本，编辑不回写来源。每个 Agent 可独立关闭，关闭或删除后不能继续发现和加载。

任务目标支持 @技能ID、@名称和旧 sand-workflow 链接；也可选择 Agent、服务和工作区后点击 Run Now。模型通过 read_skill/read_skill_file 分页读取配方与辅助文件；脚本仍须批准具体 PowerShell 命令。带 trigger 的定义保留为自动化，不在本版调度。普通对话不接入 Agent 技能。详见[规格](docs/implementation/TROOP_SKILLS_WORKFLOWS_SPEC.md)与[验收](docs/implementation/TROOP_SKILLS_WORKFLOWS_VALIDATION.md)。

### Windows Hooks 与模型端工作流维护

“Hooks”页配置 Windows 本机 command 或使用任务模型服务的 prompt 规则，按 Agent/工作区分配。启用的命令会随事件自动执行，以当前用户权限运行；旧 Linux 与尚未接入的 Tab 事件只能停用保存。MCP 前后事件已接入，共支持 19 项事件。任务页 Hook 账本提供输入、结果、用量、停止状态和效果核对。allow 不绕过原工具审批，ask 会等待具体操作审批；stop/post 错误不会重放已完成工具。修改、停用或删除撤销旧修订；显式停止后不启动新的收尾脚本。

模型可用 update_state target=workflow 的旧 write(name, description, body, id?) / delete(id) 参数维护共享配方。修订冻结在模型请求开始时，用户并发编辑使旧计划失效；资料、文件、结果和事件原子提交，原任务配方快照保留。只读子代理不能写配方或执行 command Hook。

详见[事件、权限和恢复规格](docs/implementation/TROOP_HOOKS_WORKFLOW_STATE_SPEC.md)及[本机与集成验收](docs/implementation/TROOP_HOOKS_WORKFLOW_STATE_VALIDATION.md)。

### MCP 工具

Core 已接入 HTTP/SSE、Windows stdio、服务资料库和 OAuth，以及 Agent 动态工具、具体参数审批、前后 MCP Hooks。任务开始时冻结服务目录与配置；调用前复核权限与版本，超时、停止或崩溃后不自动重放。只读子代理不取得 MCP 执行能力。结果与附件有界入账，模型可分页读取本 Run 的文字归档。

侧栏“MCP”可添加/编辑服务、按 Agent 分配、管理凭据字段与工具禁用名单，预览导入旧配置并查看修订。保存配置不会连接或执行；启用 Windows 命令需确认完整程序、参数和目录。认证区可准备 OAuth，在系统浏览器完成登录，并刷新或断开授权。任务连接区提供调用、文字附件分页和 Session 停止核对；核对后回到任务页手动继续，旧调用不重放。真实第三方服务与默认浏览器兼容由 #48 单独验收。详见 [桌面使用与验收](docs/implementation/TROOP_MCP_DESKTOP.md)和 [Agent 接线](docs/implementation/TROOP_MCP_AGENT.md)。活动派发共用宿主队列；空闲 stdio 服务保留状态，其自主后台行为无法由队列完全串行化，仍是当前用户的非沙箱宿主能力。

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

同一数据目录只允许一个 Core 写入。本版本按版本事务迁移 SQLite schema 1/2/3/4/5/6/7/8/9→10，保留已有工作区、模型服务与会话。旧 Core 会拒绝新版数据库，请使用匹配的桌面/Core，不做降级打开。

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

内部协议为逐行 JSON-RPC，每帧最多 64 KiB，握手版本为 10。非握手调用必须匹配 Core generation，流通知带代际和递增序号；界面读取 Core 持久化快照。最多 64 个未决控制请求。Core 不开放通用网络控制监听，OAuth 授权期间使用临时 loopback 回调；Agent 工具只能经固定任务接口派发，Renderer 没有通用 Shell、文件或 invoke 入口。

SQLite schema 为 10，自动迁移本机 v1/v2/v3/v4/v5/v6/v7/v8/v9 并保留工作区、服务配置和会话；更高版本数据库拒绝打开；不同来源的 Herdr schema 8/9/10 与缺失必要 MCP 表的部分布局在更改数据库前拒绝，统一迁移属于后续版本 11。升级前备份应用数据，升级后不要用旧 Core 写入同一数据目录。开发构建使用带版本号的 Core 文件；运行中的旧窗口保持旧版本，需从托盘明确退出后再启动新版。

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
npm --prefix apps/desktop run smoke:memory
npm --prefix apps/desktop run smoke:skills
npm --prefix apps/desktop run smoke:hooks
npm --prefix apps/desktop run smoke:mcp-agent
npm --prefix apps/desktop run smoke:mcp-management
```

冒烟报告和截图保存在被忽略的 `.tmp-troop-bootstrap/`，`latest-smoke.json` 指向最近一次完整成功结果；HTTP 测试配置在 `.tmp-troop-chat/`。测试使用自有 loopback HTTP/SSE 服务和随机假密钥，不调用商业模型；固定 IPC、Rust、SQLite、Windows 凭据、Renderer、托盘和正式入口使用真实实现。原生目录选择器仍由自有夹具替换。

公开验收使用自有 loopback HTTP/SSE 服务、SQLite、Windows 进程和 Electron，覆盖模型网关、任务、记忆、Skills/Workflows 与 Hooks。验证结果分别见 docs/implementation 中的版本记录；其他环境的配置与运行资料不在公开文档范围。MCP 真实服务兼容、调度、签名安装包及长期负载仍待后续开发或验证。Windows 保持单屏基线，Docker 与整体 UI 优化继续暂停。

### MCP 资料库开发接口

0.8.0 已完成 Core 的 MCP 配置资料库、导入预览、修订与系统凭据；OAuth 和 Agent 工具已分别由 0.9/0.10 接入；MCP 管理页已由 0.10.1 接入。资料库管理不会连接远端或启动配置命令。详见[资料库规格与验收](docs/implementation/TROOP_MCP_LIBRARY.md)。

### MCP OAuth 开发接口

0.9.0 已完成 Core 的 OAuth 登录、刷新与撤销：PKCE/loopback、系统凭据、取消和中断恢复。当前通过自有授权服务验收；0.10 已接入 MCP Agent 工具；浏览器入口已由 0.10.1 接入，0.10.2 已通过 [#48](https://github.com/Slmplez/TROOP/issues/48) 的受测只读链路与默认浏览器验收；到期条件为受控本地设置，未等待自然到期。详见[OAuth 规格与验收](docs/implementation/TROOP_MCP_OAUTH.md)。
