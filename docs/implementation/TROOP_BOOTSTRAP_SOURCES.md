# 基础版本来源记录

2026-11-01。

## 新实现

本次 `crates/{protocol,storage,core}`、Electron main/preload/正式入口、React 页面、构建与验收脚本由 TROOP 新实现。没有复制旧应用的 bundle、安装器、私有 Electron 运行时、账号或商业服务入口。旧项目保留为本机参考资料；独立发布分支仅包含明确列出的新文件，不继承其 Git 历史。

## 依赖

- Electron **42.1.0**：来自官方 npm `electron` 包与该包的安装器，使用其 `@electron/get` 分发下载与校验机制。实际运行版本由冒烟记录确认。运行时不进 Git；依赖元数据和完整性由 `apps/desktop/package-lock.json` 保存。
- React / React DOM **19.2.1**、esbuild **0.28.2**、Prettier **3.6.2**：官方 npm registry 分发，精确直接依赖和传递依赖见 npm lock。Prettier 仅用于开发。
- serde **1.0.229**、serde_json **1.0.154**、rusqlite **0.40.2**（bundled SQLite）：版本及 crates.io checksum 见 `Cargo.lock`。无需安装独立数据库服务。
- IBM Plex Sans：Google Fonts 仓库 `ofl/ibmplexsans/IBMPlexSans[wdth,wght].ttf`，正常可变字体；SHA-256 `3B031AA4216174205BD8471F88A49B91F093169E9E87BD5262242BC5967FE2E3`。原始字体、来源 JSON 与 SIL OFL 保留在 `apps/desktop/renderer/assets/`。没有修改字体内容。

依赖许可证继续以各包随附文件为准。本次没有替仓库整体指定新的开源许可证。

## 设计与接口参考

- [Electron app 生命周期与单实例](https://www.electronjs.org/docs/latest/api/app)
- [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)
- 设计技能 `design-taste-frontend` 的应用页面规则与本机测量工具；采用 framed-sheet 方向，具体图标、组件和 CSS 为本次实现。
- 已确认的 [执行语义 #4](https://github.com/Slmplez/TROOP/issues/4)、[Windows 架构 #6](https://github.com/Slmplez/TROOP/issues/6)、[本地集成 #8](https://github.com/Slmplez/TROOP/issues/8)。Magpie 的 Skills、MCP 与网关借鉴属于后续功能包，本基础版本没有内嵌或启动 Magpie 服务。

源码发布排除：`node_modules`、`target`、`apps/desktop/bin`、`apps/desktop/dist`、测试配置和截图临时目录、旧应用源码/资源、用户数据库与凭据。
