import { createHash } from "node:crypto";
import { BrowserWindow, session, shell, type Session, type WebContents } from "electron";

import { isValidReviewTaskId } from "./review-activity";

const CHATGPT_URL = "https://chatgpt.com/";
const PARTITION = "persist:chatgpt-pr-review";
const POLL_MS = 400;
const COMPOSER_WAIT_MS = 8_000;
const HIDDEN_TASK_COMPOSER_WAIT_MS = 60_000;
const STORED_CONVERSATION_WAIT_MS = 10_000;
const PROJECT_WAIT_MS = 12_000;
const PROJECT_CREATE_WAIT_MS = 20_000;
const INTERACTIVE_WAIT_MS = 5 * 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const HARD_TIMEOUT_MS = 30 * 60_000;
const MAX_INPUT_BYTES = 120 * 1024;
const MAX_OUTPUT_BYTES = 120 * 1024;
const STABLE_POLLS = 3;
const PROGRESS_HEARTBEAT_MS = 15_000;
const COMPOSER_INSERT_CHUNK_CHARS = 4_096;
const COMPOSER_INSERT_SETTLE_MS = 35;

export interface ChatGptProgress {
  taskId: string;
  text: string;
  generating: boolean;
}

export interface ChatGptProjectBinding {
  projectUrl: string;
  replacedStoredProject: boolean;
}

export interface ChatGptTaskStart {
  conversationUrl: string | null;
  fallbackToNewConversation: boolean;
}

export class ChatGptWebDriver {
  private setupWindow: BrowserWindow | null = null;
  private readonly taskWindows = new Map<string, BrowserWindow>();
  private readonly webSession: Session;
  private projectQueue: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;

  constructor(private readonly onProgress?: (progress: ChatGptProgress) => void) {
    this.webSession = session.fromPartition(PARTITION, { cache: true });
    this.webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.webSession.setPermissionCheckHandler(() => false);
  }

  async ready(): Promise<boolean> {
    const window = await this.ensureSetupWindow();
    const contents = liveWebContents(window);
    if (!isChatGptOrigin(safeWebContentsUrl(contents))) return false;
    return composerReady(contents).catch(() => false);
  }

  async showSetup(): Promise<void> {
    const window = await this.ensureSetupWindow();
    window.show();
    window.focus();
  }

  ensureProject(repository: string, storedProjectUrl?: string): Promise<ChatGptProjectBinding> {
    assertRepositoryName(repository);
    const execution = this.projectQueue.then(() => this.ensureProjectNow(repository, storedProjectUrl));
    this.projectQueue = execution.then(() => undefined, () => undefined);
    return execution;
  }

  async startTask(
    taskId: string,
    projectUrl: string,
    pullRequestConversationUrl?: string,
  ): Promise<ChatGptTaskStart> {
    assertTaskId(taskId);
    const targetProject = normalizeProjectUrl(projectUrl);
    const targetConversation = pullRequestConversationUrl === undefined
      ? null
      : normalizeConversationUrl(pullRequestConversationUrl);
    if (this.taskWindows.has(taskId)) throw new Error(`ChatGPT review task ${taskId} is already active.`);

    const window = await this.createTaskWindow(taskId);
    try {
      const targetUrl = targetConversation ?? targetProject;
      await window.loadURL(targetUrl);
      await this.ensureComposer(window, () => this.assertTask(taskId), { interactiveFallback: false });

      if (targetConversation) {
        const restored = await waitForStoredConversation(window, targetConversation, () => this.assertTask(taskId));
        if (!restored) {
          await window.loadURL(targetProject);
          await this.ensureComposer(window, () => this.assertTask(taskId), { interactiveFallback: false });
          return { conversationUrl: null, fallbackToNewConversation: true };
        }
        return { conversationUrl: targetConversation, fallbackToNewConversation: false };
      }

      return { conversationUrl: null, fallbackToNewConversation: false };
    } catch (error) {
      this.destroyTaskWindow(taskId);
      throw error;
    }
  }

  finishTask(taskId: string): void {
    assertTaskId(taskId);
    this.destroyTaskWindow(taskId);
  }

  async send(
    taskId: string,
    message: string,
    onConversationUrl?: (conversationUrl: string) => Promise<void> | void,
  ): Promise<{ text: string; conversationUrl: string }> {
    assertTaskId(taskId);
    if (Buffer.byteLength(message, "utf8") > MAX_INPUT_BYTES) throw new Error("ChatGPT review prompt exceeds the 120 KiB bound.");
    const window = this.taskWindows.get(taskId);
    if (!window || window.isDestroyed()) throw new Error("ChatGPT review task is not the active web conversation.");
    await this.ensureComposer(window, () => this.assertTask(taskId), { interactiveFallback: false });
    const contents = liveWebContents(window);
    const text = await this.sendAndReceive(contents, taskId, message, onConversationUrl);
    const conversationUrl = safeConversationUrl(safeWebContentsUrl(contents));
    if (!conversationUrl) throw new Error("ChatGPT did not establish a conversation URL for the pull request.");
    return { text, conversationUrl };
  }

  async showConversation(url?: string): Promise<void> {
    const window = await this.ensureSetupWindow();
    if (url && allowedNavigation(url) && url.startsWith("https://chatgpt.com/")) {
      const currentUrl = safeWebContentsUrl(liveWebContents(window));
      if (currentUrl !== url) await window.loadURL(url);
    }
    window.show();
    window.focus();
  }

