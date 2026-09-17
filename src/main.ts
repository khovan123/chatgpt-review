import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";

import { ChatGptWebDriver } from "./main/chatgpt-web-driver";
import { CloudflareApiProvisioner } from "./main/cloudflare-api";
import { CloudflareNamedTunnelManager, cloudflareOriginUrl, normalizeCloudflareHostname } from "./main/cloudflare-tunnel";
import { GitHubProvider, normalizeGitHubRepositoryInput } from "./main/github-provider";
import { ReviewEngine, type ReviewEngineEvent } from "./main/review-engine";
import { SpecMemoryStore } from "./main/spec-memory";
import { StateStore } from "./main/state-store";
import type { AppView, ReviewConfig } from "./main/types";
import { GitHubWebhookServer, WEBHOOK_HEALTH_PATH, WebhookSecretStore } from "./main/webhook-server";

let mainWindow: BrowserWindow | null = null;
let engine: ReviewEngine | null = null;
let state: StateStore | null = null;
let specs: SpecMemoryStore | null = null;
let chatgpt: ChatGptWebDriver | null = null;
let webhookServer: GitHubWebhookServer | null = null;
let cloudflare: CloudflareNamedTunnelManager | null = null;
let cloudflareApi: CloudflareApiProvisioner | null = null;

