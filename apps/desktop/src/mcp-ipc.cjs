// Fixed MCP bridge. Only Core-owned, current OAuth URLs may leave the app.
function authorizationUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw Error("Invalid OAuth browser destination");
  return url.href;
}
function installMcp({ handle, core, payload, dialog, shell }) {
  for (const action of ["list", "get", "revisions", "preview", "import"])
    handle("mcp-" + action, (input = {}) =>
      core.request("mcp." + action, payload(input)),
    );
  for (const action of ["status", "begin", "cancel", "refresh", "disconnect"])
    handle("mcp-oauth-" + action, (input = {}) =>
      core.request("mcp.oauth." + action, payload(input)),
    );
  for (const action of ["catalogue", "sessions", "reconcile", "artifact"])
    handle("mcp-run-" + action, (input = {}) =>
      core.request("agent.mcp-" + action, payload(input)),
    );
  handle(
    "mcp-save",
    async (parent, input) => {
      const data = payload(input),
        d = data.definition;
      if (
        d?.enabled &&
        d.transport === "stdio" &&
        d.location === "windows-host"
      ) {
        const result = await dialog.showMessageBox(parent, {
          type: "question",
          title: "启用 Windows MCP 服务",
          message: `允许任务启动「${d.name}」？`,
          detail: `该服务以当前 Windows 用户权限运行，可访问工作区外的宿主资源。\n程序：${d.command}\n参数：${JSON.stringify(d.args ?? [])}\n目录：${d.cwd}\n后续工具调用仍需逐次审批。`,
          buttons: ["取消", "保存并允许启动"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (result.response !== 1) return { cancelled: true };
      }
      return core.request("mcp.save", data);
    },
    true,
  );
  handle(
    "mcp-remove",
    async (parent, input) => {
      const data = payload(input),
        s = await core.request("mcp.get", { id: data.id });
      if (s.revision !== data.expected_revision)
        throw Error("服务已变化，请刷新后再删除。");
      const answer = await dialog.showMessageBox(parent, {
        type: "question",
        title: "删除 MCP 服务",
        message: `删除「${s.config.name}」及本机保存的凭据？`,
        detail:
          "撤销已有任务的后续调用权限，保留调用历史。远端已经发生的效果不会撤回。",
        buttons: ["保留", "删除服务"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { cancelled: true };
      const auth = await core.request("mcp.oauth.status", { id: data.id });
      if (auth.revision > 0)
        await core.request("mcp.oauth.disconnect", {
          id: data.id,
          auth_revision: auth.revision,
        });
      return core.request("mcp.remove", data);
    },
    true,
  );
  handle("mcp-oauth-open", async (input) => {
    const data = payload(input);
    if (Object.keys(data).some((k) => !["id", "auth_revision"].includes(k)))
      throw Error("Invalid browser request");
    const status = await core.request("mcp.oauth.status", { id: data.id });
    if (
      status.state !== "authorizing" ||
      status.revision !== data.auth_revision ||
      !status.authorization_url
    )
      throw Error("授权链接已失效，请重新读取登录状态。");
    await shell.openExternal(authorizationUrl(status.authorization_url));
    return { opened: true };
  });
}
module.exports = { installMcp, authorizationUrl };