  async deleteConversation(conversationUrl: string): Promise<void> {
    const target = normalizeConversationUrl(conversationUrl);
    const window = this.createWindow("ChatGPT Review · Conversation Cleanup");
    try {
      await window.loadURL(target);
      const contents = liveWebContents(window);
      const current = safeConversationUrl(safeWebContentsUrl(contents));
      if (current && current !== target) return;
      await deleteConversationFromUi(contents, target);
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const taskId of [...this.taskWindows.keys()]) this.destroyTaskWindow(taskId);
    const window = this.setupWindow;
    this.setupWindow = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  private async ensureProjectNow(repository: string, storedProjectUrl?: string): Promise<ChatGptProjectBinding> {
    const projectName = projectNameForRepository(repository);
    const storedProject = storedProjectUrl ? normalizeProjectUrl(storedProjectUrl) : null;
    const window = await this.ensureSetupWindow();

    if (storedProject) {
      await window.loadURL(storedProject);
      const restored = await waitForStoredProject(window, storedProject, projectName);
      if (restored) {
        return { projectUrl: storedProject, replacedStoredProject: false };
      }
    }

    await window.loadURL(CHATGPT_URL);
    await this.ensureComposer(window, () => undefined);
    await revealProjectsNavigation(window);

    const discoveredProject = await findProjectByName(window, projectName);
    if (discoveredProject) {
      await window.loadURL(discoveredProject);
      const restored = await waitForStoredProject(window, discoveredProject, projectName);
      if (restored) {
        return { projectUrl: discoveredProject, replacedStoredProject: Boolean(storedProject && storedProject !== discoveredProject) };
      }
      await window.loadURL(CHATGPT_URL);
      await this.ensureComposer(window, () => undefined);
      await revealProjectsNavigation(window);
    }

    const projectUrl = await createProject(window, projectName);
    return { projectUrl, replacedStoredProject: Boolean(storedProject && storedProject !== projectUrl) };
  }

  private async ensureSetupWindow(): Promise<BrowserWindow> {
    let window = this.setupWindow;
    if (!window || window.isDestroyed()) {
      window = this.createWindow("ChatGPT Review · Web Session");
      this.configureSetupLifecycle(window);
      this.setupWindow = window;
      await window.loadURL(CHATGPT_URL);
    }
    return window;
  }

  private async createTaskWindow(taskId: string): Promise<BrowserWindow> {
    const window = this.createWindow(`ChatGPT Review · ${taskId}`);
    this.taskWindows.set(taskId, window);
    window.on("close", (event) => {
      if (this.shuttingDown || !this.taskWindows.has(taskId)) return;
      event.preventDefault();
      if (!window.isDestroyed()) window.hide();
    });
    window.on("closed", () => {
      if (this.taskWindows.get(taskId) === window) this.taskWindows.delete(taskId);
    });
    return window;
  }

  private createWindow(title: string): BrowserWindow {
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 640,
      show: false,
      title,
      autoHideMenuBar: true,
      webPreferences: {
        session: this.webSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webgl: false,
        spellcheck: false,
        devTools: false,
      },
    });
    configureNavigation(window);
    return window;
  }

  private configureSetupLifecycle(window: BrowserWindow): void {
    window.on("close", (event) => {
      if (this.shuttingDown) return;
      event.preventDefault();
      if (!window.isDestroyed()) window.hide();
    });
    window.on("closed", () => {
      if (this.setupWindow === window) this.setupWindow = null;
    });
  }

  private destroyTaskWindow(taskId: string): void {
    const window = this.taskWindows.get(taskId);
    if (!window) return;
    this.taskWindows.delete(taskId);
    if (!window.isDestroyed()) window.destroy();
  }

  private async ensureComposer(
    window: BrowserWindow,
    assertActive: () => void,
    options: { interactiveFallback?: boolean } = {},
  ): Promise<void> {
    const allowInteractiveFallback = options.interactiveFallback !== false;
    const hiddenDeadline = Date.now() + (allowInteractiveFallback ? COMPOSER_WAIT_MS : HIDDEN_TASK_COMPOSER_WAIT_MS);
    while (Date.now() < hiddenDeadline) {
      assertActive();
      const contents = liveWebContents(window);
      if (isChatGptOrigin(safeWebContentsUrl(contents)) && await composerReady(contents).catch(() => false)) {
        if (window.isVisible()) window.hide();
        return;
      }
      await delay(POLL_MS);
    }

    if (!allowInteractiveFallback) {
      throw new Error("ChatGPT Web composer did not become ready in the hidden review window. Open ChatGPT setup to sign in or reconnect the required connectors, then retry.");
    }

    window.show();
    window.focus();
    const interactiveDeadline = Date.now() + INTERACTIVE_WAIT_MS;
    while (Date.now() < interactiveDeadline) {
      assertActive();
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
    const beforeUserMessages = await userMessageCount(contents);
    const beforeConversationUrl = safeConversationUrl(safeWebContentsUrl(contents));

    // ChatGPT's Project composer is a controlled rich-text editor. Mutating
    // textContent or calling WebContents.insertText() can make text appear in
    // the DOM without updating the editor state that enables submission. Drive
    // the focused composer through Chromium's editing pipeline and verify that
    // the prompt is actually present before attempting to send it.
    const composerState = await trustedSetComposerText(contents, message);
    if (!composerState.hasText) {
      throw new Error(`ChatGPT composer did not accept the review prompt text (length=${composerState.textLength}).`);
    }

    // ChatGPT currently wraps the Project composer in a real form. Once the
    // controlled editor state is populated, requestSubmit() is the most stable
    // way to invoke the same React submit handler without depending on hidden
    // window pointer coordinates. Keep browser-level mouse and keyboard paths
    // as fallbacks for UI variants that do not expose a form. Every path is
    // verified by observing a new /c/<id> URL or an added user turn.
    const submitAttempts: string[] = [];
    let submission = { submitted: false, conversationUrl: "" };

    const domSubmitted = await submitComposerForm(contents);
    submitAttempts.push(`form=${domSubmitted}`);
    if (domSubmitted) {
      submission = await waitForPromptSubmission(contents, beforeUserMessages, beforeConversationUrl, 5_000);
    }

    if (!submission.submitted) {
      // Keep background review windows hidden. CDP dispatch goes directly to the
      // renderer target, so mapping the BrowserWindow is not required for this
      // fallback and would steal the user's VNC focus during automatic reviews.
      const mouseSubmitted = await trustedClickSend(contents);
      submitAttempts.push(`mouse=${mouseSubmitted}`);
      if (mouseSubmitted) {
        submission = await waitForPromptSubmission(contents, beforeUserMessages, beforeConversationUrl, 8_000);
      }
    }

    if (!submission.submitted) {
      const keyboardSubmitted = await trustedSubmitPrompt(contents);
      submitAttempts.push(`enter=${keyboardSubmitted}`);
      if (keyboardSubmitted) {
        submission = await waitForPromptSubmission(contents, beforeUserMessages, beforeConversationUrl, 8_000);
      }
    }

    if (!submission.submitted) {
      const state = await composerDiagnostics(contents);
      throw new Error(`ChatGPT review prompt was not accepted; no pull-request conversation was created or updated. attempts=${submitAttempts.join(',')}; ${state}`);
    }
    this.onProgress?.({
      taskId,
      text: "ChatGPT prompt accepted for the current review step.",
      generating: true,
    });
    let boundConversationUrl = submission.conversationUrl;
    let conversationAnnounced = false;
    if (boundConversationUrl) {
      await onConversationUrl?.(boundConversationUrl);
      this.onProgress?.({
        taskId,
        text: "ChatGPT conversation established for the current review step.",
        generating: true,
      });
      conversationAnnounced = true;
    }

    const turnStartedAt = Date.now();
    const hardDeadline = turnStartedAt + HARD_TIMEOUT_MS;
    let idleDeadline = turnStartedAt + IDLE_TIMEOUT_MS;
    let lastSignature = signature(before);
    let stableText = "";
    let stablePolls = 0;
    let lastProgress = "";
    let lastHeartbeatAt = turnStartedAt;

    while (Date.now() < hardDeadline && Date.now() < idleDeadline) {
      this.assertTask(taskId);
      const currentConversationUrl = safeConversationUrl(safeWebContentsUrl(contents));
      if (currentConversationUrl && currentConversationUrl !== boundConversationUrl) {
        boundConversationUrl = currentConversationUrl;
        await onConversationUrl?.(currentConversationUrl);
        if (!conversationAnnounced) {
          this.onProgress?.({
            taskId,
            text: "ChatGPT conversation established for the current review step.",
            generating: true,
          });
          conversationAnnounced = true;
        }
      }
      const snapshot = await assistantSnapshot(contents);
      const currentSignature = signature(snapshot);
      if (currentSignature !== lastSignature) {
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
      const now = Date.now();
      if (now - lastHeartbeatAt >= PROGRESS_HEARTBEAT_MS) {
        lastHeartbeatAt = now;
        const elapsedSeconds = Math.max(1, Math.round((now - turnStartedAt) / 1_000));
        const responseBytes = Buffer.byteLength(snapshot.text, "utf8");
        this.onProgress?.({
          taskId,
          text: isNewTurn
            ? `ChatGPT review step still active: ${elapsedSeconds}s elapsed · ${responseBytes} response byte(s) · generating=${snapshot.generating ? "yes" : "no"}.`
            : `ChatGPT review step still active: ${elapsedSeconds}s elapsed · waiting for the first assistant turn · generating=${snapshot.generating ? "yes" : "no"}.`,
          generating: snapshot.generating,
        });
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
    const window = this.taskWindows.get(taskId);
    if (!window || window.isDestroyed()) throw new Error("ChatGPT review task changed while the web turn was running.");
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
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return "";
    const segments = url.pathname.split("/").filter(Boolean);
    const conversationIndex = segments.findIndex((segment) => segment === "c");
    if (conversationIndex < 0 || !segments[conversationIndex + 1]) return "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeConversationUrl(value: string): string {
  const normalized = safeConversationUrl(value);
  if (!normalized) throw new Error("Stored ChatGPT pull-request conversation URL is invalid.");
  return normalized;
}

function safeProjectUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return "";
    const segments = url.pathname.split("/").filter(Boolean);
    const projectIdIndex = segments.findIndex((segment) => /^g-p-[A-Za-z0-9_-]+$/.test(segment));
    if (projectIdIndex >= 0) {
      url.pathname = `/${[...segments.slice(0, projectIdIndex + 1), "project"].join("/")}`;
    } else {
      const projectIndex = segments.findIndex((segment) => segment === "project" || segment === "projects");
      if (projectIndex < 0 || !segments[projectIndex + 1]) return "";
      url.pathname = `/${segments.slice(0, projectIndex + 2).join("/")}`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeProjectUrl(value: string): string {
  const normalized = safeProjectUrl(value);
  if (!normalized) throw new Error("Stored ChatGPT repository project URL is invalid.");
  return normalized;
}

function projectNameForRepository(repository: string): string {
  assertRepositoryName(repository);
  const readable = `PR Review - ${repository.replace('/', ' - ')}`;
  if (readable.length <= 80) return readable;
  const suffix = createHash("sha256").update(repository).digest("hex").slice(0, 8);
  return `${readable.slice(0, 69).trimEnd()} - ${suffix}`;
}

function assertRepositoryName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Repository must use owner/name format.");
}

function isChatGptOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

async function waitForStoredProject(window: BrowserWindow, targetProject: string, projectName: string): Promise<boolean> {
  const deadline = Date.now() + PROJECT_WAIT_MS;
  while (Date.now() < deadline) {
    const contents = liveWebContents(window);
    const currentProject = safeProjectUrl(safeWebContentsUrl(contents));
    if (currentProject && currentProject !== targetProject) return false;
    if (!currentProject) {
      const current = safeWebContentsUrl(contents);
      if (isChatGptOrigin(current) && current !== CHATGPT_URL) return false;
      await delay(POLL_MS);
      continue;
    }
    const state = await executeJavaScriptSafe<{ composer: boolean; missing: boolean; named: boolean }>(contents, `(() => {
      const text = document.body?.innerText || '';
      const normalized = text.toLowerCase();
      const composer = Boolean(document.querySelector('#prompt-textarea, textarea[data-testid="prompt-textarea"], textarea'));
      const missing = /project (?:was )?not found|could not find (?:this )?project|unable to load (?:this )?project|không tìm thấy dự án|không thể tải dự án/i.test(text);
      const named = normalized.includes(${JSON.stringify(projectName.toLowerCase())});
      return { composer, missing, named };
    })()`);
    if (state.missing) return false;
    if (state.composer && state.named) return true;
    await delay(POLL_MS);
  }
  return false;
}

type WebPoint = { x: number; y: number };

async function clickWebPoint(window: BrowserWindow, point: WebPoint): Promise<void> {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error("ChatGPT Web returned an invalid control position while setting up the repository Project.");
  }
  const contents = liveWebContents(window);
  contents.sendInputEvent({ type: "mouseMove", x, y });
  contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  await delay(300);
}

async function syncProjectNameReactState(contents: WebContents, projectName: string): Promise<boolean> {
  return executeJavaScriptSafe<boolean>(contents, `(() => {
    const input = document.querySelector('#project-name, input[name="projectName"]');
    if (!(input instanceof HTMLInputElement)) return false;
    const desired = ${JSON.stringify(projectName)};
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;

    // React tracks controlled-input values separately from the DOM. A browser
    // insertion can leave input.value correct while React still thinks the
    // field is empty, which keeps Create project disabled. Re-arm React's value
    // tracker, then emit the same bubbling input/change signals as a real edit.
    const tracker = input._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') tracker.setValue('');
    setter.call(input, desired);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: desired }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value === desired;
  })()`, "synchronizing the ChatGPT Project name with React");
}

async function trustedInsertText(contents: WebContents, text: string): Promise<void> {
  const debuggerApi = contents.debugger;
  const alreadyAttached = debuggerApi.isAttached();
  try {
    if (!alreadyAttached) debuggerApi.attach("1.3");

    // Drive the controlled input through Chromium keyboard events instead of
    // assigning DOM value or relying on Input.insertText alone. ChatGPT's
    // create-project form derives its enabled state from React input state; on
    // Linux/Xvfb we observed input.value update while that React state stayed
    // empty. A real select-all/delete followed by char events crosses the same
    // browser event path as physical typing.
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8,
    });

    for (const character of text) {
      await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
        type: "char", text: character, unmodifiedText: character,
      });
    }
  } catch {
    contents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
    contents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
    contents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
    contents.insertText(text);
  } finally {
    if (!alreadyAttached && debuggerApi.isAttached()) debuggerApi.detach();
  }
  await delay(250);
}

