import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mainRoot = path.join(process.cwd(), "src", "main");
const rendererRoot = path.join(process.cwd(), "src", "renderer");

async function source(root: string, name: string): Promise<string> {
  return readFile(path.join(root, name), "utf8");
}

describe("ChatGPT Web review-session lifecycle", () => {
  it("keeps the execution window alive and guards destroyed WebContents", async () => {
    const driver = await source(mainRoot, "chatgpt-web-driver.ts");

    expect(driver).toContain('window.on("close"');
    expect(driver).toContain("event.preventDefault()");
    expect(driver).toContain("window.hide()");
    expect(driver).toContain("private readonly taskWindows = new Map<string, BrowserWindow>()");
    expect(driver).toContain("webgl: false");
    expect(driver).toContain('import { isValidReviewTaskId } from "./review-activity"');
    expect(driver).toContain("if (!isValidReviewTaskId(value))");
    expect(driver).toContain("destroyTaskWindow(taskId)");
    expect(driver).toContain("async deleteConversation(conversationUrl: string)");
    expect(driver).toContain("deleteConversationFromUi(contents, target)");
    expect(driver).toContain("executeJavaScriptSafe");
    expect(driver).toContain("contents.isDestroyed()");
    expect(driver).not.toContain(".catch(() => emptySnapshot())");
    expect(driver).not.toContain("clickSend(contents).catch(() => false)");
  });

  it("releases the ChatGPT lane and prevents Open Chat navigation during an active review", async () => {
    const engine = await source(mainRoot, "review-engine.ts");
    const renderer = await source(rendererRoot, "app.js");

    expect(engine).toContain("this.dependencies.chatgpt.finishTask(record.taskId)");
    expect(engine).toContain("await this.cleanupReviewConversations(record, reviewConversationUrls)");
    expect(engine).toContain("this.dependencies.chatgpt.deleteConversation(conversationUrl)");
    expect(engine).toContain("removePullRequestChatConversation");
    expect(engine).toContain("repository Project retained");
    expect(renderer).toContain("function isTerminalReview(review)");
    expect(renderer).toContain('review?.status === "cancelled"');
    expect(renderer).toContain("Cancel review");
    expect(renderer).toContain("api.cancelReview(reviewId)");
    expect(renderer).toContain("if (review.conversationUrl && terminal)");
  });

  it("keeps persisted review failures in the review card instead of duplicating them as a global toast", async () => {
    const renderer = await source(rendererRoot, "app.js");

    expect(renderer).toContain('const persistedFailure = latest && (latest.status === "failed" || latest.status === "blocked")');
    expect(renderer).toContain("if (!persistedFailure) showNotice(message(error), true, false)");
  });

  it("coalesces cumulative ChatGPT streaming snapshots instead of logging protocol payloads repeatedly", async () => {
    const driver = await source(mainRoot, "chatgpt-web-driver.ts");
    const renderer = await source(rendererRoot, "app.js");

    expect(driver).toContain('cleaned.includes("[JIRA_CONTEXT]")');
    expect(driver).toContain('cleaned.includes("[CHUNK_REVIEW]")');
    expect(driver).toContain('cleaned.includes("[PR_REVIEW]")');
    expect(driver).toContain("if (progress !== lastProgress)");
    expect(driver).toContain("ChatGPT prompt accepted for the current review step.");
    expect(driver).toContain("ChatGPT conversation established for the current review step.");
    expect(driver).toContain("ChatGPT review step still active:");
    expect(driver).toContain("if (currentSignature !== lastSignature)");
    expect(driver).not.toContain("snapshot.generating || currentSignature !== lastSignature");
    expect(renderer).toContain('if (type === "progress" && last?.type === "progress") entries[entries.length - 1] = nextEntry');
    expect(renderer).toContain("compactReviewProgress(rawText)");
  });
  it("retries malformed Jira structured output in the same review conversation instead of failing immediately", async () => {
    const engine = await source(mainRoot, "review-engine.ts");
    const protocol = await source(mainRoot, "review-protocol.ts");

    expect(engine).toContain("const JIRA_FORMAT_RETRIES = 2");
    expect(engine).toContain("buildJiraRepairPrompt");
    expect(engine).toContain("isRetryableJiraFormatError");
    expect(engine).toContain("Jira context format was invalid; asking ChatGPT to reformat it");
    expect(protocol).toContain("Keep the JSON under 16,000 characters");
    expect(protocol).toContain("normalizeJsonCandidate");
  });

  it("binds one ChatGPT Project per repository and one canonical conversation per PR with bounded parallel review windows", async () => {
    const driver = await source(mainRoot, "chatgpt-web-driver.ts");
    const engine = await source(mainRoot, "review-engine.ts");
    const state = await source(mainRoot, "state-store.ts");
    const main = await source(path.join(process.cwd(), "src"), "main.ts");

    expect(driver).toContain("ensureProject(repository: string, storedProjectUrl?: string)");
    expect(driver).toContain("async function createProject(window: BrowserWindow, projectName: string)");
    expect(driver).not.toContain("ensureProjectOnlyMemory");
    expect(driver).not.toContain("Project-only memory");
    expect(driver).toContain("clickWebPoint");
    expect(driver).toContain("contents.sendInputEvent({ type: \"mouseDown\"");
    expect(driver).toContain("locating the ChatGPT Project creation control");
    expect(driver).toContain("revealProjectsNavigation");
    expect(driver).toContain("findProjectByName");
    expect(driver).toContain("openCreateProjectUi");
    expect(driver).toContain('button[aria-label="New project"]');
    expect(driver).toContain('#project-name, input[name="projectName"]');
    expect(driver).toContain("trustedInsertText(contents, projectName)");
    expect(driver).toContain("if (!window.isVisible()) window.show()");
    expect(driver).toContain("if (window.isVisible()) window.hide()");
    expect(driver).toContain('debuggerApi.sendCommand("Input.dispatchKeyEvent"');
    expect(driver).toContain("PR Review - ${repository.replace('/', ' - ')}");
    expect(driver).toContain("syncProjectNameReactState");
    expect(driver).toContain("input._valueTracker");
    expect(driver).toContain("reactNameSyncAttempted");
    expect(driver).toContain('button[type="submit"]');
    expect(driver).toContain("waiting-create-enabled");
    expect(driver).toContain("new InputEvent('input'");
    expect(driver).toContain("const createPattern = /(?:new|create)");
    expect(driver).toContain("private readonly taskWindows = new Map<string, BrowserWindow>()");
    expect(driver).toContain("pullRequestConversationUrl?: string");
    expect(driver).toContain("await window.loadURL(targetProject)");
    expect(driver).toContain("waitForStoredConversation");
    expect(driver).toContain("interactiveFallback: false");
    expect(driver).toContain("hidden review window");
    expect(driver).toContain("trustedSetComposerText");
    expect(driver).toContain("splitComposerInput(message, COMPOSER_INSERT_CHUNK_CHARS)");
    expect(driver).toContain("for (const chunk of chunks)");
    expect(driver).toContain('debuggerApi.sendCommand("Input.insertText", { text: chunk })');
    expect(driver).toContain("ChatGPT composer did not commit the full review prompt");
    expect(driver).toContain("submitComposerForm");
    expect(driver).toContain("form.requestSubmit(send)");
    expect(driver).toContain("trustedClickSend");
    expect(driver).toContain('debuggerApi.sendCommand("Input.dispatchMouseEvent"');
    expect(driver).toContain("Keep background review windows hidden");
    expect(driver).not.toContain("revealOwnerWindowForInput");
    expect(driver).not.toContain("BrowserWindow.fromWebContents(contents)");
    expect(driver).toContain("trustedSubmitPrompt");
    expect(driver).toContain("waitForPromptSubmission");
    expect(driver).toContain("composerDiagnostics");
    expect(driver).toContain("no pull-request conversation was created or updated");
    expect(driver).toContain('segment === "c"');

    expect(engine).toContain("const MAX_CONCURRENT_REVIEWS = 3");
    expect(engine).toContain("ensureRepositoryProject(repository)");
    expect(engine).toContain("getPullRequestChatConversation(repository, pr.number)");
    expect(engine).toContain("bindPullRequestConversation");
    expect(engine).toContain("Created and bound ChatGPT conversation for");
    expect(engine).toContain("replacePullRequestChatConversation");
    expect(engine).toContain("replaceRepositoryChatProject");
    expect(engine).toContain("repositoryProjectPromises");

    expect(state).toContain("chatgptProjectUrl");
    expect(state).toContain("chatgptPrConversations");
    expect(state).not.toContain("updateRepositoryChatConversation");
    expect(main).toContain("review.conversationUrl ?? repository?.chatgptProjectUrl");
  });

});
