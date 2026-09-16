import { BrowserWindow, session, shell, type Session, type WebContents } from "electron";

const CHATGPT_URL = "https://chatgpt.com/";
const PARTITION = "persist:chatgpt-pr-review";
const POLL_MS = 400;
const COMPOSER_WAIT_MS = 8_000;
const INTERACTIVE_WAIT_MS = 5 * 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const HARD_TIMEOUT_MS = 30 * 60_000;
const MAX_INPUT_BYTES = 120 * 1024;
const MAX_OUTPUT_BYTES = 120 * 1024;
const STABLE_POLLS = 3;

export interface ChatGptProgress {
  taskId: string;
  text: string;
  generating: boolean;
}

export class ChatGptWebDriver {
  private window: BrowserWindow | null = null;
  private readonly webSession: Session;
  private currentTaskId: string | null = null;
  private shuttingDown = false;

  constructor(private readonly onProgress?: (progress: ChatGptProgress) => void) {
    this.webSession = session.fromPartition(PARTITION, { cache: true });
    this.webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.webSession.setPermissionCheckHandler(() => false);
  }

  async ready(): Promise<boolean> {
    const window = await this.ensureWindow(false);
    const contents = liveWebContents(window);
    if (!isChatGptOrigin(safeWebContentsUrl(contents))) return false;
    return composerReady(contents).catch(() => false);
  }

  async showSetup(): Promise<void> {
    const window = await this.ensureWindow(false);
    window.show();
    window.focus();
  }

  async startTask(taskId: string, repositoryConversationUrl?: string): Promise<void> {
    assertTaskId(taskId);
    if (this.currentTaskId && this.currentTaskId !== taskId) {
      throw new Error("Another ChatGPT review task is already using the web session.");
    }
    const targetConversation = repositoryConversationUrl === undefined
      ? null
      : normalizeConversationUrl(repositoryConversationUrl);
    this.currentTaskId = taskId;
    try {
      const window = await this.ensureWindow(false);
      const currentUrl = safeWebContentsUrl(liveWebContents(window));
      const targetUrl = targetConversation ?? CHATGPT_URL;
      if (currentUrl !== targetUrl) await window.loadURL(targetUrl);
      await this.ensureComposer(window, taskId);
    } catch (error) {
      if (this.currentTaskId === taskId) this.currentTaskId = null;
      throw error;
    }
  }

  finishTask(taskId: string): void {
    assertTaskId(taskId);
    if (this.currentTaskId === taskId) this.currentTaskId = null;
  }

  async send(
    taskId: string,
    message: string,
    onConversationUrl?: (conversationUrl: string) => Promise<void> | void,
  ): Promise<{ text: string; conversationUrl: string }> {
    assertTaskId(taskId);
    if (this.currentTaskId !== taskId) throw new Error("ChatGPT review task is not the active web conversation.");
    if (Buffer.byteLength(message, "utf8") > MAX_INPUT_BYTES) throw new Error("ChatGPT review prompt exceeds the 120 KiB bound.");
    const window = await this.ensureWindow(false);
    await this.ensureComposer(window, taskId);
    const contents = liveWebContents(window);
    const text = await this.sendAndReceive(contents, taskId, message, onConversationUrl);
    const currentUrl = safeWebContentsUrl(contents);
    const conversationUrl = safeConversationUrl(currentUrl) || (isChatGptOrigin(currentUrl) ? currentUrl : CHATGPT_URL);
    return { text, conversationUrl };
  }

  async showConversation(url?: string): Promise<void> {
    const window = await this.ensureWindow(false);
    if (!this.currentTaskId && url && allowedNavigation(url) && url.startsWith("https://chatgpt.com/")) {
      const currentUrl = safeWebContentsUrl(liveWebContents(window));
      if (currentUrl !== url) await window.loadURL(url);
    }
    window.show();
    window.focus();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.currentTaskId = null;
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  private async ensureWindow(_newConversation: boolean): Promise<BrowserWindow> {
    let window = this.window;
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({
        width: 1180,
        height: 820,
        minWidth: 900,
        minHeight: 640,
        show: false,
        title: "ChatGPT Review · Web Session",
        autoHideMenuBar: true,
        webPreferences: {
          session: this.webSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          spellcheck: false,
          devTools: false,
        },
      });
      configureNavigation(window);
      this.configureLifecycle(window);
      this.window = window;
      await window.loadURL(CHATGPT_URL);
    }
    return window;
  }

  private configureLifecycle(window: BrowserWindow): void {
    window.on("close", (event) => {
      if (this.shuttingDown) return;
      event.preventDefault();
      if (!window.isDestroyed()) window.hide();
    });
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
  }