async function revealProjectsNavigation(window: BrowserWindow): Promise<void> {
  const contents = liveWebContents(window);
  const result = await executeJavaScriptSafe<{ hasProjects: boolean; toggle: WebPoint | null }>(contents, `(() => {
    const visible = (node) => node instanceof HTMLElement && node.getClientRects().length > 0;
    const text = (node) => node instanceof HTMLElement
      ? [node.innerText, node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('data-testid')].filter(Boolean).join(' ').trim()
      : '';
    const center = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const projectPattern = /(?:^|\\b)(projects?|dự\\s+án)(?:\\b|$)/i;
    const all = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], nav *, aside *'));
    if (all.some((node) => visible(node) && projectPattern.test(text(node)))) return { hasProjects: true, toggle: null };

    const toggles = Array.from(document.querySelectorAll('button[aria-label], button[title], [role="button"][aria-label], [role="button"][title]'));
    const toggle = toggles.find((node) => {
      if (!visible(node)) return false;
      const label = text(node);
      return /open sidebar|show sidebar|expand sidebar|open navigation|show navigation|mở thanh bên|hiện thanh bên|mở menu điều hướng/i.test(label);
    });
    return { hasProjects: false, toggle: center(toggle) };
  })()`, "revealing the ChatGPT Projects navigation");
  if (result.toggle) {
    await clickWebPoint(window, result.toggle);
    await delay(400);
  }
}

