import { describe, expect, it } from "vitest";

import {
  buildChunkReviewPrompt,
  buildFinalReviewPrompt,
  extractJiraKeys,
  parseFinalReview,
  parseJiraResolution,
  redactSecrets,
  splitDiff,
} from "./review-protocol";

describe("review protocol", () => {
  it("maps Jira keys from title before description and deduplicates them", () => {
    expect(extractJiraKeys("ABC-42 fix checkout", "Related to XYZ-7 and ABC-42")).toEqual(["ABC-42", "XYZ-7"]);
  });

  it("redacts common credentials before a diff is sent to ChatGPT Web", () => {
    const redacted = redactSecrets("API_TOKEN=super-secret-value\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz012345");
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("splits a multi-file patch into bounded chunks while retaining file names", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    const chunks = splitDiff(diff, 12_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.files).toEqual(["a.ts", "b.ts"]);
  });

  it("parses task-bound Jira context", () => {
    const raw = `[JIRA_CONTEXT]\nTASK_ID: review_0123456789abcdef\nPRIMARY_KEY: ABC-42\nSTATUS: RESOLVED\nJSON:\n{"issues":[{"key":"ABC-42","summary":"Fix checkout","description":"Do it","acceptanceCriteria":"Works","status":"In Progress"}],"notes":"ok"}\n[/JIRA_CONTEXT]`;
    const result = parseJiraResolution(raw, "review_0123456789abcdef");
    expect(result.status).toBe("resolved");
    expect(result.primaryKey).toBe("ABC-42");
    expect(result.issues[0]?.description).toBe("Do it");
  });

  it("parses a final structured review", () => {
    const raw = `[PR_REVIEW]\nTASK_ID: review_0123456789abcdef\nJSON:\n{"verdict":"CHANGES_REQUESTED","summary":"Bug found","jiraAlignment":"miss","specAlignment":"miss","testAssessment":"needs test","findings":[{"severity":"P1","file":"src/a.ts","line":12,"title":"Wrong guard","explanation":"bad","evidence":"diff","jiraRef":"ABC-42","specRef":"spec:a","suggestion":"fix"}]}\n[/PR_REVIEW]`;
    const result = parseFinalReview(raw, "review_0123456789abcdef");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings[0]?.severity).toBe("P1");
  });

  it("keeps chunk and synthesis prompts below the ChatGPT Web input bound without truncating JSON mid-object", () => {
    const taskId = "review_0123456789abcdef";
    const noisy = "yêu-cầu-kiểm-thử ".repeat(500);
    const pr = {
      repository: "example/repo",
      number: 12,
      title: "ABC-42 harden checkout",
      body: noisy,
      url: "https://github.com/example/repo/pull/12",
      headSha: "a".repeat(40),
      headBranch: "abc-42-checkout",
      baseBranch: "main",
      isDraft: false,
      state: "OPEN",
      author: "dev",
      changedFiles: 3,
    };
    const jira = {
      primaryKey: "ABC-42",
      status: "resolved" as const,
      issues: [
        { key: "ABC-42", summary: noisy, description: noisy, acceptanceCriteria: noisy, status: "In Progress" },
        { key: "XYZ-7", summary: noisy, description: noisy, acceptanceCriteria: noisy, status: "Open" },
      ],
      notes: noisy,
      raw: noisy,
    };
    const spec = Array.from({ length: 10 }, (_, index) => ({
      documentId: `spec_${index}`,
      documentName: `spec-${index}.md`,
      chunkId: `spec_${index}:0`,
      score: 10 - index,
      text: noisy,
    }));
    const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n${`+${noisy}\n`.repeat(20)}`;
    const chunk = splitDiff(diff, 90_000)[0]!;
    const chunkPrompt = buildChunkReviewPrompt({ taskId, pr, jira, spec, chunk, totalChunks: 1 });
    expect(Buffer.byteLength(chunkPrompt, "utf8")).toBeLessThan(120 * 1024);

    const finding = {
      severity: "P1" as const,
      file: "src/a.ts",
      line: 12,
      title: noisy,
      explanation: noisy,
      evidence: noisy,
      jiraRef: "ABC-42",
      specRef: "spec_0:0",
      suggestion: noisy,
    };
    const finalPrompt = buildFinalReviewPrompt({
      taskId,
      pr,
      jira,
      spec,
      chunks: Array.from({ length: 30 }, () => ({ summary: noisy, findings: Array.from({ length: 12 }, () => finding), raw: "" })),
    });
    expect(Buffer.byteLength(finalPrompt, "utf8")).toBeLessThan(120 * 1024);
    const evidence = finalPrompt.match(/CHUNK_FINDINGS_JSON:\n([\s\S]*?)\n\nReturn exactly one block/)?.[1];
    expect(evidence).toBeTruthy();
    expect(() => JSON.parse(evidence!)).not.toThrow();
  });
});
