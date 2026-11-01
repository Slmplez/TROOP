# TROOP Windows 宿主桌面控制：官方资料研究

研究日期：2026-11-01。关联任务：[TROOP #5](https://github.com/Slmplez/TROOP/issues/5)。
范围：Rust 核心与 Electron 界面，已登录、未锁定的 Windows 用户桌面。
本文只查第一方文档与官方样例；没有操作用户桌面，没有完成原型或兼容性测试。
“事实”表示来源直接说明；“推断／建议”表示工程判断；“需实测”不能当成已支持。
在线文档使用查阅当日内容，Electron `latest` 与官方样例分支会变动，实施时应锁定版本重新核对。

## 约束与结论

- 已决策：首版同时支持宿主桌面与沙箱桌面，两者独立识别和授权，见 [ADR-0001](../adr/0001-support-host-and-sandbox-desktops.md)。
- 已决策：宿主桌面按任务授权、持续显示控制状态、随时可停止；提权及安全确认由用户处理，见 [ADR-0004](../adr/0004-task-scoped-host-control-and-lock-pause.md)。
- 已决策：锁屏暂停受影响的桌面动作；撤销或锁屏使未执行输入失效；解锁重新核对，不重放旧点击。
- 事实：Windows 提供抓帧、输入注入、语义自动化和会话通知等独立能力，没有单个 API 自动实现上述任务授权契约。[S1] [S4] [S6] [S8] [S11]
- 建议：优先验证“Rust WGC 抓帧 + SendInput + 可选 UIA + WTS 状态”，Electron 承担授权和控制状态展示；这只是候选组合，不是新的架构决定。
- 建议：Electron 抓屏可作为快速原型或对照后端，Desktop Duplication 作为整屏需求的对照项；不预设三套都必须产品化。
- 事实：普通用户进程不能凭 SendInput 控制更高完整性级别的程序；截图成功也不代表有输入权限。[S6]
- 推断：最关键的验收是停止、锁屏与状态重核对，而不只是“能截图、能点一次”。依据是既有 ADR 和 API 边界。[S5] [S6] [S11]

## 1. 抓屏：WGC 与 Desktop Duplication

| 路径 | 官方能力事实 | 对 TROOP 的推断／建议 |
| --- | --- | --- |
| Windows.Graphics.Capture（WGC） | 取得显示器或应用窗口的帧；支持系统选择器，常规捕获有系统边框提示；应先检查 `IsSupported()`。[S1] | 可先验证窗口及显示器捕获，应用仍须显示任务级控制状态。 |
| Win32 WGC interop | `CreateForWindow(HWND)` 创建窗口捕获项，最低 Windows 10 1903；官方 Win32 样例展示集成。[S2] [S3] | 不把 UWP 选择器示例误认为所有 Win32 路径的强制流程；任务授权须由 TROOP 明确实现。 |
| DXGI Desktop Duplication | 按显卡输出创建 duplication；全桌面需遍历各活动输出，跨输出没有自动同步。[S4] | 适合评估整屏帧与多显示器管理；拼接和时间一致性由后端负责。 |
| Electron desktopCapturer | 主进程枚举 `screen`／`window` 媒体源及缩略图，可通过媒体捕获流程取得视频。[S16] | 适合快速验证展示，不能自动替代原生控制、WTS 与任务授权。 |

事实与边界：

- WGC 文档要求处理捕获项尺寸变化及设备丢失；不能缓存最初的帧尺寸后永久使用。[S1]
- 官方 WGC 样例明确指出最小化窗口会被枚举，但不被捕获；这是该样例的已知行为，不是对所有后端的统一保证。[S3]
- `DuplicateOutput` 的 D3D 设备必须对应目标输出所在适配器；同一会话默认最多四个进程同时使用 duplication。[S4]
- `DuplicateOutput` 对无权访问当前桌面返回 `E_ACCESSDENIED`；文档以安全桌面仅允许 LOCAL_SYSTEM 为例。[S4]
- `DXGI_ERROR_SESSION_DISCONNECTED` 明确表示会话已断开；不能通过无限重试维持“正在控制”的假象。[S4]
- `AcquireNextFrame` 的 `DXGI_ERROR_ACCESS_LOST` 可发生在桌面切换、显示模式变化等场景，需要释放并重建 duplication。[S5]
- `DXGI_ERROR_WAIT_TIMEOUT` 只是等待期内无新帧，不等同于锁屏；静态桌面和锁屏必须通过其他状态区分。[S5]
- 窗口可设置 `WDA_EXCLUDEFROMCAPTURE`，使其从支持该机制的捕获结果中排除；Windows 10 2004 起支持该值。[S21]
- `SetWindowDisplayAffinity` 不是 DRM 或严格的安全隔离保证，不能推导为 UIA 也不可读。[S21] [S8]

需实测：WGC 在锁屏、UAC、最小化、窗口关闭、GPU 重置、HDR、独显／核显切换下的帧与错误表现。
需实测：WGC 与 Electron 对同一目标的遮挡、最小化和捕获排除结果；禁止把黑帧或旧帧识别成可操作的新画面。
建议：每帧附带捕获时间、会话、目标、像素尺寸和显示布局版本，缺少可用新观测时暂停依赖视觉定位的动作。

## 2. 输入、UIPI 与用户提权

- 事实：`SendInput` 向键盘／鼠标输入流插入事件，返回实际插入数量；不是“指定 HWND 后执行该窗口命令”的接口。[S6]
- 事实：UIPI 只允许向相同或较低完整性级别的应用注入；返回值与 `GetLastError()` 都不能直接指出失败就是 UIPI。[S6]
- 事实：单次调用中的事件按序插入；现有按键状态不会自动清除，用户已按住的修饰键可能影响结果。[S6]
- 推断：SendInput 成功只证明插入了事件，不能证明预期控件收到输入或任务完成；需检查焦点与执行后结果。[S6]
- 建议：按短动作提交，发出前再次检查任务授权、会话状态、目标和观测版本；不要一次送入大量未来动作。
- 建议：停止线性化点应在输入执行器内：先使授权版本失效，再丢弃队列；已交给 OS 的输入无法当作尚未执行命令撤回。
- 需实测：锁屏或撤销恰好发生在最终检查和 OS 调用之间的竞态，记录残余输入边界，不能声称绝对零延迟撤回。
- 事实：UAC 同意／凭据提示默认位于安全桌面，用户回应后返回用户桌面；行为可受安全策略影响。[S14]
- 建议：不将整个 TROOP 提权作为控制普通应用的默认运行方式；管理员窗口和系统确认交给用户完成，符合 ADR-0004。
- 事实：UIAccess 有用途、签名、安装位置及 manifest 条件，微软明确不建议非辅助技术应用使用；也不等于任意跨完整性级别访问。[S9]
- 建议：UIAccess 不能作为这次研究中“绕过 UAC”的产品方案；普通桌面中显示的安全确认也按产品规则交还用户。

## 3. UI Automation（UIA）是补充能力

- 事实：UIA 提供元素树、属性、事件和 control patterns，适合读取可访问性信息并对支持的控件执行语义操作。[S8]
- 事实：支持取决于 provider／框架实现；微软描述的是“多数”桌面 UI 元素，不是所有程序、所有自绘控件都支持。[S8]
- 推断：不能把空树、缺少 Invoke／Value pattern 或缺失文本当成应用没有该功能；应标注能力缺失，再决定视觉后备或用户操作。[S8]
- 事实：UIA 文档指出不同用户通过 Run as 启动的进程之间不支持此类通信；权限限制也不会因采用 UIA 自动消失。[S8] [S9]
- 事实：UIA 的 `BoundingRectangle`、`ElementFromPoint` 等使用物理屏幕坐标，而非逻辑坐标。[S10]
- 事实：若会访问包括自身在内的桌面 UI，微软建议在不拥有窗口的独立 COM MTA 线程调用 UIA，避免界面线程冲突或无响应。[S22]
- 建议：Rust 将 UIA 放入独立工作线程；事件订阅和移除按官方线程约束管理。[S22]
- 推断：隔离 UIA 工作进程可改善卡住后的恢复，但“杀掉工作进程”不撤销已经触发的目标应用动作；原型需验证超时后的状态。
- 需实测：Win32、WPF、Electron／Chromium、目标业务软件、自绘画布的树完整性、pattern 可用性与执行后可验证性。

## 4. DPI 与多显示器坐标

- 事实：Electron `screen` 区分 DIP 与物理屏幕点；`getCursorScreenPoint()` 返回 DIP，并提供转换方法。[S17]
- 事实：Electron 通知显示器增加、移除，以及 bounds、scaleFactor、rotation 等变化。[S17]
- 事实：Windows PMv2 DPI awareness 提供原始像素视图及 DPI 变更通知；微软推荐桌面应用采用 PMv2。[S18]
- 事实：绝对鼠标输入范围为 0–65535；没有 `MOUSEEVENTF_VIRTUALDESK` 时映射主屏，加该标志才映射整个虚拟桌面。[S7]
- 建议：Rust 控制协议统一为带显示布局版本的物理桌面坐标；Electron 仅在显示边界转换 DIP，禁止混用截图缩略图坐标。
- 建议：窗口捕获的局部坐标映射到全局桌面时，显式记录窗口位置、裁剪范围和缩放；窗口移动后旧映射失效。
- 需实测：左侧／上侧副屏的负坐标、100%／150%／200% 混合缩放、旋转屏、跨屏窗口、拔插屏及主屏切换。
- 需实测：原生进程的 DPI manifest 与线程上下文，以及 Electron 进程已有 DPI 配置，避免运行中任意修改共享进程设置。

## 5. 锁屏、会话与 RDP

- 事实：注册会话通知后，`WM_WTSSESSION_CHANGE` 提供锁定、解锁、控制台连接／断开、远程连接／断开和注销等事件，并携带 session ID。[S11]
- 事实：`WTSINFOEX_LEVEL1` 包含连接状态及锁定／解锁／未知标志；Windows 7／Server 2008 R2 有锁定标志反向的历史缺陷。[S12]
- 事实：Electron Windows `powerMonitor` 提供 `lock-screen`／`unlock-screen`；其 idle-state 查询允许返回 `unknown`。[S19]
- 建议：Rust 以目标会话的原生状态为执行门禁，Electron 同步展示；启动时查询状态，不能只等待未来的锁屏事件。
- 建议：锁定、断开、注销、未知状态或捕获失效时使待执行桌面输入失效；桌面切换与锁屏不是同一种事件，需分别处理。
- 建议：解锁只转入“重新核对”，重建必要捕获资源，获取当前目标和显示布局，再恢复允许的后续动作。
- 建议：重新核对不是自动恢复旧动作，也不必强制每次重新授权；任务授权是否仍有效需与撤销状态分别判断。
- 事实：DXGI 文档明确规定断开会话错误；不能据此推断所有已连接 RDP 都不支持捕获，也不能推断所有 RDP 都可用。[S4]
- 需实测：RDP 已连接、客户端最小化、断开、重连、分辨率变化、控制台切换及多会话；WGC 和 Electron 需分别验证。
- 建议：首版把未验证远程会话显示为“不支持／暂停”，远程可用性应由验收结果扩展，而非默认承诺。

## 6. Electron 和 Rust 的职责候选

事实：`desktopCapturer.getSources()` 返回捕获源／缩略图；媒体流通常经 display-media handler 与 `getDisplayMedia()` 建立。[S16]
事实：`webContents.sendInputEvent()` 将输入发给其页面，并要求所属 BrowserWindow 聚焦；不是 Windows 全桌面输入接口。[S20]
推断：因此 Electron 原生 API 并未替代 SendInput／UIA；UI、媒体预览与宿主动作可以拆开，但也需明确通信权限。[S6] [S8] [S16] [S20]

候选职责分工（建议，待原型结果和用户决定）：

| 组件 | 候选职责 | 验收重点 |
| --- | --- | --- |
| Electron 主进程与界面 | 任务授权、宿主／沙箱目标展示、持续状态、停止入口、预览 | 关闭主窗口后托盘驻留时，控制状态和停止入口仍可用 |
| Rust 控制执行器 | WGC、输入、会话检查、授权版本和短动作队列 | 锁屏、撤销、断连使待执行动作失效；错误可观测 |
| UIA 工作线程／可选进程 | 元素查询、pattern 调用和事件 | 目标支持程度、超时、卡住后恢复 |
| 可选 DXGI 后端 | 对照整屏捕获与设备恢复 | 多适配器、输出变化、RDP 和资源重建 |

事实：Windows access token 描述用户 SID、组、权限及安全上下文；不包含 TROOP 的任务范围。[S13]
推断：同 UID（Windows 中更准确是同用户 SID）和等效令牌权限的进程，不会仅因“拆成 helper”获得沙箱隔离。[S13]
推断：同一用户 SID 也不保证令牌完全相同，完整性级别、受限令牌等差异仍重要；不可把 SID 相同直接等同于权限相同。[S6] [S13]
建议：应用内任务令牌是授权协议，不是 Windows OS 隔离；helper 的 IPC 应限制调用者、任务、目标、动作类型和有效期。
建议：不要让任意 renderer 或脚本直接获得无约束原生输入通道；若威胁模型要求抵抗同用户恶意进程，另立隔离研究，不能靠本报告宣称解决。

## 7. 最小原型验收矩阵

下表均为建议验收项，尚未执行。基线采用普通用户权限、已登录未锁定桌面，记录 OS build、Electron 版本、GPU／驱动与捕获后端。
每例记录帧时间、目标会话、授权版本、动作开始／停止时间、OS 返回值及观察结果；不用真实敏感内容作为样例。

| 场景 | 操作与预期 | 必须留存的证据 |
| --- | --- | --- |
| 基本闭环 | 自建测试窗读取画面、点击按钮、输入测试文本；观察结果一致 | 帧尺寸、坐标、输入返回数、应用回执 |
| 未授权／错误任务 | 缺失、过期或属于其他任务的请求不进入输入 API | 拒绝原因与零 OS 提交记录 |
| 可见状态 | 控制开始、暂停、结束；主窗关闭后仍有状态和停止入口 | 状态切换与托盘驻留表现 |
| 停止竞态 | 连续短动作中撤销；线性化点后不再提交新动作，旧队列失效 | 撤销与每次 OS 提交时间，残余动作说明 |
| 锁屏竞态 | 输入前／队列中人工锁屏；解锁后不重放，重新核对 | WTS 事件、队列版本、恢复前新观测 |
| 启动状态 | 在锁定或状态未知时启动 helper，禁止直接进入控制 | 初始查询及门禁结果 |
| UAC／管理员应用 | 用户手动触发、处理确认；普通 helper 不自动控制高 IL 窗口 | 暂停原因、UIPI 失败分类的限度 |
| 捕获故障 | 窗口关闭／最小化／捕获排除／尺寸改变后，不使用旧帧盲点 | 后端错误、帧失效与重新建立过程 |
| 混合 DPI 多屏 | 在各屏边缘及跨屏窗口命中测试标记；布局变化后旧映射失效 | 物理／DIP／归一化坐标、布局版本 |
| UIA 完整与缺失 | 支持 pattern 的控件成功；自绘／缺失 provider 明确降级 | 元素和 pattern 清单、降级结果 |
| 用户同时输入 | 修饰键按住、用户切焦点时不误报执行成功 | 焦点变化、按键状态、结果核对 |
| RDP | 连接、最小化、断开、重连分别运行；未支持时明确暂停 | 会话 ID、连接状态、各后端结果 |
| 进程异常 | renderer、helper、UIA 工作单元退出后不继续旧授权动作 | IPC 断开、停止门禁及恢复流程 |
| 性能 | 1080p／4K、单屏／双屏记录帧龄、CPU、GPU、内存 | p50／p95 与资源曲线；指标阈值待产品确定 |

建议先完成基本闭环、停止／锁屏、混合 DPI、UAC 四组，再比较捕获后端；RDP 支持范围依据独立测试决定。
本研究没有改变 ADR；Windows 最低版本、最终捕获后端、UIA 是否独立进程与远程支持范围仍待决定。

## 第一方来源（22 项）

[S1]: https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture
[S2]: https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow
[S3]: https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/blob/master/cpp/ScreenCaptureforHWND/README.md
[S4]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput
[S5]: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe
[S6]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
[S7]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput
[S8]: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview
[S9]: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview
[S10]: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling
[S11]: https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change
[S12]: https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w
[S13]: https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens
[S14]: https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works
[S15]: https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/DXGIDesktopDuplication/cpp/DesktopDuplication.cpp
[S16]: https://www.electronjs.org/docs/latest/api/desktop-capturer/
[S17]: https://www.electronjs.org/docs/latest/api/screen
[S18]: https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows
[S19]: https://www.electronjs.org/docs/latest/api/power-monitor
[S20]: https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent
[S21]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity
[S22]: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading

官方 DXGI 样例把桌面切换、设备变化、会话断开／重连列为需处理的过渡情形，可用于核对恢复流程；它不是产品兼容性证明。[S15]
