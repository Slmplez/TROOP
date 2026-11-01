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
