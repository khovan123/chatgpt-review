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
    expect(driver).toContain("if (!this.currentTaskId && url");
    expect(driver).toContain("executeJavaScriptSafe");
    expect(driver).toContain("contents.isDestroyed()");
    expect(driver).not.toContain(".catch(() => emptySnapshot())");
    expect(driver).not.toContain("clickSend(contents).catch(() => false)");
  });

  it("releases the ChatGPT lane and prevents Open Chat navigation during an active review", async () => {
    const engine = await source(mainRoot, "review-engine.ts");
    const renderer = await source(rendererRoot, "app.js");

    expect(engine).toContain("this.dependencies.chatgpt.finishTask(record.taskId)");
    expect(renderer).toContain('const terminal = review.status === "completed" || review.status === "blocked" || review.status === "failed"');
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
    expect(renderer).toContain('if (type === "progress" && last?.type === "progress") entries[entries.length - 1] = nextEntry');
    expect(renderer).toContain("compactReviewProgress(rawText)");
  });
  it("reuses one persisted ChatGPT conversation per repository instead of creating a chat per review", async () => {
    const driver = await source(mainRoot, "chatgpt-web-driver.ts");
    const engine = await source(mainRoot, "review-engine.ts");
    const main = await source(path.join(process.cwd(), "src"), "main.ts");

    expect(driver).toContain("startTask(taskId: string, repositoryConversationUrl?: string)");
    expect(driver).toContain("const targetUrl = targetConversation ?? CHATGPT_URL");
    expect(driver).toContain("onConversationUrl?.(currentConversationUrl)");
    expect(driver).toContain('let boundConversationUrl = ""');
    expect(driver).not.toContain("ensureWindow(true)");
    expect(engine).toContain("repositoryRecord?.chatgptConversationUrl");
    expect(engine).toContain("bindRepositoryConversation(record");
    expect(engine).toContain("updateRepositoryChatConversation");
    expect(engine).toContain("priorConversation");
    expect(main).toContain("repository?.chatgptConversationUrl ?? review.conversationUrl");
  });

});
