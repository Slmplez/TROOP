# 本机 Docker 沙箱 Worker 原型

一次性架构原型，不是生产 Worker。任务：[验证独立沙箱 Worker 与桌面替代方案](https://github.com/Slmplez/TROOP/issues/7)。本期只考虑本机 Docker；远程沙箱暂不考虑。Windows 本机控制仍采用单屏、100% 缩放。

## 当前状态

**镜像尚未构建，容器闭环尚未运行。** 当前机器未找到可用 Docker/Podman；WSL 查询退出码 50，明确返回未安装。没有安装软件、启用 Windows 功能、修改 BIOS 或重启机器。Docker 新版的每用户安装目录也已检查，未找到安装。

源码检查已通过：宿主入口 `cargo check`、Linux 目标 `cargo check --target x86_64-unknown-linux-gnu`、Rust 语法解析和 Python 语法解析。为 Linux 类型检查下载了官方 Rust 目标标准库；这不提供 Linux 执行环境。系统查询已报告 Hypervisor 存在，不从先前单独 CPU 标志推断固件虚拟化关闭。环境记录见 [environment.json](environment.json)，源码哈希与检查边界见 [source-checks.json](source-checks.json)。

## 分工

- Rust Core 在宿主管理会话、模型请求、授权和调度。
- 容器 Rust Worker 只接收受控工具任务，执行 Shell 和文件操作；可启动已安装的 Firefox。模型服务长期凭据不传入工具环境。
- Xvfb/Openbox 提供自有桌面；x11vnc/noVNC 提供独立媒体与人工接管入口。未复制原产品镜像、daemon 或商业云服务。
- 控制通道候选为 `docker exec -i … troop-worker connect`，内部使用 root-only Unix socket。媒体单独发布到宿主 loopback，不挂载 Docker socket。

## 已写出的机制，均需 Linux 容器实测

工具以 UID/GID 1000、清空附加组和 capability 的身份运行；控制器保留停止作业所需的最小权限。`/control` 为 root-only 持久账本，`/workspace` 为工具工作区。控制使用 generation/run 身份，租约为 10 秒；EOF、停止和租约过期尝试终止所属进程组。重建后生成新 generation，保留文件与账本，旧任务不自动重放。

这是原型，不应假定进程组能收回恶意任务新建的会话；强制停止的容器级兜底仍待验证。PTY 分流、浏览器自动操作、账本不可篡改、输出背压和崩溃核对都不能凭源码记为通过。当前输出是有界诊断，未实现可恢复的完整工具结果流。

## Docker 就绪后的构建与启动草案

在仓库根目录运行；以下资源名仅用于本原型，先确认没有同名的其他资源：

```powershell
docker build -t troop-sandbox-prototype:dev .scratch/troop-sandbox-worker
docker run -d --name troop-sandbox-prototype --label com.troop.prototype=sandbox `
  --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add SETPCAP --cap-add KILL --cap-add CHOWN `
  --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2 --shm-size 256m `
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --tmpfs /run:rw,nosuid,nodev,mode=755 `
  --tmpfs /home/troop:rw,nosuid,nodev,uid=1000,gid=1000 `
  --mount source=troop-prototype-workspace,target=/workspace `
  --mount source=troop-prototype-control,target=/control `
  -p 127.0.0.1:27608:6080 troop-sandbox-prototype:dev
docker exec -i troop-sandbox-prototype troop-worker connect
```

连接首先返回 `hello`。后续每行 JSON 必须带本轮 `generation` 和 `run`；发送 `grant`，再每隔少于 10 秒发送 `heartbeat`。`exec` 的 `command` 示例为 `id; printf troop > /workspace/probe.txt`；`stop` 清除本连接授权，之后必须建立新连接再授权。此草案尚没有自动化协调驱动，不能直接将启动命令当作验证完成。

画面入口：`http://127.0.0.1:27608/vnc.html`。一次性密码可从 `docker exec troop-sandbox-prototype cat /run/troop-control/viewer.json` 在本机读取，不写入证据或 issue。只有当前容器的测试桌面会出现在该页面。

停止使用 `docker stop troop-sandbox-prototype`。重建时只删除经标签确认的原型容器，复用两份命名卷；检查新 generation、原工作文件与旧账本，确认旧任务没有自动继续。不要删除卷来模拟“保留数据的恢复”。

## 验收清单

1. 真正构建镜像，记录基础镜像 digest、包清单、Worker 校验值。
2. 非 root 执行、工作区文件可读写，工具无法修改控制账本。
3. 实际打开桌面及 Firefox；截图、输入和用户接管有真实证据。
4. 控制、PTY/输出和媒体独立；断线、租约过期及输出背压不阻塞停止。
5. 停止与容器重建后文件保留、身份更新、无旧任务自动重放。

Docker 缺失不应阻止未来产品使用明确授权的 Windows 本机模式，也不能静默把沙箱任务改在宿主执行。

依据：[Docker Windows 安装前提](https://docs.docker.com/desktop/setup/install/windows-install/)、[Docker run](https://docs.docker.com/reference/cli/docker/container/run/)、[Dockerfile](https://docs.docker.com/reference/dockerfile/)、[Debian noVNC](https://packages.debian.org/bookworm/novnc)、[Debian x11vnc](https://packages.debian.org/bookworm/x11vnc)。
