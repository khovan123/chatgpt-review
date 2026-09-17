import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "./state-store";
import type { CloudflareProvisioningRecord } from "./types";

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
});

function managedRecord(): CloudflareProvisioningRecord {
  return {
    mode: "api",
    accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    accountName: "Personal Cloudflare",
    zoneId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    zoneName: "example.com",
    tunnelId: "12345678-1234-1234-1234-123456789abc",
    tunnelName: "chatgpt-review-abc123",
    dnsRecordId: "cccccccccccccccccccccccccccccccc",
    hostname: "review.example.com",
    provisionedAt: "2026-09-16T09:00:00.000Z",
  };
}

describe("StateStore Cloudflare provisioning", () => {
  it("persists only resource metadata, never provisioning or runtime credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-state-"));
    cleanup.push(root);
    const file = path.join(root, "state.json");
    const store = new StateStore(file);
    await store.load();
    await store.setCloudflareProvisioning(managedRecord());
    await store.setConfig({ cloudflareHostname: "review.example.com" });

    const raw = await readFile(file, "utf8");
    expect(raw).toContain('"cloudflareProvisioning"');
    expect(raw).toContain('"review.example.com"');
    expect(raw).not.toMatch(/apiToken|tunnelToken|runtimeToken/i);

    const reloaded = new StateStore(file);
    await reloaded.load();
    expect(reloaded.getCloudflareProvisioning()).toEqual(managedRecord());
    expect(reloaded.getConfig().webhookPublicUrl).toBe("https://review.example.com/webhooks/v1/github");
  });

  it("drops malformed persisted Cloudflare provisioning metadata instead of failing application startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-state-malformed-"));
    cleanup.push(root);
    const file = path.join(root, "state.json");
    await writeFile(file, JSON.stringify({
      version: 3,
      config: {},
      cloudflareProvisioning: {
        ...managedRecord(),
        accountId: "bad id with spaces",
      },
      repositories: [],
      reviews: [],
      webhookDeliveries: [],
    }), "utf8");

    const store = new StateStore(file);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.getCloudflareProvisioning()).toBeNull();
  });
});


