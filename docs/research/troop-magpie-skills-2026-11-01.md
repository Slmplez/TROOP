# TROOP：Magpie Skills 固定版本研究

日期：2026-11-01。对象：yetone/magpie，固定提交 `1fac66c06d11de9e4232270862da0fa0a3ad90f6`。性质：只读源码与测试研究；未运行 Magpie、未安装依赖、未操作 Docker。本文建议未获用户采纳，不是已确认设计。

## 结论

最值得借鉴的是全局技能库、导入前探测、来源与版本记录、区分用户文件和管理文件、更新保护及可解释状态。Magpie 在本研究所跟踪的 Skills 路径中把文件分发给外部 Agent，由 Agent 读取；其目标目录由适配器声明，不能把它当作 TROOP Rust Core 的统一技能执行器或授权系统。[目标接口与目录][targets] [分发实现][sync-skills]

TROOP 的前提（来自本轮研究任务，不是从 Magpie 推导）：保留自动记忆及 Agent / 用户 / 项目记忆作用域；技能采用用户全局库和每 Agent 禁用清单；保留 `@workflow` 与 Run Now。下文围绕这些前提提出借用、改造与不采用项。

## 已核实事实

| 维度 | 固定提交的实际实现 | TROOP 含义 |
| --- | --- | --- |
| 存储 | `library.json` 记录 `Skills`；库目录是 settings 下的 `library`，技能文件在 `library/skills/<name>`。记录包含 Source、Agents、Hash、Commit、Own、OffHere、Called。[库结构][library] [技能结构][model] | 库资产与有效技能集合分开；来源、内容版本和显示名称应分别建模。 |
| 分配模型 | Magpie 为每个技能保存 Agent 正向名单；`gives` 为“名单包含该 Agent 且非 OffHere”。OffHere 是当前计算机的开关，注释声明不参与跨机同步。[模型与判断][model] | 与 TROOP 每 Agent 禁用清单不同，不应原样复制数据语义。 |
| 全局分发 | 通过适配器目标目录写链接；Windows 链接失败时复制并留下标记。已标记副本用内容哈希及标记时间判断新旧。[链接与副本][link] [分发][sync-skills] | Windows 需明确副本生命周期；路径存在不等于已加载、已启用或已授权。 |
| 本机来源 | 本地文件夹安装先尝试链接，失败时复制；因此链接模式编辑原目录就编辑了库技能。[安装][install] | 导入模式需要在 UI 明示“引用原目录”还是“复制快照”。 |
| 已有技能发现 | 先扫库目录中未登记项，再扫 `~/.agents/skills`，再扫 Agent 目录；按名字及真实路径/文件树区分同一份、相同副本和不同内容。Claude Desktop 的 manifest 技能不进入此扫描。[已有技能发现][found] | 借鉴“发现”和“已入库”两个状态，避免把发现直接当自动激活。 |
| 导入语义 | 已在共享目录或外部链接指向的技能保留原位并建立库链接；普通自有文件夹可能被移动进库。原来持有它及相同副本的 Agent 被记入名单。[导入][import] | “Import”可能具有迁移副作用；TROOP 建议默认复制并给出可审阅差异，而非默默移动用户文件。 |
| 项目 | Project 保存目录、复制选项、按技能分配的 Agent 名单与写入记录；将全局库技能投放到各 Agent 的项目目录，并维护 gitignore。只删除自己记录且仍可认定归属自己的条目；遇到非管理内容报冲突并保留。[项目模型][projects-model] [项目同步][projects-sync] | 这是全局库的项目投放，不是项目共享记忆；两者不可混用。 |

### 发现、frontmatter 和名称优先级

