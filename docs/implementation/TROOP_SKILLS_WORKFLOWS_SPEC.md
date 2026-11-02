# Skills 与工作流

TROOP 0.6.0；[父规格 #24](https://github.com/Slmplez/TROOP/issues/24)、[实现 #25](https://github.com/Slmplez/TROOP/issues/25)。承接 #8 已确认的用户共享库、Agent 禁用列表和 Magpie 资料库设计。本版完成本地 Skills/Workflows；Windows Hooks 单列 #26，父规格保持开放。

## 使用

“技能”页选择 Agent，可新建、导入、编辑、删除、启停技能。用户共享一份库，新技能默认启用；managed/plugin 来源经手动导入后成为同样可管理的本地资料，不再有组织锁定。来源类型只记录出处，不授予权限。同 ID 先预览冲突、显式确认后保存新版本；不自动扫描其他应用配置、不移动或回写源文件。

默认导入副本。显式 live source 只支持选定的 Windows 本机文件或目录；新根任务同步最新来源并生成新版本，来源变动/不可用在列表显示。旧任务及其子代理保留原技能版本、指令和辅助文件。编辑 live 条目将其转成副本，新版本保留原出处；恢复 live 需再次预览导入。网络 URL、原商业技能市场和远程下载器不在本版。

支持 SKILL.md，兼容 workflow.md；选择其他 Markdown 文件时仅导入该文件，选择标准入口文件或技能目录时保留目录内辅助文件。排除 .git、node_modules、**pycache**；超过预算明确报错，不静默截断文件树。每包最多 128 文件、256 目录项、8 层、2MB，每文件 256KB。SKILL.md 最多 128KB，正文 100000 字符；UI 编辑最多 48KB，较大内容通过文件导入。库上限 100 活跃技能、1000 历史版本，不自动删除历史以腾空间。

保留原 frontmatter 的简单嵌套 mapping/scalar 解析机制：name、description、id、metadata.source/source、disable-model-invocation、trigger.schedule/enabled；原文和未知字段完整归档，不承诺任意 YAML 特性。unknown allowed-tools、脚本路径或其他元数据不授予权限。名称最多 80 字符、描述 1536 字符；列表描述有界摘录。trigger 定义保留并明确标为自动化，不进入普通技能发现或执行，本版不调度。

## 调用与快照

任务目标和安全边界补充输入支持 @ID、@名称、@无空格名称、sand-workflow:ID 旧链接，最长匹配优先，同名歧义使用 ID。每次输入最多展开四项，每项先提供 8000 字符配方摘录，整体展开文本最多 120KB。Run Now 要求明确 Agent、服务与工作区，通过同一个 agent.start 创建真实任务，而不是仅显示按钮成功。

任务保存技能版本引用、不可用来源清单、配方展开版本及指纹。模型目录提示最多 16KB；完整正文与文件通过 read_skill/read_skill_file 进入正常工具调用账本。正文每页最多 4000 UTF-8 字节，清单每页 32 文件，提供续页游标；二进制返回大小和哈希，原字节仍保存。disable-model-invocation 不进入自动发现，只有显式引用过的技能允许后续读取。普通“对话”仍是直接模型入口，不接入 Agent 技能。

发现、展开和每次工具读取均检查当前 Agent 开关及删除状态；旧历史不能撤回。新导入技能不自动添加进运行中任务的冻结资料库，启用或更新后的新版本供新任务使用。子代理继承父任务的版本引用，维持独立上下文、工具账本与只读权限。已接收输入在安全边界重新检查开关；若预算或定义变化导致不能展开，原输入与可见错误保留，不让领域校验错误终止整个 Core。

辅助文件按不可变数据库版本物化至当前 Core 数据目录的 skill-materialized/<version>，向模型返回明确目录和内容指纹。每次读取前核对已有物化文件，发现变化拒绝并保留现状，不静默覆盖。读取拒绝路径穿越、符号链接和 Windows 重解析点。物化是资料准备，不执行脚本；模型执行辅助 PowerShell 脚本仍通过原 run_command 的具体命令审批、Worker 进程树、停止与结果账本。

本机命令以当前用户权限执行，仍不是 OS 沙箱。目录校验不是对恶意并发宿主程序的完整文件系统隔离；审批的任意命令也可能改变物化文件，不能保证任意外部脚本依赖永不变化。关闭技能不撤回已发送的文字、不撤销已经批准并开始的普通命令，也不清除历史或备份。删除隐藏当前条目并阻止后续加载，旧版本仍用于核对；不承诺物理抹除。

## 存储、接口与后续

内部协议 6，SQLite schema 6；新增 skills、skill_versions、skill_files、skill_disabled，版本、文件和当前指针事务提交。旧数据不回填技能、不自动导入目录、不因重启发出模型请求。编辑/删除使用 expected_revision；导入重新读取并核对预览指纹，输入变化或并发修改均要求重新预览。

固定 IPC：skills.list/preview/import/get/versions/enable/remove/edit/refresh；edit 对不存在 ID 且 expected_revision=0 创建本地技能。原生选择目录由 Electron 主进程提供，Renderer 不获得通用文件或 Shell 通道。agent.start 的可选 workflow_id 用于显式 Run Now；重复 client_run_id 沿用原幂等规则。

本版资料管理通过界面/固定 IPC；模型端 update_state 的 workflow 写入/删除兼容尚未接入，不能声称所有旧工具参数已经完全迁移。Hooks、模型端配方维护、MCP、调度、旧目录批量导入和安装包为后续工作，#24/#9/#10 不因本项关闭。真实模型选择技能的质量和真实远程服务兼容仍需独立验收。