describe("StateStore ChatGPT Project and PR conversation bindings", () => {
  it("migrates legacy state without reusing the old cross-PR repository conversation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-project-migration-"));
    cleanup.push(root);
    const file = path.join(root, "state.json");
    await writeFile(file, JSON.stringify({
      version: 3,
      config: {},
      cloudflareProvisioning: null,
      repositories: [{
        id: "repo_1111111111111111",
        fullName: "owner/repo",
        addedAt: "2026-09-16T08:00:00.000Z",
        enabled: true,
        chatgptConversationUrl: "https://chatgpt.com/c/legacy-cross-pr-chat",
        webhook: { hookId: null, targetUrl: "", status: "pending" },
      }],
      reviews: [{
        id: "old", taskId: "review_2222222222222222", repository: "owner/repo", prNumber: 1,
        prTitle: "old", prUrl: "https://github.com/owner/repo/pull/1", headSha: "a".repeat(40),
        status: "completed", phase: "completed", jiraKeys: [], specDocumentIds: [],
        startedAt: "2026-09-16T07:00:00.000Z", updatedAt: "2026-09-16T08:00:00.000Z",
        conversationUrl: "https://chatgpt.com/c/legacy-review-chat",
      }],
      webhookDeliveries: [],
    }), "utf8");

    const store = new StateStore(file);
    await store.load();
    const repository = store.getRepository("owner/repo");
    expect(repository?.chatgptProjectUrl).toBeUndefined();
    expect(repository?.chatgptPrConversations).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(4);
  });

  it("persists one repository Project and distinct canonical conversations per PR", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-project-bindings-"));
    cleanup.push(root);
    const file = path.join(root, "state.json");
    const store = new StateStore(file);
    await store.load();
    await store.upsertRepository({
      id: "repo_2222222222222222",
      fullName: "owner/repo",
      addedAt: "2026-09-17T00:00:00.000Z",
      enabled: true,
      chatgptPrConversations: [],
      webhook: { hookId: null, targetUrl: "", status: "pending" },
    });

    await store.updateRepositoryChatProject("owner/repo", "https://chatgpt.com/g/g-p-project123/c/temporary-project-chat?model=gpt-5");
    await store.updatePullRequestChatConversation("owner/repo", 101, "https://chatgpt.com/c/pr-101-chat?model=gpt-5");
    await store.updatePullRequestChatConversation("owner/repo", 102, "https://chatgpt.com/c/pr-102-chat");

    expect(store.getRepository("owner/repo")?.chatgptProjectUrl).toBe("https://chatgpt.com/g/g-p-project123/project");
    expect(store.getPullRequestChatConversation("owner/repo", 101)).toBe("https://chatgpt.com/c/pr-101-chat");
    expect(store.getPullRequestChatConversation("owner/repo", 102)).toBe("https://chatgpt.com/c/pr-102-chat");

    const reloaded = new StateStore(file);
    await reloaded.load();
    expect(reloaded.getPullRequestChatConversation("owner/repo", 101)).toBe("https://chatgpt.com/c/pr-101-chat");
    expect(reloaded.getPullRequestChatConversation("owner/repo", 102)).toBe("https://chatgpt.com/c/pr-102-chat");
  });

  it("replaces only the stale PR conversation when the expected URL still matches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-pr-conversation-cas-"));
    cleanup.push(root);
    const file = path.join(root, "state.json");
    const store = new StateStore(file);
    await store.load();
    await store.upsertRepository({
      id: "repo_3333333333333333",
      fullName: "owner/repo",
      addedAt: "2026-09-17T00:00:00.000Z",
      enabled: true,
      chatgptProjectUrl: "https://chatgpt.com/g/g-p-project123/project",
      chatgptPrConversations: [],
      webhook: { hookId: null, targetUrl: "", status: "pending" },
    });
    await store.updatePullRequestChatConversation("owner/repo", 101, "https://chatgpt.com/c/stale-pr-101");
    await store.updatePullRequestChatConversation("owner/repo", 102, "https://chatgpt.com/c/pr-102-stays");

    await store.replacePullRequestChatConversation("owner/repo", 101, "https://chatgpt.com/c/stale-pr-101", "https://chatgpt.com/c/recovered-pr-101");
    expect(store.getPullRequestChatConversation("owner/repo", 101)).toBe("https://chatgpt.com/c/recovered-pr-101");
    expect(store.getPullRequestChatConversation("owner/repo", 102)).toBe("https://chatgpt.com/c/pr-102-stays");

    await expect(store.replacePullRequestChatConversation(
      "owner/repo",
      101,
      "https://chatgpt.com/c/stale-pr-101",
      "https://chatgpt.com/c/should-not-win",
    )).rejects.toThrow("changed concurrently");
  });

  it("clears PR conversations when a missing repository Project is replaced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-project-cas-"));
    cleanup.push(root);
    const file = path.join(root, "state.json");
    const store = new StateStore(file);
    await store.load();
    await store.upsertRepository({
      id: "repo_4444444444444444",
      fullName: "owner/repo",
      addedAt: "2026-09-17T00:00:00.000Z",
      enabled: true,
      chatgptProjectUrl: "https://chatgpt.com/g/g-p-oldproject/project",
      chatgptPrConversations: [{ prNumber: 101, conversationUrl: "https://chatgpt.com/c/old-pr-chat", updatedAt: "2026-09-17T00:00:00.000Z" }],
      webhook: { hookId: null, targetUrl: "", status: "pending" },
    });

    await store.replaceRepositoryChatProject(
      "owner/repo",
      "https://chatgpt.com/g/g-p-oldproject/project",
      "https://chatgpt.com/g/g-p-newproject/project",
    );
    expect(store.getRepository("owner/repo")?.chatgptProjectUrl).toBe("https://chatgpt.com/g/g-p-newproject/project");
    expect(store.getRepository("owner/repo")?.chatgptPrConversations).toEqual([]);
  });
});