- 探测支持 GitHub、其他 Git 仓库、本机绝对路径；粘贴 `npx skills add …` 等命令时只解析来源字符串，再走自己的探测路径，并未在该函数中执行粘贴命令。[命令解析与探测][probe]
- 候选扫描从指定目录向下最多 4 层，跳过 node_modules；隐藏目录只探测其 skills 子目录。遇到 SKILL.md 通常停止下探，但有至少两个直接子技能的集合会把路由技能及子技能都列出。[候选发现][candidates]
- 本实现用于元数据展示和命名的 YAML 结构只有 name、description。读取文件成功就认为存在候选；解析 frontmatter 的 YAML 错误被忽略；description 被折叠为空白分隔文本。因此它不是完整 Skill schema 验证器，也没有在此层兑现 allowed-tools、user-invocable 或 disable-model-invocation 等执行约束。[元数据解析][meta]
- name 可安全映射为文件名时优先用 frontmatter name；否则用文件夹名，仓库顶层技能用仓库名。安全化仅保留 ASCII 字母、数字、下划线和连字符，最多 64 字节；如果会丢失非 ASCII 字母/数字，优先退回目录名。[命名][meta]
- 单次候选列表按名称或末级路径去重：非隐藏路径优先，其次更浅路径，之后先出现的项。**这是导入候选优先级，不是运行时项目/用户/Agent 指令优先级。**[候选列表][candidates] [候选排序][dedupe]
- 库内同名远程技能可用新名字并列保存，并修改复制进库的 SKILL.md 顶层 name；本地文件夹同名时拒绝，要求用户先改名。Agent 原有同名不同内容不会被同步直接覆盖，而会报告问题并交给显式选择路径处理。[安装冲突][install] [frontmatter 改名][rename] [Agent 冲突][agent-conflict]

### 实际可见性不等于勾选状态

共享目录是重要例外。同步逻辑明确承认：Agent 若也读取 `~/.agents/skills`，就可能已经获得放在共享目录中的技能，即使没有勾选；它会避免再创建重复链接。相关测试明确检查 Codex/Gemini 的 `Always` 状态，而非证明取消勾选能隔离它们。[共享可见性][shared] [共享测试][shared-test]

还存在一处静态不一致：OffHere 的注释与 UI 声称“本机没有 Agent 获得它”，全局 `gives` 确实过滤该字段；但项目 `syncProject` 构建 wanted 时只判断技能是否存在及 ProjectSkillsDir，没有调用 gives 或读取 OffHere。因此已有项目投放可能继续存在/生成。此处是源码路径推断，未运行复现，不能把注释当成已验证的全路径保证。[OffHere 模型][model] [UI 声明][off-ui] [项目判断][projects-sync]

### 调用、权限与安全边界

在被追踪的库安装/同步路径中，技能作为 SKILL.md 及附件文件复制或链接；没有从上述解析器得到一个统一的调用策略。会话测试分别读取外部 Agent 的技能工具调用、slash 命令、prompt 中的技能片段等历史格式。这些测试验证“统计识别”，不证明 Magpie 统一决定何时加载或执行技能。[安装][install] [Agent 目标][targets] [会话调用统计测试][usage-tests]

拉取层有具体防护：Git 地址拒绝前导 `-`、自定义 transport、URL 密码/令牌，引用与路径有校验；Git 以参数数组执行，关闭 ext transport、禁止 checkout 将仓库链接当真实 symlink，关闭终端交互，并复用用户 Git/SSH 凭据。非 GitHub 仓库通过 init / fetch / checkout 获得，删除 .git 后检查大小。这是拉取防护与用户凭据环境，不是任意脚本沙箱。[Git 地址校验][git-input] [Git 执行环境][git-run] [Git 获取][git-fetch]

GitHub tar 解包仅处理目录与普通文件，限制展开总大小，并检查目标路径留在下载目录；不处理 tar 的链接条目。与之不同，本机文件树复制会重建 symlink，所以不能由 tar 路径检查推断所有来源都不能指向库外文件。[解包][untar] [本机复制][copy]

**研究判断：**未在所读 Skills 层发现统一的技能内容可信度验证、完整 frontmatter 权限落实或工具级授权策略；不能由“已导入”“已安装”推导“脚本可自动运行”。本判断限于本文所列路径，非全仓库安全审计。[元数据层][meta] [安装层][install] [分发层][sync-skills]

### 刷新与本地修改