void app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  state = new StateStore(path.join(userData, "state.json"));
  specs = new SpecMemoryStore(path.join(userData, "spec-memory.json"));
  const secretStore = new WebhookSecretStore(path.join(userData, "github-webhook-secret"));
  const [, , webhookSecret] = await Promise.all([state.load(), specs.load(), secretStore.loadOrCreate()]);

  chatgpt = new ChatGptWebDriver((progress) => {
    publish({ type: "progress", taskId: progress.taskId, message: progress.text });
  });
  engine = new ReviewEngine({
    state,
    specs,
    github: new GitHubProvider(),
    chatgpt,
    webhookSecret,
    onEvent: publish,
  });
  webhookServer = new GitHubWebhookServer({
    state,
    secret: webhookSecret,
    onEvent: (event) => requireEngine().handleWebhookEvent(event),
    onProgress: (message) => publish({ type: "progress", message }),
  });
  cloudflare = new CloudflareNamedTunnelManager({
    storageDirectory: userData,
    onLog: (message) => publish({ type: "progress", message: `cloudflared: ${message}` }),
    onStatus: (status) => {
      if (status.lastError) publish({ type: "progress", message: `Cloudflare tunnel: ${status.lastError}` });
    },
  });
  cloudflareApi = new CloudflareApiProvisioner();

  await startWebhookIngress().catch((error) => {
    publish({ type: "progress", message: `Webhook listener failed to start: ${safeError(error)}` });
  });
  await requireCloudflare().detect();
  await engine.initialize();
  await restoreCloudflareTunnel().catch((error) => {
    requireCloudflare().setRouteValidation(false, safeError(error));
    publish({ type: "progress", message: `Personal Cloudflare tunnel restore failed: ${safeError(error)}` });
  });

  mainWindow = createMainWindow();
  registerIpc();
});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  requireCloudflareApiOrNull()?.clearSessions();
  void chatgpt?.shutdown();
  void cloudflare?.stop();
  void webhookServer?.stop();
});

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    title: "ChatGPT Review",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    },
  });
  void window.loadFile(path.join(app.getAppPath(), "src", "renderer", "index.html"));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function registerIpc(): void {
  ipcMain.handle("app:view", async (event) => {
    assertSender(event.sender.id);
    return getAppView();
  });

  ipcMain.handle("config:update", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input)) throw new Error("Config update is invalid.");
    validateConfigInput(input);
    const before = requireState().getConfig();
    const requestedHost = typeof input.webhookListenHost === "string" ? input.webhookListenHost : before.webhookListenHost;
    const requestedPort = input.webhookListenPort === undefined ? before.webhookListenPort : Number(input.webhookListenPort);
    const listenerWouldChange = requestedHost !== before.webhookListenHost || requestedPort !== before.webhookListenPort;
    if (listenerWouldChange && before.cloudflareHostname) {
      throw new Error("Local webhook host/port is locked while a named tunnel is connected. Disconnect or remove the managed Cloudflare tunnel before changing the origin.");
    }

    const next = await requireState().setConfig(input as Partial<ReviewConfig>);
    await requireEngine().refreshProviderStatus();
    if (listenerWouldChange) await startWebhookIngress();
    return getAppView();
  });

  ipcMain.handle("cloudflare:setup-begin", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input) || typeof input.apiToken !== "string") throw new Error("Cloudflare API token is required.");
    if (requireState().getConfig().cloudflareHostname) {
      throw new Error("A Cloudflare named tunnel is already connected. Remove or disconnect it before provisioning another tunnel.");
    }
    return requireCloudflareApi().beginSetup(input.apiToken);
  });

  ipcMain.handle("cloudflare:provision", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input) || typeof input.setupId !== "string" || typeof input.zoneId !== "string") {
      throw new Error("Cloudflare provisioning request is invalid.");
    }
    if (requireState().listRepositories().length > 0) {
      throw new Error("Disconnect linked repositories before provisioning a new Cloudflare endpoint.");
    }
    const config = requireState().getConfig();
    if (config.cloudflareHostname || requireCloudflare().status().configured) {
      throw new Error("A Cloudflare named tunnel is already configured on this installation.");
    }

    const originUrl = localTunnelOrigin(config);
    const provisioned = await requireCloudflareApi().provision({
      setupId: input.setupId,
      zoneId: input.zoneId,
      originUrl,
      hostnameLabel: typeof input.hostnameLabel === "string" ? input.hostnameLabel : undefined,
    });

    await requireState().setCloudflareProvisioning(provisioned.record);
    await requireState().setConfig({ cloudflareHostname: provisioned.record.hostname });
    await startWebhookIngress();

    try {
      await requireCloudflare().connect({
        hostname: provisioned.record.hostname,
        tunnelToken: provisioned.runtimeToken,
        originUrl,
      });
      await verifyCloudflareRoute(provisioned.record.hostname);
      requireCloudflare().setRouteValidation(true);
      await requireEngine().syncAllWebhooks();
    } catch (error) {
      const detail = `Cloudflare resources were provisioned in your account, but the local connector/route is not ready yet. The runtime tunnel token is retained locally; the API token was discarded. ${safeError(error)}`;
      requireCloudflare().setRouteValidation(false, detail);
      throw new Error(detail);
    }
    return getAppView();
  });

  ipcMain.handle("cloudflare:deprovision", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input) || typeof input.apiToken !== "string") throw new Error("Cloudflare API token is required to delete managed Cloudflare resources.");
    if (requireState().listRepositories().length > 0) {
      throw new Error("Disconnect linked repositories before deleting the managed Cloudflare tunnel and DNS record.");
    }
    const record = requireState().getCloudflareProvisioning();
    if (!record) throw new Error("This installation does not have API-provisioned Cloudflare resources.");

    // Stop the active connector before deleting the remote named tunnel. The runtime token
    // remains on disk until remote cleanup succeeds, so a failed cleanup can be retried.
    await requireCloudflare().stop();
    await requireCloudflareApi().deprovision(input.apiToken, record);
    await requireCloudflare().disconnect();
    await requireState().setCloudflareProvisioning(null);
    await requireState().setConfig({ cloudflareHostname: "" });
    await startWebhookIngress();
    return getAppView();
  });

  ipcMain.handle("cloudflare:connect", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input) || typeof input.hostname !== "string" || typeof input.tunnelToken !== "string") {
      throw new Error("Cloudflare hostname and named tunnel token are required.");
    }
    if (requireState().getCloudflareProvisioning()) {
      throw new Error("This installation already owns API-provisioned Cloudflare resources. Remove them before switching to a manually managed tunnel.");
    }
    const hostname = normalizeCloudflareHostname(input.hostname);
    const config = requireState().getConfig();
    await requireCloudflare().connect({
      hostname,
      tunnelToken: input.tunnelToken,
      originUrl: localTunnelOrigin(config),
    });
    await requireState().setConfig({ cloudflareHostname: hostname });
    await startWebhookIngress();
    try {
      await verifyCloudflareRoute(hostname);
      requireCloudflare().setRouteValidation(true);
      await requireEngine().syncAllWebhooks();
    } catch (error) {
      const detail = `Named tunnel is running, but https://${hostname}${WEBHOOK_HEALTH_PATH} is not reaching this app. Configure that hostname in your Cloudflare tunnel to proxy to ${localTunnelOrigin(config)}. ${safeError(error)}`;
      requireCloudflare().setRouteValidation(false, detail);
      throw new Error(detail);
    }
    return getAppView();
  });

  ipcMain.handle("cloudflare:restart", async (event) => {
    assertSender(event.sender.id);
    const config = requireState().getConfig();
    if (!config.cloudflareHostname) throw new Error("Connect a personal Cloudflare named tunnel first.");
    await requireCloudflare().restore({ hostname: config.cloudflareHostname, originUrl: localTunnelOrigin(config) });
    await verifyCloudflareRoute(config.cloudflareHostname);
    requireCloudflare().setRouteValidation(true);
    await requireEngine().syncAllWebhooks();
    return getAppView();
  });

  ipcMain.handle("cloudflare:disconnect", async (event) => {
    assertSender(event.sender.id);
    if (requireState().listRepositories().length > 0) {
      throw new Error("Disconnect linked repositories before removing the personal Cloudflare tunnel. This prevents leaving GitHub webhooks pointed at an offline endpoint.");
    }
    if (requireState().getCloudflareProvisioning()) {
      throw new Error("This tunnel was provisioned by the app. Use Remove managed Cloudflare resources and provide a fresh API token so the DNS record and named tunnel are deleted from your account too.");
    }
    await requireCloudflare().disconnect();
    await requireState().setConfig({ cloudflareHostname: "" });
    await startWebhookIngress();
    return getAppView();
  });

  ipcMain.handle("repo:link", async (event, input: unknown) => {
    assertSender(event.sender.id);
    const repository = repositoryFromInput(input);
    const tunnel = requireCloudflare().status();
    if (!tunnel.running || !tunnel.reachable) throw new Error("Connect and verify your personal Cloudflare named tunnel before linking repositories.");
    await requireEngine().linkRepository(repository);
    return getAppView();
  });

  ipcMain.handle("repo:unlink", async (event, input: unknown) => {
    assertSender(event.sender.id);
    const repository = repositoryFromInput(input);
    await requireEngine().unlinkRepository(repository);
    return getAppView();
  });

  ipcMain.handle("repo:sync-webhook", async (event, input: unknown) => {
    assertSender(event.sender.id);
    const repository = repositoryFromInput(input);
    const tunnel = requireCloudflare().status();
    if (!tunnel.running || !tunnel.reachable) throw new Error("Personal Cloudflare named tunnel is not ready.");
    await requireEngine().syncRepositoryWebhook(repository);
    return getAppView();
  });

  ipcMain.handle("pr:refresh", async (event, input: unknown) => {
    assertSender(event.sender.id);
    const repository = isRecord(input) && typeof input.repository === "string" && input.repository.trim()
      ? repositoryFromInput(input)
      : undefined;
    await requireEngine().refreshPullRequests(repository);
    return getAppView();
  });

  ipcMain.handle("review:run", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input) || !Number.isSafeInteger(input.prNumber) || Number(input.prNumber) < 1) throw new Error("Review request is invalid.");
    const repository = repositoryFromInput(input);
    const review = await requireEngine().enqueueReview(repository, Number(input.prNumber), input.force === true, "manual");
    return review;
  });

  ipcMain.handle("review:cancel", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input) || typeof input.reviewId !== "string" || !input.reviewId.trim()) throw new Error("Review id is invalid.");
    await requireEngine().cancelReview(input.reviewId);
    return getAppView();
  });

  ipcMain.handle("spec:attach", async (event) => {
    assertSender(event.sender.id);
    const options: OpenDialogOptions = {
      title: "Attach specification memory",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Specs", extensions: ["pdf", "docx", "md", "mdx", "txt", "json", "yaml", "yml", "csv", "ts", "tsx", "js", "jsx", "html", "xml"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (!result.canceled && result.filePaths.length) await requireSpecs().addFiles(result.filePaths);
    return getAppView();
  });

  ipcMain.handle("spec:remove", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input) || typeof input.id !== "string" || !/^spec_[a-f0-9]{16}$/.test(input.id)) throw new Error("Spec id is invalid.");
    await requireSpecs().remove(input.id);
    return getAppView();
  });

  ipcMain.handle("chatgpt:setup", async (event) => {
    assertSender(event.sender.id);
    await requireChatGpt().showSetup();
    return true;
  });

  ipcMain.handle("review:open-chat", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input) || typeof input.reviewId !== "string") throw new Error("Review id is invalid.");
    const review = requireState().getReview(input.reviewId);
    if (!review) throw new Error("Review was not found.");
    const repository = requireState().getRepository(review.repository);
    await requireChatGpt().showConversation(review.conversationUrl ?? repository?.chatgptProjectUrl);
    return true;
  });

  ipcMain.handle("external:open", async (event, input: unknown) => {
    assertSender(event.sender.id);
    if (!isRecord(input) || typeof input.url !== "string") throw new Error("URL is invalid.");
    const url = new URL(input.url);
    if (url.protocol !== "https:") throw new Error("Only HTTPS links may be opened.");
    await shell.openExternal(url.toString());
    return true;
  });
}

