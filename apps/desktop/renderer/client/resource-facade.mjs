import contract from "../../contracts/execution.cjs";

// Compatibility of view call signatures is contained here. All business requests
// still pass the shared typed client and model; native dialogs stay in Electron.
export function createResourceFacade(models, native) {
  const facade = {};
  const positional = {
    listMemoryProjects: (agent_id) => ({ agent_id }),
    listMemories: (agent_id, offset = 0, include_deleted = false) => ({
      agent_id,
      offset,
      ...(include_deleted ? { include_deleted } : {}),
    }),
    listMemoryJobs: (agent_id) => ({ agent_id }),
    getMemoryJob: (id) => ({ id }),
    cancelMemoryJob: (id) => ({ id }),
    retryMemoryJob: (id) => ({ id }),
    listProviders: () => ({}),
    removeProvider: (id) => ({ id }),
    listWorkspaces: (offset = 0) => ({ offset }),
    renameWorkspace: (id, name) => ({ id, name }),
    removeWorkspace: (id) => ({ id }),
  };
  for (const [method, d] of Object.entries(contract.methods)) {
    if (method.startsWith("operations.")) continue;
    const name = d.bridge.startsWith("resource")
      ? d.bridge.slice("resource".length)
      : d.bridge;
    facade[name] = async (...args) => {
      const input = positional[name]
        ? positional[name](...args)
        : d.mode === "id"
          ? { id: args[0] }
          : d.mode === "offset"
            ? { offset: args[0] ?? 0 }
            : d.mode === "none"
              ? {}
              : (args[0] ?? {});
      let value = await (d.command
        ? models.command(method, input)
        : models.fetchResource(method, input));
      if (name === "removeProvider")
        value = { removed: value?.cancelled !== true };
      if (name === "removeWorkspace" && value?.cancelled) value = null;
      return { ok: true, value };
    };
  }
  for (const name of [
    "status",
    "onStatus",
    "restartCore",
    "quit",
    "chooseSkill",
  ])
    facade[name] = (...args) => native[name](...args);
  facade.chooseWorkspace = async () => {
    const path = await models.read("desktop.choose-directory", {});
    return {
      ok: true,
      value:
        path === null ? null : await models.command("workspace.add", { path }),
    };
  };
  return Object.freeze(facade);
}
