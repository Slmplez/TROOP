const { contextBridge, ipcRenderer } = require("electron");
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld(
  "troop",
  Object.freeze({
    status: () => call("troop:status"),
    listWorkspaces: (offset = 0) => call("troop:workspaces", offset),
    chooseWorkspace: () => call("troop:choose-workspace"),
    renameWorkspace: (id, name) => call("troop:rename-workspace", id, name),
    removeWorkspace: (id) => call("troop:remove-workspace", id),
    restartCore: () => call("troop:restart-core"),
    listProviders: () => call("troop:providers"),
    saveProvider: (input) => call("troop:save-provider", input),
    removeProvider: (id) => call("troop:remove-provider", id),
    listConversations: (offset = 0) => call("troop:conversations", offset),
    createConversation: (input) => call("troop:create-conversation", input),
    removeConversation: (id) => call("troop:remove-conversation", id),
    listMessages: (id, before = null) => call("troop:messages", id, before),
    sendMessage: (input) => call("troop:send-message", input),
    cancelTurn: (id) => call("troop:cancel-turn", id),
    listRuns: (offset = 0) => call("troop:agent-list", { offset }),
    getRun: (id) => call("troop:agent-get", { id }),
    getRunContent: (id, field) => call("troop:agent-content", { id, field }),
    listRunEvents: (id, before = null) =>
      call("troop:agent-events", { id, before }),
    getRunEvent: (id) => call("troop:agent-event", { id }),
    getInvocation: (id) => call("troop:agent-invocation", { id }),
    startRun: (input) => call("troop:agent-start", input),
    cancelRun: (id) => call("troop:agent-cancel", { id }),
    approveInvocation: (input) => call("troop:agent-approve", input),
    steerRun: (input) => call("troop:agent-steer", input),
    reconcileInvocation: (input) => call("troop:agent-reconcile", input),
    resumeRun: (id) => call("troop:agent-resume", { id }),
    listOwnedTasks: (id) => call("troop:agent-tasks", { id }),
    getOwnedTask: (id) => call("troop:agent-task", { id }),
    stopOwnedTask: (id) => call("troop:agent-stop-task", { id }),
    reconcileOwnedTask: (input) => call("troop:agent-reconcile-task", input),
    listMemoryAgents: () => call("troop:memory-agents", {}),
    saveMemoryAgent: (input) => call("troop:memory-agent.save", input),
    listMemoryProjects: (agent_id) =>
      call("troop:memory-projects", { agent_id }),
    changeMemoryMembership: (input) => call("troop:memory-membership", input),
    listMemories: (agent_id, offset = 0) =>
      call("troop:memory-list", { agent_id, offset }),
    writeMemory: (input) => call("troop:memory-write", input),
    editMemory: (input) => call("troop:memory-edit", input),
    listMemoryJobs: (agent_id) => call("troop:memory-jobs", { agent_id }),
    getMemoryJob: (id) => call("troop:memory-job", { id }),
    cancelMemoryJob: (id) => call("troop:memory-job.cancel", { id }),
    retryMemoryJob: (id) => call("troop:memory-job.retry", { id }),
    compactRun: (id) => call("troop:agent-compact", { id }),
    listContextCheckpoints: (id) => call("troop:agent-checkpoints", { id }),
    chooseSkill: () => call("troop:skills-choose"),
    skillList: (input = {}) => call("troop:skills-list", input),
    skillPreview: (input = {}) => call("troop:skills-preview", input),
    skillImport: (input = {}) => call("troop:skills-import", input),
    skillGet: (input = {}) => call("troop:skills-get", input),
    skillVersions: (input = {}) => call("troop:skills-versions", input),
    skillEnable: (input = {}) => call("troop:skills-enable", input),
    skillRemove: (input = {}) => call("troop:skills-remove", input),
    skillEdit: (input = {}) => call("troop:skills-edit", input),
    skillRefresh: (input = {}) => call("troop:skills-refresh", input),
    hookList: (input = {}) => call("troop:hooks-list", input),
    hookDefinition: (input = {}) => call("troop:hooks-definition", input),
    hookSave: (input = {}) => call("troop:hooks-save", input),
    hookCalls: (input = {}) => call("troop:hooks-calls", input),
    hookCall: (input = {}) => call("troop:hooks-call", input),
    hookReconcile: (input = {}) => call("troop:hooks-reconcile", input),
    hookRemove: (input = {}) => call("troop:hooks-remove", input),
    quit: () => call("troop:quit"),
    onStatus: (callback) => {
      if (typeof callback !== "function") throw Error("Callback required");
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("troop:core-status", listener);
      return () => ipcRenderer.removeListener("troop:core-status", listener);
    },
    onChatEvent: (callback) => {
      if (typeof callback !== "function") throw Error("Callback required");
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("troop:chat-event", listener);
      return () => ipcRenderer.removeListener("troop:chat-event", listener);
    },
  }),
);