- 自动检查由 Skills 页面触发：后端在本进程未检查或超过 12 小时时返回 CheckDue，页面绘制后发起 check。它是检查可更新状态；实际更新另走 UpdateSkill/UpdateSkills，不能描述为每 12 小时自动覆盖文件。[检查节奏][check-due] [页面触发][check-ui] [更新入口][update]
- 技能保留文件哈希及来源版本。GitHub 检查可以按技能目录最后提交判断，尚无可比较提交时取文件核对；测试覆盖 current、update、unknown 以及 API 限流。[检查测试][check-tests]
- 单项更新遇到本地修改且未传 replace 时拒绝，下载完成后还会再查一次修改；批量更新跳过本地修改，报告 Unupdated，继续处理其他项。更新先准备 .next，再替换旧目录；需保护的旧版本进入备份。[更新流程][update] [替换流程][apply] [更新保护测试][edited-tests]
- Agent 的管理副本被编辑后，同步按文件时间选择最新编辑吸收进全局库，再向其他 Agent 分发；库更新较新时库获胜，落败修改进入备份。这是具体的自动回流策略，不是内容合并或作用域隔离。[副本编辑回流][edits]
- 依赖产物（node_modules、venv、缓存、若干 lockfile）不按普通用户编辑判断，更新时尝试携带到新版本。[依赖产物策略][dependencies] 这不代表经过验证的依赖重用安全或可复现构建。

### 归属与移除

归属判断主要是“链接目标是库技能目录”或“目录内存在管理标记”，不是操作系统权限边界。移除已登记技能时，库内实体目录移入备份，指向用户文件夹的库链接只取消链接，成功后才删登记和项目分配。移除发现的技能则处理同一真实文件夹及相同副本、共享目录条目和库中的未登记条目：链接移除、实体目录备份；指向其他外部目录的目标不因此删除，同名不同内容不属于该组。[归属判断][ownership] [已登记移除][remove] [发现项移除][remove-found]

这些归属/备份机制可供导入撤销借鉴，但不应让管理标记成为执行权限凭据；同样，文件复制完成与外部 Agent 已刷新缓存须分别展示。后者未由上述同步函数或统计测试证明。[归属判断][ownership] [分发实现][sync-skills] [统计测试][usage-tests]

## 对 TROOP 的建议（待讨论，非已确认决策）

| 取向 | 建议 | 依据及适配理由 |
| --- | --- | --- |
| 借用 | 用户全局库统一保存资产；列表展示来源、固定版本/哈希、本地修改、缺失与检查失败。导入先 probe，再预览候选与冲突。 | 来源、候选和更新状态已经在源代码中分别建模。[技能结构][model] [探测][probe] [更新测试][check-tests] |
| 改造 | Rust Core 计算 effective skills：用户库中已认可资产，扣除目标 Agent 的 disabled IDs，再应用项目边界；Electron 展示结果与原因。以稳定 ID 标识技能，名称仅作显示与调用别名。 | Magpie 正向名单和文件系统共享可见性并不能提供该语义；同名远程资产还可能被改写 name。[模型][model] [共享路径][shared] [命名冲突][install] |
| 改造 | 将资产更新、Agent 启用状态、当前执行已加载版本分开；在安全边界加载新版本，保留 Run 的技能内容版本。 | Magpie 更新替换共享目录并保持链接，说明文件分发与执行时版本快照是不同问题。[替换][apply] |
| 改造 | 保留 Grok Bot 已有调用和 frontmatter 语义，迁入 Rust 时补充受检 schema 与未知字段保留；明确自动匹配/手动调用标志在 Rust 中的实际执行意义。导入和技能指令不能授予额外工具权限，脚本调用仍走 ToolInvocation 现有策略。 | Magpie 元数据解析只有 name/description；拉取防护不等于脚本权限。[解析][meta] [Git 边界][git-run] |
| 保留 | `@workflow` 与 Run Now 进入现有工作流/执行入口；技能可被工作流引用，但不因技能文件夹存在就转换成自动化或定时规则。 | Magpie 的库分发及会话统计不能作为 TROOP 工作流运行语义的依据。[分发][sync-skills] [统计测试][usage-tests] |
| 保留 | 自动记忆继续在 Agent / 用户 / 项目三个记忆作用域管理，带归属与读写边界；技能库是程序性指令/资源资产，不替代记忆，也不把 Project 的技能投放表当项目记忆。 | Magpie Project 实际记录的是技能/服务器投放及管理写入。[项目结构][projects-model] 本项作用域要求来自本轮研究约束。 |
| 不采用 | 不以取消目录链接或 UI 勾选作为唯一禁用实现；Rust 在自动匹配、手动加载和工作流调用时都应落实 disabled 规则，并说明无法控制的外部 Agent 目录。 | 已有共享目录 always 例外；OffHere 的项目路径也未覆盖。[共享测试][shared-test] [项目同步][projects-sync] |
| 不采用 | 不默默移动用户文件、不默认让 Agent 编辑副本回流覆盖全局库；推荐显式“保存为新修订/提议更新”，比较后接纳。 | 源码有 import move 和按时间传播到其他 Agent 的行为；这会把 Agent 私有意图变成全局变更。[导入][import] [回流][edits] |
| 不采用 | 不仅按目录名/显示名去重，不照搬“依赖缓存随更新搬运”作为默认策略；按源 ID、子路径、内容版本保留不同资产，依赖另放受控运行目录。 | 当前候选去重可能折叠同名项，依赖沿用属于具体启发式。[去重][dedupe] [依赖策略][dependencies] |

