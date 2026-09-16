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


describe("StateStore repository ChatGPT conversation", () => {
  it("migrates the latest valid review conversation into one canonical repository conversation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-conversation-"));
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
        webhook: { hookId: null, targetUrl: "", status: "pending" },
      }],
      reviews: [
        {
          id: "new", taskId: "review_1111111111111111", repository: "owner/repo", prNumber: 2,
          prTitle: "new", prUrl: "https://github.com/owner/repo/pull/2", headSha: "b".repeat(40),
          status: "completed", phase: "completed", jiraKeys: [], specDocumentIds: [],
          startedAt: "2026-09-16T09:00:00.000Z", updatedAt: "2026-09-16T10:00:00.000Z",
          conversationUrl: "https://chatgpt.com/c/canonical-repo-chat",
        },
        {
          id: "old", taskId: "review_2222222222222222", repository: "owner/repo", prNumber: 1,
          prTitle: "old", prUrl: "https://github.com/owner/repo/pull/1", headSha: "a".repeat(40),
          status: "completed", phase: "completed", jiraKeys: [], specDocumentIds: [],
          startedAt: "2026-09-16T07:00:00.000Z", updatedAt: "2026-09-16T08:00:00.000Z",
          conversationUrl: "https://chatgpt.com/c/old-chat",
        },
      ],
      webhookDeliveries: [],
    }), "utf8");

    const store = new StateStore(file);
    await store.load();
    expect(store.getRepository("owner/repo")?.chatgptConversationUrl).toBe("https://chatgpt.com/c/canonical-repo-chat");

    await store.updateRepositoryChatConversation("owner/repo", "https://chatgpt.com/c/canonical-repo-chat");
    const reloaded = new StateStore(file);
    await reloaded.load();
    expect(reloaded.getRepository("owner/repo")?.chatgptConversationUrl).toBe("https://chatgpt.com/c/canonical-repo-chat");
  });
});