async function startWebhookIngress(): Promise<void> {
  const config = requireState().getConfig();
  await requireWebhookServer().start({
    host: config.webhookListenHost,
    port: config.webhookListenPort,
    publicUrl: config.webhookPublicUrl,
  });
}

async function restoreCloudflareTunnel(): Promise<void> {
  const config = requireState().getConfig();
  if (!config.cloudflareHostname) return;
  const status = await requireCloudflare().restore({
    hostname: config.cloudflareHostname,
    originUrl: localTunnelOrigin(config),
  });
  if (!status.running) return;
  await verifyCloudflareRoute(config.cloudflareHostname);
  requireCloudflare().setRouteValidation(true);
  await requireEngine().syncAllWebhooks();
}

async function verifyCloudflareRoute(hostname: string): Promise<void> {
  const origin = cloudflareOriginUrl(hostname);
  let lastError = "route is not ready";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await delay(1_500);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${origin}${WEBHOOK_HEALTH_PATH}`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        lastError = `health check returned HTTP ${response.status}`;
        continue;
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new Error("health response is oversized");
      const payload = JSON.parse(text) as unknown;
      if (isRecord(payload) && payload.status === "ok" && payload.service === "chatgpt-review-webhook") return;
      lastError = "health check returned an unexpected response";
    } catch (error) {
      lastError = safeError(error);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError);
}

function localTunnelOrigin(config: ReviewConfig): string {
  const host = config.webhookListenHost === "0.0.0.0" || config.webhookListenHost === "::"
    ? "127.0.0.1"
    : config.webhookListenHost;
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formatted}:${config.webhookListenPort}`;
}

