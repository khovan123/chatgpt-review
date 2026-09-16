import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SpecMemoryStore } from "./spec-memory";

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
});

describe("SpecMemoryStore", () => {
  it("persists extracted chunks and retrieves Jira-relevant specification text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-spec-"));
    cleanup.push(root);
    const specPath = path.join(root, "checkout.md");
    await writeFile(specPath, "# ABC-42 Checkout\n\nThe checkout endpoint must reject expired coupons and return HTTP 422.\n\n# Other\n\nProfile avatars are optional.", "utf8");
    const storePath = path.join(root, "memory.json");
    const store = new SpecMemoryStore(storePath);
    await store.load();
    await store.addFiles([specPath]);

    const results = store.search("ABC-42 expired coupon checkout", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.text).toContain("expired coupons");

    const persisted = JSON.parse(await readFile(storePath, "utf8"));
    expect(persisted[0].chunkCount).toBeGreaterThan(0);
  });
});
