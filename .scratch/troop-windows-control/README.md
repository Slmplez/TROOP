# Windows 宿主控制原型

一次性设计与可行性原型，2026-11-01。[验证 Windows 本机控制与人工接管闭环](https://github.com/Slmplez/TROOP/issues/6)是唯一任务状态源。本目录不是生产控制后端，不改变用户系统配置，不操作其他软件或 UAC。

## 当前答案

用户已确认交互基线：**失去目标焦点即暂停；回来后重新观察；停止撤销当前任务授权；解锁不重放旧动作。** 保留之前的双桌面、任务授权、可见状态和人工处理安全确认约定。

Rust 原生输入、Electron 定向捕获、真实锁屏取消和捕获恢复均有本机证据。第五轮补齐 12 项自动控制演练、捕获阻塞时的真实停止热键/按钮、独立进程锁屏恢复以及真实管理员目标拒绝。**用户现确认本期保持单屏、100% 缩放，多屏与混合 DPI 暂缓**。当前范围的架构可行性可收口；正式实现的稳定性、遮挡和集成仍需开发验收。最新状态以 [验证矩阵](VALIDATION_MATRIX.md) 为准，下文各轮保留历史语境。

## 运行

纯交互模型：双击 [control.prototype.html](control.prototype.html)，没有联网、安装或真实桌面操作。六个引导场景覆盖正常执行、停止、失焦接管、模拟锁屏、旧画面/权限、结果不明/断开。状态只在内存中。

真实 Rust 测试窗：在仓库根目录运行：

```powershell
./.scratch/troop-windows-control/run.ps1
```

前提：Rust MSVC 工具链及链接器、Cargo.lock 对应依赖已在本机缓存。脚本离线编译。窗口可见，只有窗口自身的标记与文本框可作为输入目标，没有接受任意 HWND、路径、坐标或文本的控制接口。

点击“运行 7 秒受控演练”可复现基本操作；该演练结束会关闭测试窗口。也可自由操作“授权并观察 → 延迟动作 → 立即停止”，或切换窗口后返回。**请保持测试窗在前台以验证输入成功；切到其他窗口本来就应触发暂停。** Ctrl+Shift+F12 只有注册成功时才显示可用；停止按钮始终保留。

人工文本固定为 `TROOP 中文 ✓`，不访问剪贴板。日志与自建窗口 GDI 样图写到 `.tmp-host-control/manual-时间/`。模拟锁定不会真正锁屏；真实锁屏必须由用户在方便时操作。

新增“锁屏演练：授权并排队 60 秒”按钮，一次操作完成当前测试任务授权、观察并加入一个延迟点击。先确认顶部授权=true、队列=1，再由用户手动锁屏；任何失焦、会话不可用或锁屏通知都会使队列失效。它不会自动锁定系统；若 60 秒内没有中断且仍满足门禁，最多点击一次自身标记。

为避免与“7 秒演练”混淆，可运行 `./.scratch/troop-windows-control/run.ps1 -LockProbe` 打开只有开始与停止入口的专用页面。

Electron 捕获对照：

```powershell
./.scratch/troop-windows-control/run-capture.ps1
```

枚举不生成缩略图，只对指定原型 HWND 且标题匹配的窗口请求媒体帧，目标关闭后再次核对不可用。此脚本复用本工作区已有 Electron 载体到隔离临时目录，只打包本轮新写的 app.asar，不加载旧应用代码；这不是独立发布门禁通过。第三方许可文件随本地载体保留，运行时及图片不推送到证据分支。原型窗口运行期间不要重复启动捕获对照；看完可关闭面板。

## 首轮实测证据（历史记录）

见 [observations.json](observations.json)，由 [collect.mjs](collect.mjs)汇集。观察脚本只执行 HTML 的纯模型并采集本轮日志，不是生产回归测试。

| 项目 | 实际结果/证据级别 |
|---|---|
| Rust 构建 | Rust 1.92.0、MSVC、windows-sys 0.61.2，offline + locked 编译链接成功 |
| 当前显示环境 | Windows 10.0.26200，单屏 2560×1440，目标 DPI 96；不能外推混合 DPI |
| 初始会话 | 真实 WTSInfoEx 返回活动且解锁，Default 输入桌面，非远程会话 |
| 受限运行 | 受限执行环境中会话不可确认，门禁保持关闭，0 次 OS 输入 |
| 普通桌面启动 | WTS/热键注册成功；启动后未获得前台时拒绝输入，不强抢其他窗口 |
| 真正点击 | SendInput 返回 3/3；专用按钮回调实际命中一次 |
| Unicode | SendInput 返回 20/20；文本框读回精确人工文本 |
| 停止 | 已排队动作被清空，之后未授权排队被拒绝 |
| 失焦与恢复 | 原生回放后半段失焦，重新观察失败，后续输入未投递；成功回到目标后的闭环仍需补测 |
| 真实锁屏/解锁 | 用户完成两次实际锁定/解锁，收到两组 WTS 7/8 通知；观测保持失效，0 次 OS 输入。该次没有任务授权或排队动作，不能算已验证活动队列取消竞态。见 manual-lock-results.json |
| 锁屏/旧帧 | 模拟门禁及 HTML 场景已观察，不等于真实 WTS 锁屏竞态通过 |
| 自建窗口样图 | GDI PrintWindow 客户区 904×611，非视觉定位闭环、非 WGC |
| Electron 对照 | Electron 42.1.0 / Chromium 148：窗口缩略图枚举期间退出，外层取得退出码 -1073741819（0xC0000005）；退出前日志为 WGC 启动失败 -2147024809。无有效帧，根因尚未隔离 |
| Electron 定向捕获 | 改为零缩略图枚举并请求精确 HWND 的媒体流后，取得 906×642 图像；已打开图像核对人工窗口。目标关闭后源不再找到。不是全桌面/持续视频/原生 Rust WGC 验证 |

## 第二轮：图像坐标测量（历史记录）

```powershell
# 只测量：不申请任务授权，不发送输入
./.scratch/troop-windows-control/run-capture.ps1 -FrameProbe -MappingOnly
# 前台完整点击演练：仍受焦点/会话/授权/目标范围门禁约束
./.scratch/troop-windows-control/run-capture.ps1 -FrameProbe
```

采集帧中自绘洋红色块的位置，使用 DWM extended frame bounds 映射到物理桌面，与原生控件的独立几何测量比较。结果见 [frame-mapping-results.json](frame-mapping-results.json)：

| 窗口外框 | DWM 可见边界尺寸 | 捕获帧 | X / Y 误差（物理像素） |
|---|---|---|---|
| 920×650，位置 (80,80) | 906×643 | 906×642 | 0 / +0.525 |
| 1100×720，位置 (430,230) | 1086×713 | 1086×712 | 0 / +0.473 |

这两项在单屏 DPI 96 下完成，且没有发送输入。真实点击演练因系统未允许取得前台焦点而超时，0 次输入；不能把纯测量结果称为新图像点击闭环。DWM 高度与帧高度仍相差 1 像素，约 0.5 像素的结果只支持当前样本，不能外推多屏、其他缩放或各捕获后端。运行时使用新建的独立目录，不复用旧 geometry/指令文件。

[GetWindowRect 官方文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)区分含不可见缩放边框的窗口矩形与不作 DPI 调整的 DWM 可见边界；这解释了为什么不能直接按整个窗口外框缩放。具体捕获图像的裁剪仍以实测为准。

第二轮人工锁屏结果见 [queued-lock-results.json](queued-lock-results.json)：最后一次有效准备中，任务已授权、观测有效、1 个点击排队等待 60 秒；约 1.7 秒后，WTS 锁定路径记录 `discarded_count=1`，随后收到解锁事件。解锁时授权保留、观测失效、队列为 0，全程没有 OS 输入提交。此前重复点击开始按钮产生的重置也保留在原始轨迹中，结论仅对应锁定前最后一次准备。

在读取解锁日志后又等待超过 60 秒，再核对同一专用进程仍存活，日志没有新增 OS 输入，旧动作未在原定期限后重放。结果中的 `postDeadlineObservation` 保存两次核对的 UTC 时间、间隔、进程存活情况和日志 SHA-256；它是外部观察记录，不是原型内部心跳。可用 `collect-lock.mjs <events.jsonl> --queued --checkpoint=<checkpoint.json>` 重新汇集对应原始日志与检查点。

这是当前机器的一次真实排队锁屏样本，不证明最终检查与 OS 调用之间所有可能的竞争顺序，也未验证解锁后的抓帧资源重建。真实图像点击仍因本轮未取得前台焦点而没有完成。

## 第三轮：真实图像点击与解锁后的捕获恢复

汇总见 [third-pass-summary.json](third-pass-summary.json)。[collect-third-pass.mjs](collect-third-pass.mjs)读取已有证据，核对输入、窗口命中、WTS 和人工观察的时序，记录证据与原型源码校验值；不操作桌面。

### 图像点击

[frame-click-results.json](frame-click-results.json)记录了停止门禁修正后的重跑：906×642 和 1086×712 两帧分别识别自身色块，映射到桌面后发送两次点击，均返回 3/3，专用窗口各收到一次命中回调。两轮的坐标误差最大约 0.525 物理像素。目标退出后再次枚举，未找到该 HWND。这证明当前两组样本的图像到实际点击链路，不代表混合 DPI 或任意窗口已经支持。

快速演练的授权现在仅由明确启动该演练时授予；停止、失焦、会话/显示变化会取消自动演练资格。移除了轮次准备阶段自动重新授予权限的路径。再次自动开始需要重新启动演练。

### 捕获恢复

```powershell
./.scratch/troop-windows-control/run-capture.ps1 -RecoveryProbe
```

此模式只有开始、解锁后重新观察、停止三个入口。先在专用窗口开始，等待捕获面板显示准备完成；手动锁屏、解锁后，返回原生测试窗点击重新观察并保持前台几秒。每轮使用新目录，不接受上轮指令文件。色块在解锁时从紫红变为青色，原型必须取得青色新帧才能发送新的点击。

成功证据：[capture-recovery-results.json](capture-recovery-results.json)。用户完成真实锁屏/解锁并点击重新观察，观察到：

| 环节 | 实测结果 |
|---|---|
| 锁屏前预检 | 捕获流 generation 1 从 live 停止为 ended，再建立 generation 2；尚未发送输入 |
| 真实锁屏 | 原生 WTS 锁定事件使观测失效；generation 2 自身发出 ended，随后原型执行 stop 并清除视频引用 |
| 解锁 | WTS 解锁后仍无有效观测，队列为 0；没有输入提交 |
| 人工重新观察 | epoch 更新到 5，独立创建 generation 3，轨道 ID 与锁屏前不同 |
| 新帧 | 906×642，有 900 个青色色块像素；不能由锁屏前紫红帧满足 |
| 新点击 | 重新观察后 831 ms 提交，SendInput 3/3；目标实际命中一次 |

“释放成功”不意味着本样本由应用抢先终止了活动轨道：锁屏时捕获后端已先将轨道置为 ended。此结果证明结束识别、清理、人工观察后的新流建立与输入链路，不能证明底层资源回收延迟或所有竞态。

首个尝试的失败证据保留在 [recovery-first-failure.json](recovery-first-failure.json)：收到锁定事件后，状态回传报 `An object could not be cloned`。原型误把浏览器现有 `Window.captureEvents` 成员当作事件数组，导致不可克隆值跨进程回传。改用独有字段，并在要求用户锁屏前先执行释放/重建预检；后续完整演练通过。失败不能用于推断 WGC 恢复不可用。

### 显示支持矩阵

当前 Electron 与原生查询一致：1 块 2560×1440 屏幕，scaleFactor=1，目标 DPI 96。用户最新确认保持当前单屏范围，**多屏与混合 DPI 暂不需要**。下表仅保留未来扩展时的测量建议，不属于本期必过清单；没有修改系统显示设置，也没有声明未测环境受支持。

| 后续硬件场景 | 必须记录的验收证据 | 当前状态 |
|---|---|---|
| 两屏同缩放 | 各屏内部、跨屏移动后的新帧和实际命中；目标/授权不串屏 | 待硬件 |
| 两屏不同缩放（如 100% / 150%） | DIP/物理边界、目标 DPI、帧尺寸；每屏至少两点与跨屏后的实际命中 | 待硬件 |
| 副屏位于左侧/上方 | 负坐标、完整虚拟桌面范围与 SendInput 实际命中 | 待硬件 |
| 缩放/旋转/主屏改变及拔插 | 变化前排队动作失效；重新观察前零输入；新源与新坐标验证 | 待硬件 |
| 混合 DPI 下锁屏恢复 | 旧流结束或停止、新流新帧、人工观察后新点击；无旧输入重放 | 待硬件 |

用户此次范围调整替代此前“仍属完整首版门槛”的约定。未来决定增加显示支持时再恢复上述验证；当前无需等待第二块屏幕。即使本期只支持单屏，显示配置变化时仍须暂停并作废旧观察。

## 第四轮：独立进程与故障隔离

`control-helper.exe` 管理任务授权、观察、队列和最终输入门禁；`isolation-target.exe` 是它创建的专用目标；独立 Electron 进程只负责定向捕获。停止使用单独的内核事件及确认，不经过捕获队列。所有故障仅作用于这些自建进程。

```powershell
./.scratch/troop-windows-control/run-isolation.ps1 -Scenario all
./.scratch/troop-windows-control/run-isolation.ps1 -Scenario stop-transport
./.scratch/troop-windows-control/run-isolation.ps1 -Scenario capture-lifecycle
```

完整演练需要专用目标能够取得前台；后两项不发送输入。脚本依赖本机离线 Rust 缓存及此前准备的 Electron 载体，证据分支不打包运行时，不能视为可独立安装的产品。

- [中间迭代矩阵](isolation-results.json)：10 项中 9 项通过，覆盖正常点击、短暂失焦、捕获阻塞/退出、命令 EOF、租约超时、控制器/目标退出和完整性权限门禁。观察超时用例使用了旧 epoch，门禁拒绝后超时；已修正驱动，但 TTL 仍待复测。
- [停止传输](isolation-stop-transport-results.json)：增加有界异步诊断和内核 ACK 后，stdout 背压未阻止授权撤销与确认。该次没有排队动作；不能代替背压下取消有效队列的完整用例。
- [捕获生命周期](capture-lifecycle-results.json)：最小化后轨道 live 但 1 秒内无新帧；恢复并改变尺寸取得青色新帧，重建后旧轨道 ended，关闭目标后源消失、轨道 ended。全程无任务授权或输入。
- [前台阻断](isolation-foreground-blocked.json)：后续完整复测无法满足前台门禁，立即拒绝，零输入。[停止入口未验证记录](isolation-ui-stop-unverified.json)来自 Computer Use 应用授权等待超时，未实际触发热键；不能归类为热键功能失败。
- [权限诊断原始失败](isolation-permission-diagnostic.json)保留“SendInput 返回 3/3、目标未命中”的事实。后续真实低完整性进程在应用策略路径被拒绝且零 OS 调用；独立诊断和中完整性正对照分别记录，管理员/UAC 仍待人工验证。

逐项验收、证据适用版本和剩余条件见 [完整验证矩阵](VALIDATION_MATRIX.md)；第四轮发布时源码及证据哈希见 [历史校验记录](source-verification.json)，不将它当作第五轮检查结果。这些样本支持“输入控制与捕获分进程、停止独立于媒体和诊断日志”的候选边界，不是已完成的生产协议。

## 第五轮：完成控制矩阵与人工边界演练

本轮 [12 项自动矩阵](isolation-current-results.json)全部通过，包含之前缺失的观察 TTL、有效队列与日志背压，以及新增的部分结果故障注入。每轮在开始时记录源码哈希；初始准备最多等待 60 秒，工具仅激活新建专用目标，不替失焦用例恢复焦点。原型自身最长运行时间为 180 秒。

- [真实热键](isolation-hotkey-results.json)与[真实按钮](isolation-button-results.json)：捕获进程主循环阻塞后，经 Computer Use 操作真实入口；两者均清空队列并撤销授权，超过原 60 秒期限没有输入。首次按钮元素点击缺少几何信息，没有产生回调；重新观察截图后点击成功。
- [独立进程锁屏](isolation-lock-results.json)：用户实际锁屏/解锁；WTS 与输入桌面组合查询记录不可用及恢复。旧队列在失去目标时清除，超过原期限零输入；用户确认后，重新捕获 1086×642 青色新帧，再以新的原生观察坐标完成一次新点击。这不是 WTS 通知回调样本，也不是一次新的图像坐标映射测量。
- [管理员目标](elevated-results.json)：用户手动确认 UAC，IL 8192 的普通检查器对 IL 12288 的自建目标返回 higher_integrity_target，零输入调用。双方 UIAccess=0，目标 60 秒自动退出。首次启动被系统报告为用户取消，按用户“重新发起”要求重试后取得实际证据；没有自动确认系统提示。
- 部分结果场景在真实观察和输入门禁之后，**注入 1/3 返回，不调用 SendInput**；共享后续分支撤销观察/授权、发出 ACK 并拒绝重试。它验证状态处理，不代表已经复现真实 OS 部分投递。
- [静态采样记录](capture-soak-static-result.json)：静止窗口出现轨道 live、目标可枚举但 1 秒内没有新帧回调，不能单凭这一结果认定捕获崩溃。后续持续采样使用每 250 ms 更新文字的自建夹具，区分内容不变与有变化却不出帧。
- [动态持续采样](capture-soak-results.json)：126.188 秒、24 次采样均取得新帧，呈现帧计数从 24 增至 513；后续最小化/恢复/重建/关闭通过。捕获主进程 RSS 约 136.5–145.1 MiB，不含 renderer/GPU，也不能作为长期无泄漏的结论。全程无任务授权或输入。

自动矩阵、人工入口和锁屏证据属于各自记录的源码版本；后续新增的故障注入及动态捕获夹具不追改旧记录。Esc 中断后的最后一轮已重新执行，12/12 通过，运行开始时的源码哈希与最终本机源码一致。复核汇总见 [第五轮汇总](fifth-pass-summary.json)，可用 `collect-fifth-pass.mjs` 从本目录证据重新生成；它不控制桌面。汇总同时提供本机原始字节和统一 LF 换行的哈希，区分 Git 换行转换与内容变更。

## 限制和后续关口

1. **捕获方案**：保留批量缩略图的失败证据；定向媒体捕获已完成图像点击、一次锁屏恢复和短时生命周期演练，仍需长时间、遮挡和设备变化验证。原生 Rust WGC 为未验证候选，不要求同时开发两套后端。不能从一台机器的一次组合推断 Electron 或 WGC 普遍可用或不可用。DWM 映射必须保持帧、目标及几何版本一致；轨道 live 不能代替新帧证据。批量缩略图导致进程退出时 JS 超时未能返回，原生故障需要进程外监督。
2. **真实暂停**：已有真实排队动作取消、期限后不重放、人工重新观察后的新流与新点击样本。仍需最终输入门禁的边界竞态与其他故障路径验证。不调用自动锁屏或安全桌面输入。
3. **支持矩阵**：混合 DPI 多屏、负坐标/布局变化、RDP 和 UIA 缺失仍未验证；管理员目标已有真实拒绝证据，不意味着可控制管理员应用。不存在的硬件不能靠公式演示宣称支持。
4. **进程与协议**：独立 helper 已有完整控制矩阵及真实停止入口证据。生产抓帧/UIA 阻塞必须与输入停止通道隔离，UI 断线、任务授权、epoch、账本与资源租约要遵守已确认执行契约。继承管道和命名事件只证明原型机制，生产还需身份认证、消息边界和审计持久化；原型的诊断丢弃策略不能用于审计账本。
5. **边界竞态**：SendInput 是全局输入流，最后一次焦点检查与 OS 调用之间仍有竞态；返回插入数量也不等于业务成功。短动作提交后无法撤回；部分提交应保留不确定结果，不能无条件重试。

单屏架构决策采用独立 Rust 输入控制器、独立 Electron 定向捕获进程和独立停止通道，可进入规格与开发任务拆分。长期运行、遮挡、显示变化时暂停与真实任务集成转入正式实现验收；多屏与混合 DPI 为后续扩展。当前原型不承诺远程会话或锁屏桌面自动化。

## 官方依据

- [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)：返回插入数量，受 UIPI 限制，不能单凭错误判断 UIPI。
- [PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow)：依赖目标窗口渲染且为同步调用，仅作本轮自建窗口对照。
- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)：窗口源及缩略图；本轮运行版本见捕获日志。
- [WTSQuerySessionInformationW](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsquerysessioninformationw)：初始会话状态查询。
- [Electron screen](https://www.electronjs.org/docs/latest/api/screen)：显示设备、DIP/物理坐标区分及显示变化事件。原生控制端的物理坐标不能直接等同于 Electron 的 DIP 坐标。
- [Window.captureEvents](https://developer.mozilla.org/en-US/docs/Web/API/Window/captureEvents)：浏览器保留的旧接口名称，不能作为本原型事件数组的默认值。

更完整的来源与候选方案见原仓库 `docs/research/troop-windows-host-control-2026-11-01.md`。证据分支不附带原应用代码、应用历史、个人配置或桌面内容。
