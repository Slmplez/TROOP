const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  dialog,
  session,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { CoreSupervisor } = require("./core-client.cjs");
const ROOT = path.resolve(__dirname, "..");
async function bootstrap({ userData, show = true } = {}) {
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
    tray = null,
    quitting = false,
    quitStarted = false;
  const executable = path.join(
    app.isPackaged
      ? path.join(process.resourcesPath, "bin")
      : path.join(ROOT, "bin"),
    process.platform === "win32" ? "troop-core.exe" : "troop-core",
  );
  const dataDir = path.join(app.getPath("userData"), "core");
  const core = new CoreSupervisor({
    executable,
    args: ["--data-dir", dataDir],
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
  win = new BrowserWindow({
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
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== page) event.preventDefault();
  });
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  const trusted = (event) => {
    if (
      !win ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== page
    )
      throw Error("Untrusted IPC sender");
  };
  const handle = (name, fn) =>
    ipcMain.handle("troop:" + name, async (event, ...args) => {
      trusted(event);
      try {
        return { ok: true, value: await fn(...args) };
      } catch (error) {
        return { ok: false, error: error.message || "操作失败" };
      }
    });
  handle("status", () => core.snapshot());
  handle("workspaces", (offset = 0) => {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw Error("分页参数无效。");
    return core.request("workspace.list", { offset });
  });
  handle("choose-workspace", async () => {
    if (core.state !== "ready") throw Error("Core 尚未就绪。");
    const result = await dialog.showOpenDialog(win, {
      title: "选择工作区",
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    return core.request("workspace.add", { path: result.filePaths[0] });
  });
  const validId = (id) => Number.isSafeInteger(id) && id > 0;
  handle("rename-workspace", (id, name) => {
    if (!validId(id) || typeof name !== "string" || name.length > 480)
      throw Error("名称或工作区无效。");
    return core.request("workspace.rename", { id, name });
  });
  handle("remove-workspace", async (id) => {
    if (!validId(id)) throw Error("工作区无效。");
    const answer = await dialog.showMessageBox(win, {
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
  });
  handle("restart-core", async () => {
    await core.stop();
    return core.start();
  });
  handle("quit", () => {
    app.quit();
    return null;
  });
  core.on("status", (value) => {
    if (win && !win.isDestroyed() && !win.webContents.isLoading())
      win.webContents.send("troop:core-status", value);
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