async function findProjectByName(window: BrowserWindow, projectName: string): Promise<string> {
  const contents = liveWebContents(window);
  const href = await executeJavaScriptSafe<string>(contents, `(() => {
    const desired = ${JSON.stringify(projectName)}.trim().toLowerCase();
    const links = Array.from(document.querySelectorAll('a[href]'));
    const match = links.find((node) => {
      if (!(node instanceof HTMLAnchorElement) || node.getClientRects().length === 0) return false;
      const label = [node.innerText, node.getAttribute('aria-label'), node.getAttribute('title')].filter(Boolean).join(' ').trim().toLowerCase();
      if (label !== desired && !label.includes(desired)) return false;
      return /\\/g\\/g-p-[A-Za-z0-9_-]+(?:\\/project)?(?:[/?#]|$)|\\/projects?\\//.test(node.href);
    });
    return match instanceof HTMLAnchorElement ? match.href : '';
  })()`, "finding the repository ChatGPT Project");
  return href ? safeProjectUrl(href) : "";
}

async function openCreateProjectUi(window: BrowserWindow): Promise<boolean> {
  await revealProjectsNavigation(window);
  const contents = liveWebContents(window);
  const point = await executeJavaScriptSafe<WebPoint | null>(contents, `(() => {
    const visible = (node) => node instanceof HTMLElement && node.getClientRects().length > 0;
    const center = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };

    // Current ChatGPT DOM: the Projects sidebar item owns a trailing
    // <button aria-label="New project">. Prefer this stable control before
    // falling back to text/heading heuristics.
    const exact = document.querySelector('[data-testid="sidebar-item-projects"] button[aria-label="New project"], button[aria-label="New project"]');
    if (visible(exact)) return center(exact);

    const label = (node) => node instanceof HTMLElement
      ? [node.innerText, node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('data-testid')].filter(Boolean).join(' ').trim()
      : '';
    const createPattern = /(?:new|create)(?:\\s+(?:a|new))?\\s+project|add\\s+project|project\\s+(?:new|create)|tạo\\s+dự\\s+án|dự\\s+án\\s+mới/i;
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const direct = nodes.find((node) => visible(node) && createPattern.test(label(node)));
    const directPoint = center(direct);
    if (directPoint) return directPoint;

    const projectHeadings = Array.from(document.querySelectorAll('nav *, aside *, [data-testid*="sidebar"] *')).filter((node) => {
      if (!visible(node)) return false;
      const value = node instanceof HTMLElement ? (node.innerText || '').trim() : '';
      return /^(projects?|dự\\s+án)$/i.test(value);
    });
    for (const heading of projectHeadings) {
      let container = heading.parentElement;
      for (let depth = 0; container && depth < 3; depth += 1, container = container.parentElement) {
        const nearby = Array.from(container.querySelectorAll(':scope > button, :scope > [role="button"], button, [role="button"]')).filter(visible);
        const candidate = nearby.find((node) => node !== heading && (createPattern.test(label(node)) || /add|plus|new|create|\\+|thêm/i.test(label(node))))
          ?? (nearby.length === 1 ? nearby[0] : undefined);
        const candidatePoint = center(candidate);
        if (candidatePoint) return candidatePoint;
      }
    }
    return null;
  })()`, "locating the ChatGPT Project creation control");
  if (!point) return false;
  await clickWebPoint(window, point);
  return true;
}