## 测试证据与未验证项

已读取测试，**本次没有执行这些测试**：

- 共享目录导入、保留原始目录、去重复链接、Always 可见性：[TestSharedAgentsSkills][shared-test]。
- 本地编辑、批量跳过、明确替换备份、Agent 副本修改、未知旧版本保留：[skill_changed_test.go][edited-tests]。
- 使用临时 Git 仓库的安装/检查/更新及本地修改拒绝；地址/transport 防护：[Git 测试][git-tests]。
- 模拟 HTTP 的 GitHub 更新检查、差异与限流：[check 测试][check-tests]。
- 非 ASCII 名称回退测试：[name 测试][names-tests]。
- 外部 Agent 调用记录的统计测试（不能证明实际模型采纳技能）：[会话测试][usage-tests]。

仍需独立验证：真实 Windows 权限下 symlink/junction/copy 行为；外部 Agent 对项目/全局同名技能的优先级与缓存刷新；OffHere 加项目投放的 UI 端到端结果；恶意本机 symlink 的信任边界；源仓库不可达、下载中断、写入中断与并发编辑恢复。本文没有承诺这些已通过。

## 固定版本来源

以下链接全部固定到同一提交，行号从 GitHub fetch_file 返回的完整文件逐行计数。

[targets]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/targets.go#L26-L46
[library]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/library.go#L24-L77
[model]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L31-L91
[link]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L199-L239
[sync-skills]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L545-L707
[install]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L1321-L1444
[found]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L2030-L2104
[import]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L2199-L2266
[projects-model]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/projects.go#L16-L81
[projects-sync]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/projects.go#L109-L211
[probe]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L1117-L1226
[candidates]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L999-L1057
[meta]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L122-L194
[dedupe]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L1090-L1114
[rename]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skill_beside.go#L128-L164
[agent-conflict]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L686-L707
[shared]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L554-L586
[shared-test]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/shared_skills_test.go#L25-L134
[off-ui]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gui/assets/plugins/library/client.js#L5229-L5243
[usage-tests]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/sessions/agent_skills_test.go#L11-L153
[git-input]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skillgit.go#L58-L133
[git-run]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skillgit.go#L197-L237
[git-fetch]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skillgit.go#L307-L354
[untar]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L947-L997
[copy]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L2370-L2412
[check-due]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skillcheck.go#L89-L106
[check-ui]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/gui/assets/plugins/library/client.js#L3315-L3337
[update]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L1452-L1587
[apply]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L1721-L1785
[check-tests]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skillcheck_test.go#L18-L171
[edited-tests]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skill_changed_test.go#L59-L184
[edits]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skill_edits.go#L3-L126
[dependencies]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skill_changed.go#L14-L75
[git-tests]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skillgit_test.go#L120-L270
[names-tests]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skill_names_test.go#L54-L157
[ownership]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L199-L218
[remove]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L1847-L1915
[remove-found]: https://github.com/yetone/magpie/blob/1fac66c06d11de9e4232270862da0fa0a3ad90f6/internal/library/skills.go#L2269-L2365
