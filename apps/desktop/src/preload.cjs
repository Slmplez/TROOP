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
    // BEGIN EXECUTION CONTRACT
    followExecution: (input) => call("troop:agent-follow", input),
    getFollowContent: (input) => call("troop:agent-follow-content", input),
    executeOperation: (input) => call("troop:operations-execute", input),
    getOperation: (input) => call("troop:operations-get", input),
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
    compactRun: (id) => call("troop:agent-compact", { id }),
    listContextCheckpoints: (id) => call("troop:agent-checkpoints", { id }),
    listMemoryAgents: () => call("troop:memory-agents", {}),
    listConversations: (offset = 0) => call("troop:conversations", offset),
    listMessages: (id, before = null) => call("troop:messages", id, before),
    createConversation: (input) => call("troop:create-conversation", input),
    sendMessage: (input) => call("troop:send-message", input),
    cancelTurn: (id) => call("troop:cancel-turn", id),
    removeConversation: (id) => call("troop:remove-conversation", id),
    resourcefollowupPreview: (input) =>
      call("troop:resource-followups.preview", input),
    resourcefollowups: (input) => call("troop:resource-followups.list", input),
    resourcefollowup: (input) => call("troop:resource-followups.get", input),
    resourcefollowupChain: (input) =>
      call("troop:resource-followups.chain", input),
    resourcefollowupStopChain: (input) =>
      call("troop:resource-followups.stop_chain", input),
    resourcefollowupHandoff: (input) =>
      call("troop:resource-followups.handoff", input),
    resourcefollowupHistory: (input) =>
      call("troop:resource-followups.history", input),
    resourcefollowupSave: (input) =>
      call("troop:resource-followups.save", input),
    resourcefollowupRequest: (input) =>
      call("troop:resource-followups.request", input),
    resourcefollowupRun: (input) => call("troop:resource-followups.run", input),
    resourcefollowupSetEnabled: (input) =>
      call("troop:resource-followups.set_enabled", input),
    resourcefollowupCancel: (input) =>
      call("troop:resource-followups.cancel", input),
    resourceauthorizationList: (input) =>
      call("troop:resource-authorizations.list", input),
    resourceauthorizationGet: (input) =>
      call("troop:resource-authorizations.get", input),
    resourceauthorizationHistory: (input) =>
      call("troop:resource-authorizations.history", input),
    resourceauthorizationSave: (input) =>
      call("troop:resource-authorizations.save", input),
    resourceauthorizationRevoke: (input) =>
      call("troop:resource-authorizations.revoke", input),
    resourceauthorizationEvaluate: (input) =>
      call("troop:resource-authorizations.evaluate", input),
    resourcesaveMemoryAgent: (input) =>
      call("troop:resource-memory.agent.save", input),
    resourcelistMemoryProjects: (input) =>
      call("troop:resource-memory.projects", input),
    resourcechangeMemoryMembership: (input) =>
      call("troop:resource-memory.membership", input),
    resourcelistMemories: (input) => call("troop:resource-memory.list", input),
    resourcememoryHistory: (input) =>
      call("troop:resource-memory.history", input),
    resourcememoryUsage: (input) => call("troop:resource-memory.usage", input),
    resourcememoryConflicts: (input) =>
      call("troop:resource-memory.conflicts", input),
    resourceresolveMemory: (input) =>
      call("troop:resource-memory.resolve", input),
    resourcerestoreMemory: (input) =>
      call("troop:resource-memory.restore", input),
    resourcewriteMemory: (input) => call("troop:resource-memory.write", input),
    resourceeditMemory: (input) => call("troop:resource-memory.edit", input),
    resourcelistMemoryJobs: (input) =>
      call("troop:resource-memory.jobs", input),
    resourcegetMemoryJob: (input) => call("troop:resource-memory.job", input),
    resourcecancelMemoryJob: (input) =>
      call("troop:resource-memory.job.cancel", input),
    resourceretryMemoryJob: (input) =>
      call("troop:resource-memory.job.retry", input),
    resourceskillList: (input) => call("troop:resource-skills.list", input),
    resourceskillPreview: (input) =>
      call("troop:resource-skills.preview", input),
    resourceskillImport: (input) => call("troop:resource-skills.import", input),
    resourceskillGet: (input) => call("troop:resource-skills.get", input),
    resourceskillVersions: (input) =>
      call("troop:resource-skills.versions", input),
    resourceskillEnable: (input) => call("troop:resource-skills.enable", input),
    resourceskillRemove: (input) => call("troop:resource-skills.remove", input),
    resourceskillEdit: (input) => call("troop:resource-skills.edit", input),
    resourceskillRefresh: (input) =>
      call("troop:resource-skills.refresh", input),
    resourcehookList: (input) => call("troop:resource-hooks.list", input),
    resourcehookDefinition: (input) =>
      call("troop:resource-hooks.definition", input),
    resourcehookSave: (input) => call("troop:resource-hooks.save", input),
    resourcehookRemove: (input) => call("troop:resource-hooks.remove", input),
    resourcehookCalls: (input) => call("troop:resource-hooks.calls", input),
    resourcehookCall: (input) => call("troop:resource-hooks.call", input),
    resourcehookReconcile: (input) =>
      call("troop:resource-hooks.reconcile", input),
    resourcemcpList: (input) => call("troop:resource-mcp.list", input),
    resourcemcpGet: (input) => call("troop:resource-mcp.get", input),
    resourcemcpSave: (input) => call("troop:resource-mcp.save", input),
    resourcemcpRemove: (input) => call("troop:resource-mcp.remove", input),
    resourcemcpRevisions: (input) =>
      call("troop:resource-mcp.revisions", input),
    resourcemcpPreview: (input) => call("troop:resource-mcp.preview", input),
    resourcemcpImport: (input) => call("troop:resource-mcp.import", input),
    resourcemcpAuthStatus: (input) =>
      call("troop:resource-mcp.oauth.status", input),
    resourcemcpAuthBegin: (input) =>
      call("troop:resource-mcp.oauth.begin", input),
    resourcemcpAuthCancel: (input) =>
      call("troop:resource-mcp.oauth.cancel", input),
    resourcemcpAuthRefresh: (input) =>
      call("troop:resource-mcp.oauth.refresh", input),
    resourcemcpAuthDisconnect: (input) =>
      call("troop:resource-mcp.oauth.disconnect", input),
    resourcemcpAuthOpen: (input) =>
      call("troop:resource-desktop.oauth-open", input),
    resourceopenDesktopWindow: (input) =>
      call("troop:resource-desktop.open-window", input),
    resourcemcpRunCatalogue: (input) =>
      call("troop:resource-agent.mcp-catalogue", input),
    resourcemcpRunSessions: (input) =>
      call("troop:resource-agent.mcp-sessions", input),
    resourcemcpRunReconcile: (input) =>
      call("troop:resource-agent.mcp-reconcile", input),
    resourcemcpRunArtifact: (input) =>
      call("troop:resource-agent.mcp-artifact", input),
    resourcelistProviders: (input) =>
      call("troop:resource-provider.list", input),
    resourcesaveProvider: (input) =>
      call("troop:resource-provider.save", input),
    resourceremoveProvider: (input) =>
      call("troop:resource-provider.remove", input),
    resourcelistWorkspaces: (input) =>
      call("troop:resource-workspace.list", input),
    resourceaddWorkspace: (input) =>
      call("troop:resource-workspace.add", input),
    resourcerenameWorkspace: (input) =>
      call("troop:resource-workspace.rename", input),
    resourceremoveWorkspace: (input) =>
      call("troop:resource-workspace.remove", input),
    resourceselectWorkspacePath: (input) =>
      call("troop:resource-desktop.choose-directory", input),
    resourcerulesList: (input) => call("troop:resource-rules.list", input),
    resourcerulesGet: (input) => call("troop:resource-rules.get", input),
    resourcerulesHistory: (input) =>
      call("troop:resource-rules.history", input),
    resourcerulesSave: (input) => call("troop:resource-rules.save", input),
    resourcesetEnabledSchedule: (input) =>
      call("troop:resource-schedules.set_enabled", input),
    resourceschedulePreview: (input) =>
      call("troop:resource-schedules.preview", input),
    resourceschedule: (input) => call("troop:resource-schedules.get", input),
    resourcescheduleHistory: (input) =>
      call("troop:resource-schedules.history", input),
    resourcerunSchedule: (input) => call("troop:resource-schedules.run", input),
    resourcecancelSchedule: (input) =>
      call("troop:resource-schedules.cancel", input),
    resourcerulesSimulate: (input) =>
      call("troop:resource-rules.simulate", input),
    resourceworkItems: (input) => call("troop:resource-work_items.list", input),
    resourcegroups: (input) => call("troop:resource-groups.list", input),
    resourcegroup: (input) => call("troop:resource-groups.get", input),
    resourcegroupExecutor: (input) =>
      call("troop:resource-groups.executor.get", input),
    resourcepreviewGroupExecutor: (input) =>
      call("troop:resource-groups.executor.preview", input),
    resourcesaveGroupExecutor: (input) =>
      call("troop:resource-groups.executor.save", input),
    resourcegroupChain: (input) => call("troop:resource-groups.chain", input),
    resourcestopGroupChain: (input) =>
      call("troop:resource-groups.stop_chain", input),
    resourcepreviewGroupMessage: (input) =>
      call("troop:resource-groups.preview", input),
    resourcesaveGroup: (input) => call("troop:resource-groups.save", input),
    resourcearchiveGroup: (input) =>
      call("troop:resource-groups.archive", input),
    resourceupdateGroupMember: (input) =>
      call("troop:resource-groups.member", input),
    resourcesendGroupMessage: (input) =>
      call("troop:resource-groups.send", input),
    resourcegroupMessages: (input) =>
      call("troop:resource-groups.messages", input),
    resourcegroupDeliveries: (input) =>
      call("troop:resource-groups.deliveries", input),
    resourceresolveGroupDelivery: (input) =>
      call("troop:resource-groups.resolve_delivery", input),
    resourcereminderPreview: (input) =>
      call("troop:resource-reminders.preview", input),
    resourcereminder: (input) => call("troop:resource-reminders.get", input),
    resourcereminderHistory: (input) =>
      call("troop:resource-reminders.history", input),
    resourcecancelReminder: (input) =>
      call("troop:resource-reminders.cancel", input),
    resourcerunReminder: (input) => call("troop:resource-reminders.run", input),
    resourcenotifications: (input) =>
      call("troop:resource-notifications.list", input),
    resourcenotificationPreferences: (input) =>
      call("troop:resource-notifications.preferences", input),
    resourcesaveNotificationPreferences: (input) =>
      call("troop:resource-notifications.preferences.save", input),
    resourcereadNotification: (input) =>
      call("troop:resource-notifications.read", input),
    resourcetopic: (input) => call("troop:resource-topics.get", input),
    resourcetopics: (input) => call("troop:resource-topics.list", input),
    resourcecreateTopic: (input) => call("troop:resource-topics.create", input),
    resourcesaveTopic: (input) => call("troop:resource-topics.save", input),
    resourcetopicMember: (input) => call("troop:resource-topics.member", input),
    resourcearchiveTopic: (input) =>
      call("troop:resource-topics.archive", input),
    resourceworkItem: (input) => call("troop:resource-work_items.get", input),
    resourceworkItemRuns: (input) =>
      call("troop:resource-work_items.runs", input),
    resourcepreviewWorkItem: (input) =>
      call("troop:resource-work_items.preview", input),
    resourcestartWorkItem: (input) =>
      call("troop:resource-work_items.start", input),
    resourceacceptWorkItem: (input) =>
      call("troop:resource-work_items.accept", input),
    resourcecancelWorkItem: (input) =>
      call("troop:resource-work_items.cancel", input),
    resourcesaveWorkItem: (input) =>
      call("troop:resource-work_items.save", input),
    resourcearchiveWorkItem: (input) =>
      call("troop:resource-work_items.archive", input),
    resourceengineCapabilities: (input) =>
      call("troop:resource-engines.capabilities", input),
    resourcelistEngines: (input) => call("troop:resource-engines.list", input),
    resourcecliInteractions: (input) =>
      call("troop:resource-cli.interactions", input),
    resourcecliInteraction: (input) =>
      call("troop:resource-cli.interaction", input),
    resourcerespondCli: (input) => call("troop:resource-cli.respond", input),
    resourcepreviewCli: (input) => call("troop:resource-cli.preview", input),
    resourcestartCli: (input) => call("troop:resource-cli.start", input),
    resourcereviewCli: (input) => call("troop:resource-cli.review", input),
    resourcememoryMaintenanceGet: (input) =>
      call("troop:resource-memory.maintenance.get", input),
    resourcememoryMaintenanceSave: (input) =>
      call("troop:resource-memory.maintenance.save", input),
    resourceeventsHealth: (input) =>
      call("troop:resource-events.health", input),
    resourceeventSources: (input) =>
      call("troop:resource-events.sources", input),
    resourceeventSourceSave: (input) =>
      call("troop:resource-events.source.save", input),
    resourceeventInbox: (input) => call("troop:resource-events.inbox", input),
    resourceeventRecords: (input) =>
      call("troop:resource-events.records", input),
    resourceeventPayload: (input) =>
      call("troop:resource-events.payload", input),
    resourceeventRecheck: (input) =>
      call("troop:resource-events.recheck", input),
    // END EXECUTION CONTRACT
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
    mcpList: (input = {}) => call("troop:mcp-list", input),
    mcpGet: (input) => call("troop:mcp-get", input),
    mcpSave: (input) => call("troop:mcp-save", input),
    mcpRemove: (input) => call("troop:mcp-remove", input),
    mcpRevisions: (input) => call("troop:mcp-revisions", input),
    mcpPreview: (input) => call("troop:mcp-preview", input),
    mcpImport: (input) => call("troop:mcp-import", input),
    mcpAuthStatus: (input) => call("troop:mcp-oauth-status", input),
    mcpAuthBegin: (input) => call("troop:mcp-oauth-begin", input),
    mcpAuthCancel: (input) => call("troop:mcp-oauth-cancel", input),
    mcpAuthRefresh: (input) => call("troop:mcp-oauth-refresh", input),
    mcpAuthDisconnect: (input) => call("troop:mcp-oauth-disconnect", input),
    mcpAuthOpen: (input) => call("troop:mcp-oauth-open", input),
    mcpRunCatalogue: (input) => call("troop:mcp-run-catalogue", input),
    mcpRunSessions: (input) => call("troop:mcp-run-sessions", input),
    mcpRunReconcile: (input) => call("troop:mcp-run-reconcile", input),
    mcpRunArtifact: (input) => call("troop:mcp-run-artifact", input),
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