async function createProject(window: BrowserWindow, projectName: string): Promise<string> {
  // Project creation is rare (normally once per repository). Keep the setup
  // window mapped and focused while typing so Chromium delivers genuine editing
  // events to the controlled React input even under Xvfb. The window is hidden
  // again as soon as the Project route is established.
  if (!window.isVisible()) window.show();
  window.focus();
  const opened = await openCreateProjectUi(window);
  if (!opened) {
    window.show();
    window.focus();
    throw new Error("ChatGPT Projects control was not found after expanding the sidebar. The review window was opened for inspection; confirm Projects is visible, then retry.");
  }

  const deadline = Date.now() + PROJECT_CREATE_WAIT_MS;
  let submitted = false;
  let nameInserted = false;
  let reactNameSyncAttempted = false;

  while (Date.now() < deadline) {
    const currentProject = safeProjectUrl(safeWebContentsUrl(liveWebContents(window)));
    if (currentProject) {
      if (window.isVisible()) window.hide();
      return currentProject;
    }

    const step = await executeJavaScriptSafe<{
      action: string;
      point?: WebPoint;
      currentName?: string;
      createDisabled?: boolean;
    }>(liveWebContents(window), `(() => {
      const visible = (node) => node instanceof HTMLElement && node.getClientRects().length > 0;
      const center = (node) => {
        if (!(node instanceof HTMLElement)) return undefined;
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) return undefined;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      };

      const input = document.querySelector('#project-name, input[name="projectName"]');
      const dialog = input instanceof HTMLElement
        ? (input.closest('[role="dialog"]') || input.closest('form') || input.parentElement?.parentElement?.parentElement)
        : Array.from(document.querySelectorAll('[role="dialog"]')).find((node) => visible(node));
      if (!(input instanceof HTMLInputElement) || !(dialog instanceof HTMLElement)) {
        return { action: 'waiting-dialog' };
      }

      const desired = ${JSON.stringify(projectName)};
      if (input.value !== desired) {
        return { action: 'fill-name', point: center(input), currentName: input.value };
      }

      if (${submitted ? "true" : "false"}) return { action: 'waiting-project' };

      const submit = Array.from(dialog.querySelectorAll('button[type="submit"], button')).find((node) => {
        if (!(node instanceof HTMLButtonElement) || !visible(node)) return false;
        const label = (node.innerText || node.getAttribute('aria-label') || '').trim();
        return /^(create project|create|tạo dự án|tạo)$/i.test(label);
      });
      if (submit instanceof HTMLButtonElement) {
        if (!submit.disabled && !submit.hasAttribute('data-visually-disabled')) {
          return { action: 'submit', point: center(submit), createDisabled: false };
        }
        return { action: 'waiting-create-enabled', createDisabled: true };
      }

      const advance = Array.from(dialog.querySelectorAll('button')).find((node) => {
        if (!(node instanceof HTMLButtonElement) || node.disabled || !visible(node)) return false;
        const label = (node.innerText || node.getAttribute('aria-label') || '').trim();
        return /^(next|continue|tiếp tục)$/i.test(label);
      });
      const advancePoint = center(advance);
      return advancePoint ? { action: 'advance', point: advancePoint } : { action: 'waiting-create' };
    })()`, "configuring the repository ChatGPT Project");

    if (step.point && step.action === "fill-name") {
      await clickWebPoint(window, step.point);
      const contents = liveWebContents(window);
      const prepared = await executeJavaScriptSafe<boolean>(contents, `(() => {
        const input = document.querySelector('#project-name, input[name="projectName"]');
        if (!(input instanceof HTMLInputElement)) return false;
        input.focus();
        input.select();
        return document.activeElement === input;
      })()`, "focusing the ChatGPT Project name input");
      if (!prepared) throw new Error("ChatGPT Project name input could not be focused.");

      // input.select() above already selects any existing value. Insert via
      // Chromium CDP so React sees the same trusted editing event as real text
      // entry, even when the setup window is hidden under Xvfb.
      await trustedInsertText(contents, projectName);
      nameInserted = true;
      await delay(350);

      const accepted = await executeJavaScriptSafe<boolean>(contents, `(() => {
        const input = document.querySelector('#project-name, input[name="projectName"]');
        return input instanceof HTMLInputElement && input.value === ${JSON.stringify(projectName)};
      })()`, "verifying the ChatGPT Project name input");
      if (!accepted) {
        const repaired = await syncProjectNameReactState(contents, projectName);
        reactNameSyncAttempted = true;
        if (!repaired) throw new Error("ChatGPT Project name input did not accept the repository Project name.");
      }
    } else if (step.point && step.action === "advance") {
      await clickWebPoint(window, step.point);
    } else if (step.point && step.action === "submit") {
      await clickWebPoint(window, step.point);
      submitted = true;
    } else if (step.action === "waiting-create-enabled" && nameInserted) {
      if (!reactNameSyncAttempted) {
        const contents = liveWebContents(window);
        const repaired = await syncProjectNameReactState(contents, projectName);
        reactNameSyncAttempted = true;
        if (!repaired) throw new Error("ChatGPT Project name input could not be synchronized with the Create project form.");
        // Blur/focus once after the controlled-input repair so any form-level
        // validation tied to focus transitions gets a render cycle too.
        await executeJavaScriptSafe<boolean>(contents, `(() => {
          const input = document.querySelector('#project-name, input[name="projectName"]');
          if (!(input instanceof HTMLInputElement)) return false;
          input.blur();
          input.focus();
          return true;
        })()`, "refreshing the ChatGPT Project create form");
        await delay(400);
      } else {
        await delay(250);
      }
    }

    await delay(POLL_MS);
  }

  const createDiagnostics = nameInserted
    ? await executeJavaScriptSafe<string>(liveWebContents(window), `(() => {
        const input = document.querySelector('#project-name, input[name="projectName"]');
        const submit = Array.from(document.querySelectorAll('button[type="submit"], button')).find((node) => {
          if (!(node instanceof HTMLButtonElement)) return false;
          return /^(create project|create|tạo dự án|tạo)$/i.test((node.innerText || node.getAttribute('aria-label') || '').trim());
        });
        const value = input instanceof HTMLInputElement ? input.value : 'missing';
        const valid = input instanceof HTMLInputElement ? String(input.validity.valid) : 'missing';
        const message = input instanceof HTMLInputElement ? input.validationMessage : '';
        const ariaInvalid = input instanceof HTMLInputElement ? (input.getAttribute('aria-invalid') || 'unset') : 'missing';
        const maxLength = input instanceof HTMLInputElement ? String(input.maxLength) : 'missing';
        const disabled = submit instanceof HTMLButtonElement ? String(submit.disabled || submit.hasAttribute('data-visually-disabled')) : 'missing';
        return 'value=' + value + '; valid=' + valid + '; validation=' + (message || 'none') + '; ariaInvalid=' + ariaInvalid + '; maxLength=' + maxLength + '; disabled=' + disabled;
      })()`, "diagnosing the ChatGPT Project create form")
    : '';

  throw new Error(submitted
    ? "ChatGPT Project creation did not finish before the timeout."
    : !nameInserted
      ? "ChatGPT Project creation could not populate the Project name input."
      : `ChatGPT Project name was entered, but the Create project button remained disabled. ${createDiagnostics}`);
}