async function getAppView(): Promise<AppView> {
  return {
    ...await requireEngine().view(),
    cloudflareProvisioning: requireState().getCloudflareProvisioning(),
    webhook: requireWebhookServer().status(),
    tunnel: requireCloudflare().status(),
  };
}

function publish(event: ReviewEngineEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("review:event", event);
}

function assertSender(senderId: number): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== senderId) throw new Error("IPC sender is not the trusted application window.");
}

function validateConfigInput(input: Record<string, any>): void {
  if ("webhookPublicUrl" in input || "cloudflareHostname" in input) {
    throw new Error("Cloudflare hostname and public webhook URL are managed only by the personal named-tunnel connection flow.");
  }
  if (typeof input.webhookListenHost === "string" && !["127.0.0.1", "0.0.0.0", "::1", "::"].includes(input.webhookListenHost)) {
    throw new Error("Webhook listen host is invalid.");
  }
  if (input.webhookListenPort !== undefined) {
    const port = Number(input.webhookListenPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Webhook listen port is invalid.");
  }
}

function repositoryFromInput(input: unknown): string {
  if (!isRecord(input) || typeof input.repository !== "string") throw new Error("Repository is required.");
  return normalizeGitHubRepositoryInput(input.repository);
}

function requireEngine(): ReviewEngine {
  if (!engine) throw new Error("Review engine is not initialized.");
  return engine;
}

function requireState(): StateStore {
  if (!state) throw new Error("State store is not initialized.");
  return state;
}

function requireSpecs(): SpecMemoryStore {
  if (!specs) throw new Error("Spec memory is not initialized.");
  return specs;
}

function requireChatGpt(): ChatGptWebDriver {
  if (!chatgpt) throw new Error("ChatGPT Web driver is not initialized.");
  return chatgpt;
}

function requireWebhookServer(): GitHubWebhookServer {
  if (!webhookServer) throw new Error("GitHub webhook server is not initialized.");
  return webhookServer;
}

function requireCloudflare(): CloudflareNamedTunnelManager {
  if (!cloudflare) throw new Error("Cloudflare tunnel manager is not initialized.");
  return cloudflare;
}

function requireCloudflareApi(): CloudflareApiProvisioner {
  if (!cloudflareApi) throw new Error("Cloudflare API provisioner is not initialized.");
  return cloudflareApi;
}

function requireCloudflareApiOrNull(): CloudflareApiProvisioner | null {
  return cloudflareApi;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1000) : "unknown error";
}
