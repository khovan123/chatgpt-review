import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeRepository, StateStore } from "./state-store";
import { shouldTriggerPullRequestReview, verifyGitHubSignature } from "./webhook-server";

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
});

describe("GitHub webhook ingress", () => {
  it("verifies the signature against the exact raw body", () => {
    const secret = "a".repeat(64);
    const body = Buffer.from('{"action":"synchronize"}', "utf8");
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyGitHubSignature(signature, body, secret)).toBe(true);
    expect(verifyGitHubSignature(signature, Buffer.from('{"action":"edited"}'), secret)).toBe(false);
  });

  it("triggers reviews only for PR lifecycle actions that can change review evidence", () => {
    expect(shouldTriggerPullRequestReview("opened")).toBe(true);
    expect(shouldTriggerPullRequestReview("synchronize")).toBe(true);
    expect(shouldTriggerPullRequestReview("edited")).toBe(true);
    expect(shouldTriggerPullRequestReview("ready_for_review")).toBe(true);
    expect(shouldTriggerPullRequestReview("closed")).toBe(false);
    expect(shouldTriggerPullRequestReview("labeled")).toBe(false);
  });

  it("persists delivery idempotency and rejects conflicting replay payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-webhook-"));
    cleanup.push(root);
    const state = new StateStore(path.join(root, "state.json"));
    await state.load();
    await state.upsertRepository(makeRepository("example/repo"));

    const delivery = {
      deliveryId: "delivery-1",
      payloadSha256: "b".repeat(64),
      repository: "example/repo",
      event: "pull_request",
      action: "synchronize",
      prNumber: 42,
      headSha: "c".repeat(40),
      receivedAt: new Date().toISOString(),
    };
    await expect(state.recordWebhookDelivery(delivery)).resolves.toBe("created");
    await expect(state.recordWebhookDelivery(delivery)).resolves.toBe("replayed");
    await expect(state.recordWebhookDelivery({ ...delivery, payloadSha256: "d".repeat(64) })).rejects.toThrow(/different payload/i);
  });
});