async function waitForStoredConversation(
  window: BrowserWindow,
  targetConversation: string,
  assertTask: () => void,
): Promise<boolean> {
  const deadline = Date.now() + STORED_CONVERSATION_WAIT_MS;
  while (Date.now() < deadline) {
    assertTask();
    const contents = liveWebContents(window);
    const currentConversation = safeConversationUrl(safeWebContentsUrl(contents));
    if (currentConversation !== targetConversation) return false;
    const hasConversationTurn = await executeJavaScriptSafe<boolean>(contents, `(() => Boolean(
      document.querySelector('[data-message-author-role="user"], [data-message-author-role="assistant"]')
    ))()`);
    if (hasConversationTurn) return true;
    await delay(POLL_MS);
  }
  return false;
}

async function composerReady(contents: WebContents): Promise<boolean> {
  return executeJavaScriptSafe<boolean>(contents, `(() => {
    const el = document.querySelector('#prompt-textarea') || document.querySelector('textarea[data-testid="prompt-textarea"]') || document.querySelector('textarea');
    return el instanceof HTMLElement && !el.hasAttribute('disabled');
  })()`);
}

type ComposerInteractionState = {
  hasText: boolean;
  textLength: number;
  innerText: string;
  textContent: string;
  sendEnabled: boolean;
  active: boolean;
};

async function composerInteractionState(contents: WebContents): Promise<ComposerInteractionState> {
  return executeJavaScriptSafe<ComposerInteractionState>(contents, `(() => {
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('textarea[data-testid="prompt-textarea"]')
      || document.querySelector('[contenteditable="true"][data-testid*="prompt"]')
      || document.querySelector('textarea');
    if (!(composer instanceof HTMLElement)) {
      return { hasText: false, textLength: 0, innerText: '', textContent: '', sendEnabled: false, active: false };
    }
    const textareaValue = composer instanceof HTMLTextAreaElement ? composer.value : '';
    const innerText = composer instanceof HTMLTextAreaElement ? textareaValue : (composer.innerText || '');
    const textContent = composer instanceof HTMLTextAreaElement ? textareaValue : (composer.textContent || '');
    const value = innerText || textContent;
    const scope = composer.closest('form') || document;
    const buttons = Array.from(scope.querySelectorAll('button'));
    const send = buttons.find((node) => {
      if (!(node instanceof HTMLButtonElement)) return false;
      const testId = node.getAttribute('data-testid') || '';
      const label = (node.getAttribute('aria-label') || node.innerText || '').trim();
      return testId === 'send-button'
        || testId === 'composer-submit-button'
        || /^send(?: prompt| message)?$/i.test(label)
        || (node.type === 'submit' && !/voice|microphone|dictat/i.test(label));
    });
    return {
      hasText: value.trim().length > 0,
      textLength: value.length,
      innerText,
      textContent,
      sendEnabled: send instanceof HTMLButtonElement
        && !send.disabled
        && !send.hasAttribute('data-disabled')
        && !send.hasAttribute('data-visually-disabled'),
      active: document.activeElement === composer || composer.contains(document.activeElement),
    };
  })()`, "reading the ChatGPT composer state");
}

async function trustedSetComposerText(contents: WebContents, message: string): Promise<ComposerInteractionState> {
  const focused = await executeJavaScriptSafe<boolean>(contents, `(() => {
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('textarea[data-testid="prompt-textarea"]')
      || document.querySelector('[contenteditable="true"][data-testid*="prompt"]')
      || document.querySelector('textarea');
    if (!(composer instanceof HTMLElement)) return false;
    composer.focus();
    return document.activeElement === composer || composer.contains(document.activeElement);
  })()`, "focusing the ChatGPT review composer");
  if (!focused) throw new Error("ChatGPT composer is unavailable.");

  const debuggerApi = contents.debugger;
  const alreadyAttached = debuggerApi.isAttached();
  let usedCdp = false;
  try {
    if (!alreadyAttached) debuggerApi.attach("1.3");
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8,
    });
    // Large one-shot Input.insertText payloads can become visible in ChatGPT's
    // contenteditable DOM without fully committing the ProseMirror/React editor
    // state. The send button then looks enabled, but clicking it produces no
    // user turn. Feed bounded chunks through Chromium's editing pipeline and
    // briefly yield between chunks so the controlled editor can commit state.
    const chunks = splitComposerInput(message, COMPOSER_INSERT_CHUNK_CHARS);
    for (const chunk of chunks) {
      await debuggerApi.sendCommand("Input.insertText", { text: chunk });
      if (chunks.length > 1) await delay(COMPOSER_INSERT_SETTLE_MS);
    }
    usedCdp = true;
  } catch {
    contents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
    contents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
    contents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
    contents.insertText(message);
  } finally {
    if (!alreadyAttached && debuggerApi.isAttached()) debuggerApi.detach();
  }

  await delay(300);
  let state = await composerInteractionState(contents);
  if (!state.hasText && usedCdp) {
    // Last-resort Electron text insertion for renderer variants where CDP text
    // insertion is ignored despite a focused editor. Submission is still
    // verified separately, so this fallback cannot silently create an empty turn.
    contents.insertText(message);
    await delay(300);
    state = await composerInteractionState(contents);
  }
  return state;
}

export function splitComposerInput(message: string, maxChunkChars = COMPOSER_INSERT_CHUNK_CHARS): string[] {
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 256) {
    throw new Error("Composer insert chunk size is invalid.");
  }
  if (!message) return [""];
  const chunks: string[] = [];
  let start = 0;
  while (start < message.length) {
    let end = Math.min(message.length, start + maxChunkChars);
    if (end < message.length) {
      const code = message.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    if (end <= start) end = Math.min(message.length, start + maxChunkChars);
    chunks.push(message.slice(start, end));
    start = end;
  }
  return chunks;
}

