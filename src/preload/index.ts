import { contextBridge, ipcRenderer } from "electron";

const api = {
  getUpdateStatus: () => ipcRenderer.invoke("updater:get-status"),
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  openUpdateRelease: (url?: string) => ipcRenderer.invoke("updater:open-release", url),
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  getSettings: () => ipcRenderer.invoke("app:get-settings"),
  detectGameDirectory: () => ipcRenderer.invoke("game:detect"),
  isGameRunning: () => ipcRenderer.invoke("game:is-running"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  confirmCloseWindow: () => ipcRenderer.invoke("window:confirm-close"),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke("app:set-settings", patch),
  getMintStatus: () => ipcRenderer.invoke("mint:status"),
  startMint: () => ipcRenderer.invoke("mint:start"),
  listServers: () => ipcRenderer.invoke("mint:servers"),
  prepare: (server: string) => ipcRenderer.invoke("mint:prepare", server),
  launch: (server: string) => ipcRenderer.invoke("mint:launch", server),
  cancel: (targetId: number) => ipcRenderer.invoke("mint:cancel", targetId),
  confirmTrust: (data: Record<string, unknown>) => ipcRenderer.invoke("mint:trust-confirm", data),
  shutdownMint: () => ipcRenderer.invoke("mint:shutdown"),
  on: (channel: string, callback: (data: any) => void) => {
    const allowed = ["mint:state", "mint:event", "mint:trust-required", "mint:log", "app:close-requested", "updater:status"];
    if (!allowed.includes(channel)) return () => undefined;
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
};
contextBridge.exposeInMainWorld("launcher", api);