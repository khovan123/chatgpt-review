import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("remote admin settings parity", () => {
  it("exposes and updates the mutable review configuration from the web admin", async () => {
    const remote = await readFile(path.join(process.cwd(), "src", "main", "remote-admin.ts"), "utf8");
    const main = await readFile(path.join(process.cwd(), "src", "main.ts"), "utf8");

    expect(remote).toContain('"/admin/api/config/update"');
    expect(remote).toContain("updateConfig: (config: Partial<ReviewConfig>)");
    expect(remote).toContain("remoteConfigInput(body)");
    expect(remote).toContain("autoReview");
    expect(remote).toContain("postComment");
    expect(remote).toContain("reviewDrafts");
    expect(remote).toContain("requireJiraWhenKeyPresent");
    expect(remote).toContain("maxDiffChunkBytes");
    expect(remote).toContain("webhookListenHost");
    expect(remote).toContain("webhookListenPort");

    expect(remote).toContain("remoteToggle('remote-auto-review'");
    expect(remote).toContain("remoteToggle('remote-post-comment'");
    expect(remote).toContain("remoteToggle('remote-review-drafts'");
    expect(remote).toContain("remoteToggle('remote-require-jira'");
    expect(remote).toContain('id="remote-max-diff"');
    expect(remote).toContain('id="remote-webhook-host"');
    expect(remote).toContain('id="remote-webhook-port"');
    expect(remote).toContain("saveRemoteConfig()");
    expect(remote).toContain("Settings saved and synchronized with the desktop app.");

    expect(main).toContain("updateConfig: updateConfigFromRemote");
    expect(main).toContain("async function updateReviewConfig");
    expect(main).toContain("return updateReviewConfig(input)");
    expect(main).toContain("return updateReviewConfig(config as Record<string, any>)");
  });
});