async function submitComposerForm(contents: WebContents): Promise<boolean> {
  return executeJavaScriptSafe<boolean>(contents, `(() => {
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('textarea[data-testid="prompt-textarea"]')
      || document.querySelector('[contenteditable="true"][data-testid*="prompt"]')
      || document.querySelector('textarea');
    if (!(composer instanceof HTMLElement)) return false;

    const visible = (node) => node instanceof HTMLElement && node.getClientRects().length > 0;
    const isEnabledSend = (node) => {
      if (!(node instanceof HTMLButtonElement)) return false;
      if (node.disabled || node.hasAttribute('data-disabled') || node.hasAttribute('data-visually-disabled')) return false;
      const testId = node.getAttribute('data-testid') || '';
      const label = (node.getAttribute('aria-label') || node.innerText || '').trim();
      return testId === 'send-button'
        || testId === 'composer-submit-button'
        || /^send(?: prompt| message)?$/i.test(label)
        || (node.type === 'submit' && !/voice|microphone|dictat/i.test(label));
    };
    const form = composer.closest('form');
    const scopedButtons = Array.from((form || document).querySelectorAll('button'));
    const globalButtons = Array.from(document.querySelectorAll('button'));
    const send = scopedButtons.find((node) => isEnabledSend(node) && visible(node))
      || globalButtons.find((node) => isEnabledSend(node) && visible(node))
      || scopedButtons.find(isEnabledSend)
      || globalButtons.find(isEnabledSend);
    if (!(send instanceof HTMLButtonElement)) return false;

    composer.focus();
    send.focus({ preventScroll: true });

    const pointerInit = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: 0, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const mouseInit = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: 0, clientY: 0 };
    try {
      send.dispatchEvent(new PointerEvent('pointerover', pointerInit));
      send.dispatchEvent(new PointerEvent('pointerenter', pointerInit));
      send.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
      send.dispatchEvent(new MouseEvent('mouseover', mouseInit));
      send.dispatchEvent(new MouseEvent('mouseenter', mouseInit));
      send.dispatchEvent(new MouseEvent('mousedown', mouseInit));
      send.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 }));
      send.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
      send.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0, detail: 1 }));
    } catch {
      // Some older Chromium builds may not construct PointerEvent with every
      // init field. A direct click still invokes ordinary DOM/React handlers.
    }

    send.click();

    // In Project composer variants where React listens on form submit instead
    // of the button click, requestSubmit supplies the send button as submitter.
    if (form instanceof HTMLFormElement && typeof form.requestSubmit === 'function') {
      try { form.requestSubmit(send); } catch {}
    }
    return true;
  })()`, "submitting the ChatGPT review composer form");
}

async function trustedClickSend(contents: WebContents): Promise<boolean> {
  const point = await executeJavaScriptSafe<WebPoint | null>(contents, `(() => {
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('textarea[data-testid="prompt-textarea"]')
      || document.querySelector('[contenteditable="true"][data-testid*="prompt"]')
      || document.querySelector('textarea');
    if (!(composer instanceof HTMLElement)) return null;
    const scope = composer.closest('form') || document;
    const buttons = Array.from(scope.querySelectorAll('button'));
    const send = buttons.find((node) => {
      if (!(node instanceof HTMLButtonElement) || node.disabled || node.hasAttribute('data-visually-disabled')) return false;
      const testId = node.getAttribute('data-testid') || '';
      const label = (node.getAttribute('aria-label') || node.innerText || '').trim();
      return testId === 'send-button'
        || testId === 'composer-submit-button'
        || /^send(?: prompt| message)?$/i.test(label)
        || (node.type === 'submit' && !/voice|microphone|dictat/i.test(label));
    });
    if (!(send instanceof HTMLButtonElement)) return null;
    const rect = send.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`, "locating the ChatGPT send control");
  if (!point) return false;

  const debuggerApi = contents.debugger;
  const alreadyAttached = debuggerApi.isAttached();
  try {
    if (!alreadyAttached) debuggerApi.attach("1.3");
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  } catch {
    contents.sendInputEvent({ type: "mouseMove", x: Math.round(point.x), y: Math.round(point.y) });
    contents.sendInputEvent({ type: "mouseDown", x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 });
  } finally {
    if (!alreadyAttached && debuggerApi.isAttached()) debuggerApi.detach();
  }
  await delay(150);
  return true;
}

async function composerDiagnostics(contents: WebContents): Promise<string> {
  const state = await composerInteractionState(contents);
  const url = safeConversationUrl(safeWebContentsUrl(contents));
  const users = await userMessageCount(contents);
  const details = await executeJavaScriptSafe<string>(contents, `(() => {
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('textarea[data-testid="prompt-textarea"]')
      || document.querySelector('[contenteditable="true"][data-testid*="prompt"]')
      || document.querySelector('textarea');
    if (!(composer instanceof HTMLElement)) return 'composer=missing';
    const form = composer.closest('form');
    const scope = form || document;
    const send = Array.from(scope.querySelectorAll('button')).find((node) => {
      if (!(node instanceof HTMLButtonElement)) return false;
      const testId = node.getAttribute('data-testid') || '';
      const label = (node.getAttribute('aria-label') || node.innerText || '').trim();
      return testId === 'send-button'
        || testId === 'composer-submit-button'
        || /^send(?: prompt| message)?$/i.test(label)
        || (node.type === 'submit' && !/voice|microphone|dictat/i.test(label));
    });
    const tag = composer.tagName.toLowerCase();
    const editable = composer.getAttribute('contenteditable') || 'unset';
    const testId = send instanceof HTMLButtonElement ? (send.getAttribute('data-testid') || 'none') : 'missing';
    const label = send instanceof HTMLButtonElement ? ((send.getAttribute('aria-label') || send.innerText || '').trim() || 'none') : 'missing';
    const type = send instanceof HTMLButtonElement ? send.type : 'missing';
    return 'composer=' + tag + '; contenteditable=' + editable + '; form=' + String(form instanceof HTMLFormElement)
      + '; sendTestId=' + testId + '; sendLabel=' + label + '; sendType=' + type;
  })()`, "diagnosing the ChatGPT composer controls");
  return `composerLength=${state.textLength}; sendEnabled=${state.sendEnabled}; active=${state.active}; userMessages=${users}; conversation=${url || 'none'}; ${details}`;
}

async function trustedSubmitPrompt(contents: WebContents): Promise<boolean> {
  const debuggerApi = contents.debugger;
  const alreadyAttached = debuggerApi.isAttached();
  try {
    if (!alreadyAttached) debuggerApi.attach("1.3");
    // keyDown with a carriage-return text payload triggers Chromium's normal
    // Enter default action for contenteditable composers. rawKeyDown alone can
    // deliver the key event without running the editor's default submission
    // behavior on Linux/Xvfb.
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13,
    });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
    });
  } catch {
    contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  } finally {
    if (!alreadyAttached && debuggerApi.isAttached()) debuggerApi.detach();
  }
  await delay(150);
  return true;
}

