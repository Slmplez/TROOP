# 独立启动基础版本验收

日期：2026-11-01。规格/实现：[#11](https://github.com/Slmplez/TROOP/issues/11)、[#12](https://github.com/Slmplez/TROOP/issues/12)。范围见 `TROOP_BOOTSTRAP_SPEC.md`。

## 运行与检查

Windows x64；开发 Node 24.4.1、npm 11.4.2、Rust/Cargo 1.92.0 MSVC。应用实际运行 Electron 42.1.0 / Chromium 148.0.7778.97。

| 检查 | 结果与范围 |
| --- | --- |
| Cargo test | 3 项通过：包络字段、请求 ID 上限、新版数据库拒绝且不改写 journal mode |
| Cargo Clippy | workspace/all-targets，`-D warnings` 通过 |
| 独立 build | 真实 Rust 可执行文件 + esbuild React/CSS/字体产物通过 |
| Node 集成测试 | 9 项通过，真实 Core、SQLite、管道与故障夹具 |
| Electron 冒烟 | 10 项通过，真实窗口/桥接/Core/SQLite/托盘及正式入口 |
| Prettier | 新桌面源码格式检查通过 |
| 设计静态检查 | app 模式 0 FAIL / 0 WARN |
| 界面实际测量 | 两个页面在 1440 / 768 / 390 宽度下，技能测量规则 0 FAIL；截图人工检查 |

Node 验证覆盖：中文、空格和 emoji 路径；重复添加；重命名与重启保留；移除保留文件；双 Core 争用；握手/版本/generation/未知方法/额外字段/重复 ID；超大帧和 EOF；55 个工作区分页；未决写入崩溃后不重放；握手期间停止；坏响应关闭连接；父进程死亡后 Core 退出并释放独占锁。

崩溃重连检查还向旧进程对象注入迟到的 close 通知，确认新 Core 保持可用。独立源码目录重新从同一机器的公开依赖缓存安装，使用自己的 Cargo 构建产物和官方 Electron 运行时，通过 9 项 Core 与 10 项 Electron 验证；不依赖参考应用的入口、node_modules 或私有运行时。这属于源码隔离构建验证，不等于干净机器验收。

Electron 验证覆盖：真实 Core 连通；Renderer 无 Node、固定桥接；按钮到 IPC/Core/SQLite 的添加；重命名表单；其他窗口 IPC 拒绝；崩溃错误态与显式恢复；关闭到托盘和恢复；通过正式入口启动第二实例退出；明确退出无 Core 残留；正式入口独立启动且父进程死亡后释放数据库写入权。

## 界面检查方法

应用需要 Electron preload，不能在普通 HTTP 网页中伪造桥接后当作真实验收。因此使用设计技能的 `probe`、`layout`、`app` 与 judge 函数，在真实 Electron Renderer 内测量；不替换运行时 API。检查脚本、原始报告与完整截图保留在本机被忽略的 `.tmp-troop-bootstrap/`。

采用设计技能提供的 `framed-sheet`，seed 2014131340：浅灰绿外框和白色工作面，强调工作区列表与连接状态。字体为正常体 IBM Plex Sans，中文由本机系统字体回退。工作区页面回答“登记了哪些项目，如何管理”；连接页面回答“Core 是否可用，如何恢复”。没有模拟模型回复或待替换的业务样例数据。

已修正误选斜体、页脚文字对比度、次要字号以及错误的 `data-ui` 页面标记。测量保留的 WARN：少量实际记录导致全高应用工作面留白（blank-gap / hero-void / panel-void）；工作区完整路径和应用次要标注使用 11–12px 导致 tiny-text 比例告警。留白随真实记录增长，不以虚构内容填充；主要名称、操作和状态保持可读字号。390px 仅补充布局压力检查，Windows 原生窗口最小宽度仍为 660px，不表示新增移动端支持。

## 实际限制

- 原生目录选择器由测试夹具返回自有目录；未自动操作系统选择窗口。移除的“保留文件”由真实 Core 集成测试验证。
- 正式入口和锁竞争检查使用独立临时配置，不读取用户项目。真实用户路径仅在手动选择后登记。
- 受限代理沙箱曾阻断 Windows 目录规范化和 Clippy 向父目录查找配置；使用正常 Windows 权限重跑后通过，未放宽应用权限或修改路径逻辑。
- 拒绝恶意 IPC 的预期错误会出现在冒烟 stderr；不代表应用启动失败。
- Cargo 缓存硬链接不可用时回退复制的环境提示不影响构建或 Clippy 结果。
- 独立配置第一次隐藏截图曾返回 UnknownVizError；图形验收改为显示专用窗口、等待实际绘制后捕获，通过后不改变产品渲染设置。
- 没有调用真实模型、执行 Agent 工具或验证调度；这些模块尚未实现。没有运行 Docker，也没有扩展多屏/DPI。
- 本机验证不替代干净机器、签名分发、系统更新和完整首版验收。
