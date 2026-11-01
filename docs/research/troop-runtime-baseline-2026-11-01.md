# TROOP 迁移：运行、数据与发布依赖基线

日期：2026-11-01。对应任务：[采集当前运行、数据与发布依赖基线](https://github.com/Slmplez/TROOP/issues/2)。

## 结论与证据边界

当前 Windows 包能够启动并挂载界面，类型检查与包结构校验通过；现有 smoke 未完整通过，自动测试入口实际执行零个测试。当前 host/Agent 已接入恢复后的源码生产链，不能再用旧桥接文件的注释断言底层引擎未恢复。构建审计、Electron 外壳、原生模块、部分资源和 Docker 桌面仍有原产品来源依赖。

本次完成的是迁移前置采集，不是功能等价证明、独立构建证明或生产迁移。三类数据样本均为人工生成，通过现有源码的实际 checkpoint/恢复方法获得读写轨迹；没有真实模型执行轨迹、旧用户数据库或加密历史恢复证据。

证据等级：**实测**是本轮执行所得；**结构**是源代码接线或现有包中的清单；**未验证**必须由后续原型或验收补齐。旧清单的 `cleanAccepted` 和历史测试计数不升级为本轮功能测试结果。

## 1. 采集对象

| 项目 | 值 |
|---|---|
| 源码快照 | `710e2f9ee7a42f139a597ce15fc1edb66b77a350`；本次未修改生产代码 |
| 唯一目标远端 | `https://github.com/Slmplez/TROOP.git` |
| 包版本 | `0.18.0-reconstructed.3` |
| 包目录 | `dist/Grok Bot 0.18 Reconstructed-win32-x64` |
| 包内 ASAR SHA-256 | `8e19fdc0337317e7e17012a05dd6a5b307a66f8c4012ae23615427e46ff53b39` |
| 包内与本地 reconstruction-build.json SHA-256 | 均为 `ae49a1bacc6e00ae2fa699cab322b0548cead415febe86f75c774f06bd402646` |
| 包内 host SHA-256，子代理独立核对 | `74f7dad20e8dc6eb3582e50353569bbb7dac7e3ee0e6830fb51cd7d5947ca1f3`，与本地构建 host 字节一致 |
| 默认 Node / npm | `v24.4.1` / `11.4.2`；默认 Node 不符合项目 engines |
| 仓库离线 Node | `offline/vendor/node/win32-x64/node.exe`，实测 `v26.5.0`，符合 `>=26.5.0 <27` |
| Rust 工具 | rustc `1.92.0`、cargo `1.92.0`；只核对版本，未验证链接器或 Windows API 编译 |
| Docker 可用性 | PATH 无命令、常规安装路径无 docker.exe、宿主服务查询无匹配项；未发现可用运行环境，不推断其他位置绝对未安装 |

没有读取个人应用目录、真实会话或凭据。启动 smoke 使用工作区 `.tmp-baseline/` 下新建的空白 profile，临时目录已由 harness 清理。原始本机检查日志留在被忽略的 `.tmp-baseline/`；发布附件只含人工数据、摘要和固定资产指纹。

## 2. 本轮检查

| 操作 | 实际结果 | 可以与不可以据此得出的结论 |
|---|---|---|
| `npm run typecheck` | 默认 Node 下退出 0 | 前端类型检查通过，不是 UI 验收 |
| `npm run source:typecheck` | 默认 Node 下退出 0 | 源码类型检查通过，不是引擎等价证明 |
| `npm test` | 退出 0；tests=0、suites=0、pass=0 | 没有回归覆盖；`tests/` 与 `scripts/fixtures/` 缺失且被忽略 |
| 切换离线 Node 26.5.0 后 `npm run check` | 退出 0；两套类型检查通过，测试仍为 0 | 排除本轮结果仅由默认 Node 版本造成；仍不算回归测试通过 |
| `npm run verify:windows` | 退出 0 | 现有包的身份、哈希、PE/native 文件与清单结构通过校验；未重新构建 |
| 隔离 profile：`node scripts/smoke-windows.mjs --basic`，受限沙箱 | 退出 1，Electron 在 renderer 就绪前退出 `2147483651`，CIM 进程查询被拒绝 | 此轮有环境限制，不能直接归因产品 |
| 同一基本 smoke，在宿主权限环境复核 | 退出 1；renderer 已挂载；选择配置入口失败 | harness 匹配英文 `Configure Proxy-Gateway`，实际按钮为 `配置 Proxy Gateway`。没有通过设置交互全链路 |
| 人工样本采集脚本，Node 26.5.0 | 退出 0，三类样本均通过断言 | 证明指定内存 blob/checkpoint 路径行为；不证明 SQLite、解密、真实推理或 UI 导入 |

完整 `smoke:windows` 的 Docker 和 gateway 本身也有模拟层，其脚本明确不覆盖真实 Docker、VNC、模型回合或 native tool execution。本轮未运行完整 smoke。没有执行 bootstrap、重新打包、安装 Docker、下载镜像或接入远端模型。

## 3. 入口和发布依赖

| 入口/组件 | 已查明事实 | 后续约束 |
|---|---|---|
| `npm run build` | `scripts/build.mjs` 调用 fidelity build，使用原始 renderer payload | 不能把此入口当 TROOP 独立构建 |
| `npm run package:windows` | `scripts/package-windows.mjs` 走 recovered build，再组装、验证 portable | 与通用 build 的 renderer 模式不同；本轮只核对既有包 |
| Vite 开发入口 | `frontend/vite.config.ts` 在 configureServer 读取上游 renderer，并暴露 `/upstream` | dev 可用不证明离线独立来源 |
| main / host / renderer / preloads / coordinator / workers / daemons | 包内清单记录 15 个 `clean-source` runtime | 对应入口结构清晰；功能仍需逐项验收 |
| Electron shell | `artifact-runtime`，来源为固定校验的原 Windows carrier | TROOP 必须使用独立 Electron 打包链和自有身份 |
| Electron deps / native tools | artifact runtime；包保留 `sand-webauthn-signer.exe` 等 | 逐项确认保留功能、替代实现和来源，不以重命名完成迁移 |
| renderer 支持资源 | `frontend/manifests/renderer-runtime-assets.json` 记录原产物来源，审计允许部分 immutable assets | `clean-source renderer` 不等于所有图标、字体、查看器等资源已经独立 |
| Docker 桌面 | 固定 ECR 镜像 digest，启动原 `/exec-daemon/exec-daemon` | 自建镜像和真实桌面 Worker 仍属必需工作 |
| 自有 box daemon | `source/box-exec-daemon/server.ts:737` 声明 `computerUseSupported:false` | 不能用现有协议与服务壳代替桌面控制验收 |
| Windows 本机 | 已有 shell/后台 shell/read/list；宿主桌面后端未发现 | 宿主截图、输入、控制权、锁屏暂停继续单独验证 |

包中 6 个 native 模块：`@anysphere/tree-chunk-napi`、`better-sqlite3`、`cursor-proclist`、`tree-sitter-bash`、`tree-sitter`、`whichlang-node-win32-x64-msvc`。完整路径和 composition 见 [采集结果](troop-runtime-baseline-2026-11-01/probe-results.json)。

portable 自身声明 `distributionSigned:false`、`upstreamShellRetained:true`、`publicReleaseEligible:false`；更新与协议注册已禁用。这些是当前产物标记，不能据此宣称 TROOP 已可发布。商业账号、权益、营销、遥测和私有服务移除范围不变；来源记录及第三方署名需单独保留。

## 4. Agent 接线复核与旧结论修正

子代理只读复核确认以下源码链：

1. `source/host/host-runner-composition.ts:3160` 设置 `productionTurnRunShell`；3165 行仅在它不存在时走旧 `createRunStep`。
2. `source/host/runner/production-turn-run-shell-adapter.ts:191` 创建生产 Agent owner，随后调用 `buildAgentForRun`。
3. `source/host/runner/turn-agent-composition.ts:17` 导入本地 Agent；890 行构造 `AnysphereAgent`。
4. `source/packages/agent/index.ts:40` 已有 Agent 实现，84 行 `runStream`，170 行 `runModelStep`。

现有 ASAR 的 host 记录 `clean-source`；绑定记录 `validated-clean-source`、无未绑定项，记录的 forbidden inputs/references 为空；包中有本地 Agent 模块标记。因此 `runner-production-bridge.ts:51` 关于底层 Agent 尚未独立恢复的注释已过时，不作为当前恢复缺口证据。

仍存在的边界：`scripts/host-production-activation.mjs:504` 默认读取原 host artifact 校验来源；445–460 行的支持判定主要是源码接线、可达性及绑定检查，不能冒充本轮真实模型运行。该文件41行还将 PDF 文本提取标为 fail-closed。引擎迁移风险应描述为**语义等价、恢复与并发尚未实测**，不是“底层构造器不存在”。

## 5. 数据来源清单

| 来源 | 源码事实 | 导入验证必须覆盖 |
|---|---|---|
| Agent 元数据 | `agent-kv/agent-store.ts` 包含 agentId、latestRootBlobId、mode、approvalMode、subagentInfo、blobEncryptionKey | 元数据与根 blob 匹配；密钥缺失/不可用分级报告 |
| protobuf/blob 图 | SHA-256 寻址；ConversationStateStructure 引用 turns、steps、summary、子代理等 | 不只导出显示层文本；保留原 blob、引用和无法识别项 |
| SQLite | `host/storage/store-db.ts` 处理 store.db；`host/agent-isolation/conversation-blob-db.ts` 定义 blobs 表；worker 管理 conversation blobs | SQLite 一致快照与 WAL；分离存储及迁移版本；不能只拷贝单个主文件 |
| 路由会话 JSON | `node-agent-coordinator/inference-router.ts:22` schemaVersion=2；43、81 行每 agent 只保留最近 200 项 | 与原会话库分开识别、去重；不能恢复已经裁剪的内容 |
| 附件/富文本 | SelectedContext 可存图片 blob、嵌入数据或上传引用；UserMessage 有文本/富文本 blob 引用 | 引用存在不代表字节存在；外部引用可用性单独标记 |
| 子代理与未完成态 | inline subagentStates / subagentStateRefs / pendingToolCalls | 保留关系与历史状态，不自动重放副作用或续跑旧执行 |
| 同步元数据 | `agent-store-sync/paths.ts` 有 `.sync`、conflict-events.jsonl、pending 事件文件 | 保留冲突来源和原件；本次未验证同步或冲突合并 |

这是一份源码格式清单，不是用户磁盘数据盘点；本轮没有采集真实用户记录数或密钥。

## 6. 三类人工样本与实测恢复行为

输入与完整 blob 图见 [人工夹具](troop-runtime-baseline-2026-11-01/synthetic-fixtures.json)，操作轨迹与断言结果见 [采集结果](troop-runtime-baseline-2026-11-01/probe-results.json)。每类先 checkpoint、重建 reader、reset、恢复，再删除指定 blob 观察失败行为；修改仅发生在内存副本。

| 样本 | 内容 | 实测结果 |
|---|---|---|
| plain-chat | 1 个用户消息、1 个助手步骤、requestId；4 个 blob | 恢复 1 回合；显示投影不带 requestId，专用 getter 可取回 |
| tool-attachment-summary | Read 工具记录、人工 SVG 附件 blob、摘要；6 个 blob | 工具结果、附件引用、摘要恢复；删除附件内容后对话恢复仍成功，引用保留 |
| subagent-incomplete | 1 个外部子代理状态引用、pendingToolCalls；5 个 blob | 恢复子代理；checkpoint 保留 pending；缺失子代理引用且无 inline fallback 时抛 BlobNotFoundError |

三类均实测：缺失 step 被跳过；缺失 userMessage 导致整回合被跳过。**恢复 API 未抛错不足以判定“完整”。** 后续导入器需要独立遍历依赖、核对缺失计数并显示恢复等级；显示层投影也不能作为无损中间导出格式。

这些是现有源码存储路径的真实调用轨迹，所有消息与工具结果都是人工构造。没有执行 Read 工具、模型调用或子代理任务；没有验证 SQLite 事务、加解密、未知 proto 字段保留、跨版本兼容和 UI 导入。

## 7. 下游任务输入与待补证据

| 下游任务 | 本次可提供 | 收敛前仍需补齐 |
|---|---|---|
| [验证旧历史恢复等级与导入边界](https://github.com/Slmplez/TROOP/issues/3) | 三类无敏感夹具、缺失 blob 行为、格式清单 | SQLite/JSON 跨来源、密钥不可用、损坏/未知格式、重复导入；代表性隔离生成或经授权的脱敏导出；用户评估恢复报告 |
| [确定 Agent 执行状态、恢复和并发契约](https://github.com/Slmplez/TROOP/issues/4) | 已纠正的源码链与 checkpoint 行为 | 受控模型回放或隔离 provider 下的完整工具回合、等待、取消、崩溃和父子唤醒轨迹；人工 blob 夹具不能替代这些轨迹 |
| [验证独立沙箱 Worker 与桌面替代方案](https://github.com/Slmplez/TROOP/issues/7) | 原镜像依赖与 Computer 缺口 | 可访问 Docker/Linux 环境、自有镜像、真实截图/输入与接管闭环 |
| [收敛完整版本规格与独立发布门槛](https://github.com/Slmplez/TROOP/issues/10) | 包指纹、原生来源、零测试与 smoke 失败证据 | 干净检出独立构建、可提交的非零测试、资源来源清单、真实功能验收及签名/安装策略 |

当前无需用户提供真实密钥或私人历史。后续若要声明兼容用户已有数据，需用户指定待兼容版本及授权的脱敏副本；若不能提供，应保留“该数据源兼容未验证”。真实网关验证需要可用测试服务及本地凭据配置，凭据不写入 issue。Docker 缺失是执行环境前提，不是削减沙箱桌面功能的理由。

## 8. 复现

在原重建工作区及其已有依赖/产物上执行，输出仅写 `.tmp-baseline/`：

```powershell
& './offline/vendor/node/win32-x64/node.exe' docs/research/troop-runtime-baseline-2026-11-01/collect.mjs
```

[collect.mjs](troop-runtime-baseline-2026-11-01/collect.mjs) 包含断言、源码指纹和 ASAR 清单采集。文档证据分支只发布本报告及三份附件，不携带旧源码历史、原始安装程序、应用产物或用户数据；因此单独检出该文档分支不能运行采集脚本，需回到上述源码快照并准备已有依赖与产物。

本基线任务可以结束：可执行检查、来源及数据行为已采集，缺失环境与证据已经明确交给对应决策任务。结束采集不表示 M0 全部验收完成，也不表示下游任务可以跳过其原型与用户评估。
