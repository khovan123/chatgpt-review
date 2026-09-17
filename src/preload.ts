import { contextBridge, ipcRenderer } from "electron";

const api = {
  getView: () => ipcRenderer.invoke("app:view"),
  updateConfig: (config: Record<string, unknown>) => ipcRenderer.invoke("config:update", config),
  beginCloudflareSetup: (apiToken: string) => ipcRenderer.invoke("cloudflare:setup-begin", { apiToken }),
  provisionCloudflare: (setupId: string, zoneId: string, hostnameLabel?: string) => ipcRenderer.invoke("cloudflare:provision", { setupId, zoneId, hostnameLabel }),
  deprovisionCloudflare: (apiToken: string) => ipcRenderer.invoke("cloudflare:deprovision", { apiToken }),
  connectCloudflare: (hostname: string, tunnelToken: string) => ipcRenderer.invoke("cloudflare:connect", { hostname, tunnelToken }),
  restartCloudflare: () => ipcRenderer.invoke("cloudflare:restart"),
  disconnectCloudflare: () => ipcRenderer.invoke("cloudflare:disconnect"),
  linkRepository: (repository: string) => ipcRenderer.invoke("repo:link", { repository }),
  unlinkRepository: (repository: string) => ipcRenderer.invoke("repo:unlink", { repository }),
  syncRepositoryWebhook: (repository: string) => ipcRenderer.invoke("repo:sync-webhook", { repository }),
  refreshPullRequests: (repository?: string) => ipcRenderer.invoke("pr:refresh", repository ? { repository } : {}),
  runReview: (repository: string, prNumber: number, force = false) => ipcRenderer.invoke("review:run", { repository, prNumber, force }),
  cancelReview: (reviewId: string) => ipcRenderer.invoke("review:cancel", { reviewId }),
  attachSpecs: () => ipcRenderer.invoke("spec:attach"),
  removeSpec: (id: string) => ipcRenderer.invoke("spec:remove", { id }),
  openChatGptSetup: () => ipcRenderer.invoke("chatgpt:setup"),
  openReviewChat: (reviewId: string) => ipcRenderer.invoke("review:open-chat", { reviewId }),
  openExternal: (url: string) => ipcRenderer.invoke("external:open", { url }),
  onReviewEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("review:event", handler);
    return () => ipcRenderer.removeListener("review:event", handler);
  },
};

contextBridge.exposeInMainWorld("reviewApp", api);