async function deleteConversationFromUi(contents: WebContents, targetUrl: string): Promise<void> {
  const targetPath = new URL(targetUrl).pathname;
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    const current = safeConversationUrl(safeWebContentsUrl(contents));
    if (!current || current !== targetUrl) return;
    const ready = await executeJavaScriptSafe<boolean>(contents, `(() => Boolean(document.body && document.querySelector('main, [role="main"], nav, aside')))()`, "waiting for the ChatGPT conversation cleanup page");
    if (ready) break;
    await delay(POLL_MS);
  }

  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
    opened = await executeJavaScriptSafe<boolean>(contents, `(() => {
      const targetPath = ${JSON.stringify(targetPath)};
      const normalizePath = (href) => {
        try {
          const pathname = new URL(href, location.origin).pathname;
          return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
        } catch { return ''; }
      };
      const visible = (node) => node instanceof HTMLElement && node.getClientRects().length > 0;
      const labels = (node) => [
        node.getAttribute('aria-label') || '',
        node.getAttribute('title') || '',
        node.getAttribute('data-testid') || '',
        node.textContent || '',
      ].join(' ').toLowerCase();

      const anchor = Array.from(document.querySelectorAll('a[href]'))
        .find((node) => normalizePath(node.getAttribute('href') || '') === targetPath);
      const scopes = [];
      if (anchor instanceof HTMLElement) {
        let scope = anchor;
        for (let depth = 0; depth < 5 && scope; depth += 1) {
          scopes.push(scope);
          scope = scope.parentElement;
        }
      }
      for (const scope of scopes) {
        const button = Array.from(scope.querySelectorAll('button')).find((node) => {
          const text = labels(node);
          return visible(node) && /(more|option|menu|action|conversation)/i.test(text)
            && !/(share|send|voice|microphone|stop)/i.test(text);
        });
        if (button instanceof HTMLButtonElement) {
          button.click();
          return true;
        }
      }

      const global = Array.from(document.querySelectorAll('button')).find((node) => {
        if (!visible(node)) return false;
        const text = labels(node);
        return /(conversation).*(more|option|menu|action)|(more|option|menu|action).*(conversation)/i.test(text)
          || /^(more|options)$/i.test((node.getAttribute('aria-label') || node.getAttribute('title') || '').trim());
      });
      if (global instanceof HTMLButtonElement) {
        global.click();
        return true;
      }
      return false;
    })()`, "opening the ChatGPT conversation actions menu");
    if (!opened) await delay(500);
  }
  if (!opened) {
    const current = safeConversationUrl(safeWebContentsUrl(contents));
    if (!current || current !== targetUrl) return;
    throw new Error("ChatGPT conversation delete menu was not found.");
  }

  await delay(250);
  const deleteClicked = await executeJavaScriptSafe<boolean>(contents, `(() => {
    const visible = (node) => node instanceof HTMLElement && node.getClientRects().length > 0;
    const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, [data-testid]'));
    const item = candidates.find((node) => {
      if (!(node instanceof HTMLElement) || !visible(node)) return false;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      const text = (node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
      return testId.includes('delete')
        || /^(delete|delete chat|delete conversation|xóa|xóa cuộc trò chuyện)$/.test(text);
    });
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`, "selecting Delete for the ChatGPT conversation");
  if (!deleteClicked) throw new Error("ChatGPT conversation Delete action was not found.");

  await delay(250);
  const confirmed = await executeJavaScriptSafe<boolean>(contents, `(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [data-testid*="modal"], [data-testid*="dialog"]'));
    const dialog = dialogs.find((node) => node instanceof HTMLElement && node.getClientRects().length > 0);
    if (!(dialog instanceof HTMLElement)) return false;
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const confirm = buttons.find((node) => {
      if (!(node instanceof HTMLButtonElement) || node.disabled) return false;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      const text = (node.textContent || node.getAttribute('aria-label') || '').trim().toLowerCase();
      return testId.includes('delete') || /^(delete|delete chat|delete conversation|xóa|xóa cuộc trò chuyện)$/.test(text);
    });
    if (!(confirm instanceof HTMLButtonElement)) return false;
    confirm.click();
    return true;
  })()`, "confirming ChatGPT conversation deletion");
  if (!confirmed) throw new Error("ChatGPT conversation deletion confirmation was not found.");

  const deletedDeadline = Date.now() + 15_000;
  while (Date.now() < deletedDeadline) {
    await delay(250);
    const current = safeConversationUrl(safeWebContentsUrl(contents));
    if (!current || current !== targetUrl) return;
  }
  throw new Error("ChatGPT conversation deletion was not confirmed by navigation away from the deleted chat.");
}

async function userMessageCount(contents: WebContents): Promise<number> {
  return executeJavaScriptSafe<number>(contents, `(() => document.querySelectorAll('[data-message-author-role="user"]').length)()`);
}

async function waitForPromptSubmission(
  contents: WebContents,
  beforeUserMessages: number,
  beforeConversationUrl: string,
  timeoutMs: number,
): Promise<{ submitted: boolean; conversationUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const conversationUrl = safeConversationUrl(safeWebContentsUrl(contents));
    const userMessages = await userMessageCount(contents);
    const conversationCreated = !beforeConversationUrl && Boolean(conversationUrl);
    const conversationStayedCanonical = Boolean(beforeConversationUrl) && conversationUrl === beforeConversationUrl;
    if (conversationCreated || (conversationStayedCanonical && userMessages > beforeUserMessages)) {
      return { submitted: true, conversationUrl };
    }
    await delay(100);
  }
  return { submitted: false, conversationUrl: safeConversationUrl(safeWebContentsUrl(contents)) };
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
    const stop = document.querySelector(
      'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop response"], button[aria-label="Stop"]'
    );
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

async function executeJavaScriptSafe<T>(contents: WebContents, source: string, action = "running ChatGPT Web automation"): Promise<T> {
  assertLiveWebContents(contents);
  try {
    return await contents.executeJavaScript(source, true) as T;
  } catch (error) {
    if (contents.isDestroyed() || isDestroyedObjectError(error)) {
      throw new Error("ChatGPT Web review session became unavailable while the review was running. Retry the review.");
    }
    if (error instanceof Error && /script failed to execute/i.test(error.message)) {
      throw new Error(`ChatGPT Web automation failed while ${action}: the page changed before the browser script completed. Retry the review.`);
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
  if (!isValidReviewTaskId(value)) throw new Error("Review task id is invalid.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

