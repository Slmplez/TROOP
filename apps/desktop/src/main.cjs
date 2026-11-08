const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  dialog,
  session,
  shell,
  Notification,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { CoreSupervisor } = require("./core-client.cjs");
const { coreBinary } = require("./core-path.cjs");
const executionContract = require("../contracts/execution.cjs");
const { installMcp } = require("./mcp-ipc.cjs");
const { startReminderNotifications } = require("./reminder-notifications.cjs");
const ROOT = path.resolve(__dirname, "..");
async function bootstrap({
  userData,
  show = true,
  testClockFile,
  testNotification,
} = {}) {
  if (app.isPackaged && (testClockFile || testNotification))
    throw Error("测试适配仅用于开发版本。");
  app.setName("TROOP");
  app.setAppUserModelId("app.troop.desktop");
  const requestedData =
    userData || app.commandLine.getSwitchValue("user-data-dir");
  if (requestedData) {
    if (!path.isAbsolute(requestedData))
      throw Error("用户数据目录必须是绝对路径。");
    app.setPath("userData", requestedData);
  } else if (!app.isPackaged)
    app.setPath(
      "userData",
      path.join(app.getPath("appData"), "TROOP Development"),
    );
  const primary = app.requestSingleInstanceLock();
  if (!primary) {
    app.quit();
    return null;
  }
  let win = null,
    notifications = null,
    tray = null,
    quitting = false,
    quitStarted = false;
  const windows = new Set();
  const executable = path.join(
    app.isPackaged
      ? path.join(process.resourcesPath, "bin")
      : path.join(ROOT, "bin"),
    coreBinary,
  );
  const dataDir = path.join(app.getPath("userData"), "core");
  const core = new CoreSupervisor({
    executable,
    args: [
      "--data-dir",
      dataDir,
      ...(testClockFile ? ["--test-clock-file", testClockFile] : []),
      ...(process.env.TROOP_EVENT_LISTEN
        ? ["--event-listen", process.env.TROOP_EVENT_LISTEN]
        : []),
    ],
  });
  const page = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
  const restore = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  app.on("second-instance", restore);
  const quittingPromise = () => {
    if (quitStarted) return;
    quitStarted = true;
    notifications?.stop();
    core
      .stop()
      .then(() => {
        quitting = true;
        tray?.destroy();
        app.exit(0);
      })
      .catch((error) => {
        quitStarted = false;
        core.lastError = error.message;
        if (win && !win.isDestroyed()) {
          win.show();
          win.webContents.send("troop:core-status", core.snapshot());
        }
      });
  };
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      quittingPromise();
    }
  });
  app.on("window-all-closed", () => {});
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  const createWindow = (primaryWindow = false) => {
    const created = new BrowserWindow({
      width: 1120,
      height: 780,
      minWidth: 660,
      minHeight: 480,
      show: false,
      title: "TROOP",
      backgroundColor: "#f2f4f3",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    windows.add(created);
    created.removeMenu();
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event, url) => {
      if (url !== page) event.preventDefault();
    });
    created.on("close", (event) => {
      if (primaryWindow && !quitting) {
        event.preventDefault();
        created.hide();
      }
    });
    created.on("closed", () => windows.delete(created));
    return created;
  };
  win = createWindow(true);
  const openWindow = async () => {
    const created = createWindow();
    try {
      await created.loadURL(page);
      created.show();
      return { opened: true };
    } catch (error) {
      created.destroy();
      throw error;
    }
  };
  const trusted = (event) => {
    const senderWindow = [...windows].find(
      (window) => !window.isDestroyed() && window.webContents === event.sender,
    );
    if (
      !senderWindow ||
      event.senderFrame !== senderWindow.webContents.mainFrame ||
      event.senderFrame.url !== page
    )
      throw Error("Untrusted IPC sender");
  };
  const clientContracts = new Map(
    Object.entries(executionContract.methods).map(([method, definition]) => [
      definition.channel,
      method,
    ]),
  );
  const handle = (name, fn, withWindow = false) =>
    ipcMain.handle("troop:" + name, async (event, ...args) => {
      trusted(event);
      try {
        const method = clientContracts.get(name);
        if (method)
          executionContract.validate(
            method,
            executionContract.ipcInput(method, args),
          );
        const value = await (withWindow
          ? fn(BrowserWindow.fromWebContents(event.sender), ...args)
          : fn(...args));
        if (method) executionContract.validate(method, value, true);
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: error.message || "操作失败",
          details: {
            kind: error.kind || "operation_failed",
            code: error.code,
            retryability: error.retryability,
            currentRevision: error.currentRevision,
            operationRef: error.operationRef,
            requiredAction: error.requiredAction,
          },
        };
      }
    });
  handle("status", () => core.snapshot());
  handle("workspaces", (offset = 0) => {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw Error("分页参数无效。");
    return core.request("workspace.list", { offset });
  });
  handle(
    "choose-workspace",
    async (parent) => {
      if (core.state !== "ready") throw Error("Core 尚未就绪。");
      const result = await dialog.showOpenDialog(parent, {
        title: "选择工作区",
        properties: ["openDirectory"],
      });
      if (result.canceled) return null;
      return core.request("workspace.add", { path: result.filePaths[0] });
    },
    true,
  );
  const validId = (id) => Number.isSafeInteger(id) && id > 0;
  handle("rename-workspace", (id, name) => {
    if (!validId(id) || typeof name !== "string" || name.length > 480)
      throw Error("名称或工作区无效。");
    return core.request("workspace.rename", { id, name });
  });
  handle(
    "remove-workspace",
    async (parent, id) => {
      if (!validId(id)) throw Error("工作区无效。");
      const answer = await dialog.showMessageBox(parent, {
        type: "question",
        title: "移除工作区",
        message: "从列表移除这个工作区？",
        detail: "文件夹及其中的文件会保留。",
        buttons: ["保留", "移除登记"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return null;
      return core.request("workspace.remove", { id });
    },
    true,
  );
  handle("restart-core", async () => {
    await core.stop();
    return core.start();
  });
  const payload = (input) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Buffer.byteLength(JSON.stringify(input)) > 50000
    )
      throw Error("请求内容无效或过长。");
    return input;
  };
  handle("providers", () => core.request("provider.list"));
  handle("save-provider", (input) =>
    core.request("provider.save", payload(input)),
  );
  handle(
    "remove-provider",
    async (parent, id) => {
      if (typeof id !== "string" || id.length > 80) throw Error("服务无效。");
      const answer = await dialog.showMessageBox(parent, {
        type: "question",
        title: "删除模型服务",
        message: "删除这个模型服务及其保存的密钥？",
        detail: "对话记录会保留。",
        buttons: ["保留", "删除服务"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { removed: false };
      await core.request("provider.remove", { id });
      return { removed: true };
    },
    true,
  );
  handle("conversations", (offset = 0) => {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw Error("分页参数无效。");
    return core.request("chat.list", { offset });
  });
  handle("create-conversation", (input) =>
    core.request("chat.create", payload(input)),
  );
  handle(
    "remove-conversation",
    async (parent, id) => {
      if (!validId(id)) throw Error("对话无效。");
      const answer = await dialog.showMessageBox(parent, {
        type: "question",
        title: "删除对话",
        message: "删除这份本机对话记录？",
        buttons: ["保留", "删除对话"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { removed: false };
      await core.request("chat.remove", { id });
      return { removed: true };
    },
    true,
  );
  handle("messages", (id, before = null) => {
    if (!validId(id) || (before !== null && !validId(before)))
      throw Error("对话分页无效。");
    return core.request("chat.messages", { conversation_id: id, before });
  });
  handle("send-message", (input) => core.request("chat.send", payload(input)));
  for (const [method, definition] of Object.entries(
    executionContract.methods,
  )) {
    if (definition.channel.startsWith("resource-")) {
      if (method === "desktop.open-window") {
        handle(definition.channel, openWindow);
      } else if (method === "desktop.choose-directory") {
        handle(
          definition.channel,
          async (parent) => {
            const result = await dialog.showOpenDialog(parent, {
              title: "选择工作区",
              properties: ["openDirectory"],
            });
            return result.canceled ? null : result.filePaths[0];
          },
          true,
        );
      } else if (method === "desktop.oauth-open") {
        // The existing fixed OAuth handler rechecks the Core-owned URL.
        handle(definition.channel, async (input) => {
          const status = await core.request("mcp.oauth.status", {
            id: input.id,
          });
          if (
            status.state !== "authorizing" ||
            status.revision !== input.auth_revision ||
            !status.authorization_url
          )
            throw Error("授权链接已失效。");
          await shell.openExternal(
            require("./mcp-ipc.cjs").authorizationUrl(status.authorization_url),
          );
          return { opened: true };
        });
      } else if (definition.command) {
        handle(definition.channel, () => {
          throw Error("资源写操作必须通过操作账本提交。");
        });
      } else
        handle(definition.channel, (input = {}) =>
          core.request(method, payload(input)),
        );
      continue;
    }
    if (!method.startsWith("agent.") && !method.startsWith("operations."))
      continue;
    handle(
      definition.channel,
      async (parent, input = {}) => {
        payload(input);
        if (method === "operations.execute") {
          executionContract.validate(input.method, input.input);
          const original = await core.request("operations.get", {
            operation_id: input.operation_id,
            instance_id: input.instance_id,
          });
          if (original.state === "not_found") {
            const d = input.input.definition;
            const confirmation =
              input.method === "provider.remove"
                ? [
                    "删除模型服务",
                    "删除这个模型服务及其保存的密钥？",
                    "对话记录会保留。",
                  ]
                : input.method === "workspace.remove"
                  ? [
                      "移除工作区",
                      "从列表移除这个工作区？",
                      "文件夹及其中的文件会保留。",
                    ]
                  : input.method === "mcp.remove"
                    ? [
                        "删除 MCP 服务",
                        "删除这个 MCP 服务及本机凭据？",
                        "撤销已有任务的后续调用权限，保留调用历史。",
                      ]
                    : input.method === "mcp.save" &&
                        d?.enabled &&
                        d.transport === "stdio" &&
                        d.location === "windows-host"
                      ? [
                          "启用 Windows MCP 服务",
                          `允许任务启动「${d.name}」？`,
                          `程序：${d.command}\n参数：${JSON.stringify(d.args ?? [])}\n目录：${d.cwd}\n可访问工作区外的宿主资源，后续工具调用仍需逐次审批。`,
                        ]
                      : null;
            if (confirmation) {
              const answer = await dialog.showMessageBox(parent, {
                type: "question",
                title: confirmation[0],
                message: confirmation[1],
                detail: confirmation[2],
                buttons: ["取消", "确认"],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
              });
              if (answer.response !== 1)
                return {
                  operation_id: input.operation_id,
                  instance_id: input.instance_id,
                  method: input.method,
                  state: "dismissed",
                };
            }
          }
        }
        return core.request(method, input);
      },
      true,
    );
  }
  for (const action of [
    "agents",
    "agent.save",
    "projects",
    "membership",
    "list",
    "write",
    "edit",
    "jobs",
    "job",
    "job.cancel",
    "job.retry",
  ]) {
    handle("memory-" + action, (input = {}) =>
      core.request("memory." + action, payload(input)),
    );
  }
  for (const action of [
    "list",
    "preview",
    "import",
    "get",
    "versions",
    "enable",
    "remove",
    "edit",
    "refresh",
  ]) {
    handle("skills-" + action, (input = {}) =>
      core.request("skills." + action, payload(input)),
    );
  }
  handle(
    "skills-choose",
    async (parent) => {
      const result = await dialog.showOpenDialog(parent, {
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    },
    true,
  );
  for (const action of [
    "list",
    "definition",
    "save",
    "remove",
    "calls",
    "call",
    "reconcile",
  ]) {
    handle("hooks-" + action, (input = {}) =>
      core.request("hooks." + action, payload(input)),
    );
  }
  handle("cancel-turn", (id) => {
    if (!validId(id)) throw Error("生成标识无效。");
    return core.request("chat.cancel", { turn_id: id });
  });
  installMcp({ handle, core, payload, dialog, shell });
  handle("quit", () => {
    app.quit();
    return null;
  });
  core.on("status", (value) => {
    for (const window of windows)
      if (!window.isDestroyed() && !window.webContents.isLoading())
        window.webContents.send("troop:core-status", value);
  });
  core.on("chat-event", (value) => {
    for (const window of windows)
      if (!window.isDestroyed() && !window.webContents.isLoading())
        window.webContents.send("troop:chat-event", value);
  });
  const bitmap = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      if (
        (y >= 2 && y <= 4 && x >= 2 && x <= 13) ||
        (x >= 7 && x <= 9 && y >= 3 && y <= 14) ||
        (y >= 7 && y <= 8 && x >= 4 && x <= 12)
      ) {
        const i = (y * 16 + x) * 4;
        bitmap[i] = 70;
        bitmap[i + 1] = 94;
        bitmap[i + 2] = 49;
        bitmap[i + 3] = 255;
      }
  const icon = nativeImage.createFromBitmap(bitmap, {
    width: 16,
    height: 16,
    scaleFactor: 1,
  });
  try {
    tray = new Tray(icon);
    tray.setToolTip("TROOP");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 TROOP", click: restore },
        { type: "separator" },
        { label: "退出 TROOP", click: () => app.quit() },
      ]),
    );
    tray.on("double-click", restore);
  } catch (error) {
    win.removeAllListeners("close");
    win.on("close", () => app.quit());
  }
  await win.loadURL(page);
  notifications = startReminderNotifications({
    core,
    focused: () =>
      [...windows].some(
        (window) => !window.isDestroyed() && window.isFocused(),
      ),
    supported: () => (testNotification ? true : Notification.isSupported()),
    create: (options) =>
      testNotification ? testNotification(options) : new Notification(options),
  });
  if (show) win.show();
  core.start().catch(() => {});
  return {
    core,
    window: win,
    restore,
    dataDir,
    get tray() {
      return tray;
    },
    quit: () => app.quit(),
  };
}
module.exports = { bootstrap };