  private async ensureComposer(window: BrowserWindow, taskId: string): Promise<void> {
    const hiddenDeadline = Date.now() + COMPOSER_WAIT_MS;
    while (Date.now() < hiddenDeadline) {
      this.assertTask(taskId);
      const contents = liveWebContents(window);
      if (isChatGptOrigin(safeWebContentsUrl(contents)) && await composerReady(contents).catch(() => false)) {
        if (window.isVisible()) window.hide();
        return;
      }
      await delay(POLL_MS);
    }

    window.show();
    window.focus();
    const interactiveDeadline = Date.now() + INTERACTIVE_WAIT_MS;
    while (Date.now() < interactiveDeadline) {
      this.assertTask(taskId);
      const contents = liveWebContents(window);
      if (isChatGptOrigin(safeWebContentsUrl(contents)) && await composerReady(contents).catch(() => false)) {
        window.hide();
        return;
      }
      await delay(POLL_MS);
    }
    throw new Error("ChatGPT Web is not ready. Sign in to ChatGPT in the opened review window, configure the Atlassian connector, then retry.");
  }

  private async sendAndReceive(
    contents: WebContents,
    taskId: string,
    message: string,
    onConversationUrl?: (conversationUrl: string) => Promise<void> | void,
  ): Promise<string> {
    this.assertTask(taskId);
    assertLiveWebContents(contents);
    if (!isChatGptOrigin(safeWebContentsUrl(contents))) throw new Error("ChatGPT review window is not on chatgpt.com.");
    await waitForConversationSettled(contents, () => this.assertTask(taskId));
    const before = await assistantSnapshot(contents);

    const focused = await executeJavaScriptSafe<boolean>(contents, `(() => {
      const el = document.querySelector('#prompt-textarea') || document.querySelector('textarea[data-testid="prompt-textarea"]') || document.querySelector('textarea');
      if (!(el instanceof HTMLElement)) return false;
      el.focus();
      if (el instanceof HTMLTextAreaElement) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.textContent = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
      return true;
    })()`);
    if (!focused) throw new Error("ChatGPT composer is unavailable.");
    assertLiveWebContents(contents);
    contents.insertText(message);

    const sendDeadline = Date.now() + 5_000;
    let sent = false;
    while (Date.now() < sendDeadline) {
      this.assertTask(taskId);
      sent = await clickSend(contents);
      if (sent) break;
      await delay(100);
    }
    if (!sent) throw new Error("ChatGPT review prompt could not be submitted.");

    const hardDeadline = Date.now() + HARD_TIMEOUT_MS;
    let idleDeadline = Date.now() + IDLE_TIMEOUT_MS;
    let lastSignature = signature(before);
    let stableText = "";
    let stablePolls = 0;
    let lastProgress = "";
    let boundConversationUrl = "";

    while (Date.now() < hardDeadline && Date.now() < idleDeadline) {
      this.assertTask(taskId);
      const currentConversationUrl = safeConversationUrl(safeWebContentsUrl(contents));
      if (currentConversationUrl && currentConversationUrl !== boundConversationUrl) {
        boundConversationUrl = currentConversationUrl;
        await onConversationUrl?.(currentConversationUrl);
      }
      const snapshot = await assistantSnapshot(contents);
      const currentSignature = signature(snapshot);
      if (snapshot.generating || currentSignature !== lastSignature) {
        lastSignature = currentSignature;
        idleDeadline = Date.now() + IDLE_TIMEOUT_MS;
      }
      const isNewTurn = snapshot.latestTurnId
        ? !before.turnIds.includes(snapshot.latestTurnId)
        : snapshot.count > before.count;
      if (isNewTurn && snapshot.text) {
        const progress = progressSummary(snapshot.text);
        if (progress !== lastProgress) {
          lastProgress = progress;
          this.onProgress?.({ taskId, text: progress, generating: snapshot.generating });
        }
      }
      if (isNewTurn && !snapshot.generating && snapshot.text.trim()) {
        if (snapshot.text === stableText) stablePolls += 1;
        else {
          stableText = snapshot.text;
          stablePolls = 1;
        }
        if (stablePolls >= STABLE_POLLS) {
          if (Buffer.byteLength(stableText, "utf8") > MAX_OUTPUT_BYTES) throw new Error("ChatGPT review response exceeds the 120 KiB bound.");
          return stableText;
        }
      }
      await delay(POLL_MS);
    }
    throw new Error(Date.now() >= hardDeadline
      ? "ChatGPT Web reached the 30 minute hard limit before returning a stable review response."
      : "ChatGPT Web produced no review progress for 10 minutes.");
  }

  private assertTask(taskId: string): void {
    if (this.currentTaskId !== taskId) throw new Error("ChatGPT review task changed while the web turn was running.");
  }
}

function configureNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedNavigation(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            devTools: false,
          },
        },
      };
    }
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("did-create-window", (child) => configureNavigation(child));
  window.webContents.on("will-navigate", (event, target) => {
    if (!allowedNavigation(target)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, target) => {
    if (!allowedNavigation(target)) event.preventDefault();
  });
}

function allowedNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "chatgpt.com"
      || host === "auth.openai.com"
      || host === "accounts.google.com"
      || host.endsWith(".accounts.google.com")
      || host === "login.microsoftonline.com"
      || host === "login.live.com"
      || host === "appleid.apple.com"
      || host === "id.atlassian.com"
      || host.endsWith(".atlassian.com");
  } catch {
    return false;
  }
}

function safeConversationUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.pathname === "/") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeConversationUrl(value: string): string {
  const normalized = safeConversationUrl(value);
  if (!normalized) throw new Error("Stored ChatGPT repository conversation URL is invalid.");
  return normalized;
}

function isChatGptOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

async function composerReady(contents: WebContents): Promise<boolean> {
  return executeJavaScriptSafe<boolean>(contents, `(() => {
    const el = document.querySelector('#prompt-textarea') || document.querySelector('textarea[data-testid="prompt-textarea"]') || document.querySelector('textarea');
    return el instanceof HTMLElement && !el.hasAttribute('disabled');
  })()`);
}

async function clickSend(contents: WebContents): Promise<boolean> {
  return executeJavaScriptSafe<boolean>(contents, `(() => {
    const button = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label="Send prompt"]') || document.querySelector('button[aria-label^="Send"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
}

async function waitForConversationSettled(contents: WebContents, assertTask: () => void): Promise<void> {
  const deadline = Date.now() + 3_000;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    assertTask();
    const snapshot = await assistantSnapshot(contents);
    if (snapshot.generating) {
      stable = 0;
      last = "";
    } else {
      const next = signature(snapshot);
      if (next === last) stable += 1;
      else {
        last = next;
        stable = 1;
      }
      if (stable >= 2) return;
    }
    await delay(POLL_MS);
  }
}

type AssistantSnapshot = { count: number; text: string; generating: boolean; turnIds: string[]; latestTurnId: string };

async function assistantSnapshot(contents: WebContents): Promise<AssistantSnapshot> {
  const value = await executeJavaScriptSafe<{ count?: unknown; text?: unknown; generating?: unknown; turnIds?: unknown; latestTurnId?: unknown }>(contents, `(() => {
    const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const ids = messages.map((message) => {
      if (!(message instanceof HTMLElement)) return '';
      const explicit = message.getAttribute('data-turn-id') || message.getAttribute('data-message-id') || '';
      const container = message.closest('[data-turn-id-container], [data-turn-id]');
      return explicit || (container instanceof HTMLElement ? (container.getAttribute('data-turn-id') || '') : '');
    }).filter(Boolean);
    const latest = messages[messages.length - 1];
    const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"]');
    return {
      count: messages.length,
      text: latest instanceof HTMLElement ? latest.innerText : '',
      generating: Boolean(stop),
      turnIds: ids,
      latestTurnId: ids[ids.length - 1] || '',
    };
  })()`);
  const turnIds = Array.isArray(value.turnIds) ? value.turnIds.filter((item): item is string => typeof item === "string" && item.length <= 256) : [];
  return {
    count: Number.isSafeInteger(value.count) ? Number(value.count) : 0,
    text: typeof value.text === "string" ? value.text : "",
    generating: value.generating === true,
    turnIds,
    latestTurnId: typeof value.latestTurnId === "string" && value.latestTurnId.length <= 256 ? value.latestTurnId : "",
  };
}

function liveWebContents(window: BrowserWindow): WebContents {
  if (window.isDestroyed()) {
    throw new Error("ChatGPT Web review window became unavailable. Retry the review.");
  }
  const contents = window.webContents;
  assertLiveWebContents(contents);
  return contents;
}

function assertLiveWebContents(contents: WebContents): void {
  if (contents.isDestroyed()) {
    throw new Error("ChatGPT Web review session became unavailable while the review was running. Retry the review.");
  }
}

function safeWebContentsUrl(contents: WebContents): string {
  assertLiveWebContents(contents);
  try {
    return contents.getURL();
  } catch (error) {
    if (isDestroyedObjectError(error)) {
      throw new Error("ChatGPT Web review session became unavailable while the review was running. Retry the review.");
    }
    throw error;
  }
}

async function executeJavaScriptSafe<T>(contents: WebContents, source: string): Promise<T> {
  assertLiveWebContents(contents);
  try {
    return await contents.executeJavaScript(source, true) as T;
  } catch (error) {
    if (contents.isDestroyed() || isDestroyedObjectError(error)) {
      throw new Error("ChatGPT Web review session became unavailable while the review was running. Retry the review.");
    }
    throw error;
  }
}

function isDestroyedObjectError(error: unknown): boolean {
  return error instanceof Error && /object has been destroyed|webcontents.*destroyed/i.test(error.message);
}

function signature(snapshot: AssistantSnapshot): string {
  return `${snapshot.count}:${snapshot.latestTurnId}:${snapshot.text.length}:${snapshot.text.slice(-120)}`;
}

function progressSummary(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned || /^thinking\b/i.test(cleaned)) return "ChatGPT is processing the current review step…";
  if (cleaned.includes("[JIRA_CONTEXT]")) return "ChatGPT is resolving Jira evidence…";
  if (cleaned.includes("[CHUNK_REVIEW]")) return "ChatGPT is producing the current diff-chunk review…";
  if (cleaned.includes("[PR_REVIEW]")) return "ChatGPT is synthesizing the final review…";
  return "ChatGPT is generating the current review step…";
}

function assertTaskId(value: string): void {
  if (!/^review_[a-f0-9]{16}$/.test(value)) throw new Error("Review task id is invalid.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

