import { describe, expect, it } from "vitest";

import {
  buildJiraRepairPrompt,
  extractJiraKeys,
  githubReviewEventForVerdict,
  parseJiraResolution,
  reviewMarkdown,
} from "./review-protocol";

describe("review protocol", () => {
  it("maps Jira keys from title before description and deduplicates them", () => {
    expect(extractJiraKeys("ABC-42 fix checkout", "Related to XYZ-7 and ABC-42")).toEqual(["ABC-42", "XYZ-7"]);
  });

  it("parses task-bound Jira context", () => {
    const raw = `[JIRA_CONTEXT]
TASK_ID: review_0123456789abcdef
PRIMARY_KEY: ABC-42
STATUS: RESOLVED
JSON:
{"issues":[{"key":"ABC-42","summary":"Fix checkout","description":"Do it","acceptanceCriteria":"Works","status":"In Progress"}],"notes":"ok"}
[/JIRA_CONTEXT]`;
    const result = parseJiraResolution(raw, "review_0123456789abcdef");
    expect(result.status).toBe("resolved");
    expect(result.primaryKey).toBe("ABC-42");
    expect(result.issues[0]?.description).toBe("Do it");
  });

  it("accepts an accidentally fenced Jira JSON payload inside the required marker block", () => {
    const raw = `[JIRA_CONTEXT]
TASK_ID: review_0123456789abcdef
PRIMARY_KEY: ABC-42
STATUS: RESOLVED
JSON:
\`\`\`json
{"issues":[{"key":"ABC-42","summary":"Fix checkout","description":"Do it","acceptanceCriteria":"Works","status":"Open"}],"notes":"ok"}
\`\`\`
[/JIRA_CONTEXT]`;
    expect(parseJiraResolution(raw, "review_0123456789abcdef").issues[0]?.key).toBe("ABC-42");
  });

  it("repairs common Jira JSON with raw newlines in string fields", () => {
    const raw = `[JIRA_CONTEXT]
TASK_ID: review_0123456789abcdef
PRIMARY_KEY: ABC-42
STATUS: RESOLVED
JSON:
{"issues":[{"key":"ABC-42","summary":"Fix checkout","description":"Line one
Line two","acceptanceCriteria":"AC one
AC two","status":"Open"}],"notes":"ok"}
[/JIRA_CONTEXT]`;
    const result = parseJiraResolution(raw, "review_0123456789abcdef");
    expect(result.issues[0]?.description).toBe("Line one\nLine two");
    expect(result.issues[0]?.acceptanceCriteria).toBe("AC one\nAC two");
  });

  it("builds a bounded Jira repair turn that keeps the same task and candidate keys", () => {
    const prompt = buildJiraRepairPrompt({
      taskId: "review_0123456789abcdef",
      keys: ["ABC-42"],
      parseError: "Jira context JSON is invalid: Unterminated string",
      attempt: 1,
      maxAttempts: 2,
    });
    expect(prompt).toContain("TASK_ID: review_0123456789abcdef");
    expect(prompt).toContain("ABC-42");
    expect(prompt).toContain("FORMAT_RETRY: 1/2");
    expect(prompt).toContain("under 16,000 characters");
  });

  it("maps final verdicts to real GitHub pull request review events", () => {
    expect(githubReviewEventForVerdict("PASS")).toBe("APPROVE");
    expect(githubReviewEventForVerdict("CHANGES_REQUESTED")).toBe("REQUEST_CHANGES");
    expect(githubReviewEventForVerdict("BLOCKED")).toBe("REQUEST_CHANGES");
  });

  it("renders OCR-managed provenance, coverage, findings and exact PR head", () => {
    const result = {
      verdict: "CHANGES_REQUESTED" as const,
      summary: "Bug found",
      jiraAlignment: "LCSP-42 supplied as supplemental context",
      specAlignment: "Spec supplied as supplemental context",
      testAssessment: "Needs regression test",
      findings: [{
        severity: "P1" as const,
        file: "src/a.ts",
        line: 12,
        title: "Wrong guard",
        explanation: "The guard accepts an invalid state.",
        evidence: "The changed branch skips the required state check.",
        jiraRef: "",
        specRef: "",
        suggestion: "Restore the state guard before continuing.",
        checkpoint: "Authorization state transition",
        rootCause: "The refactor removed the required state guard before the authorization branch.",
        impact: "Invalid state can pass through the authorization path.",
        reproduction: "Call the changed path with an invalid state and observe that it is accepted.",
        regressionTests: "Add a test proving the invalid state is rejected and the valid state still succeeds.",
      }],
    };
    const pr = {
      repository: "example/repo",
      number: 12,
      title: "LCSP-42 harden auth",
      body: "",
      url: "https://github.com/example/repo/pull/12",
      headSha: "a".repeat(40),
      headBranch: "lcsp-42-auth",
      baseBranch: "main",
      isDraft: false,
      state: "OPEN",
      author: "dev",
      changedFiles: 1,
    };
    const jira = {
      primaryKey: "LCSP-42",
      status: "resolved" as const,
      issues: [{ key: "LCSP-42", summary: "Harden auth", description: "Do it", acceptanceCriteria: "AC1: Guard invalid state\nAC2: Preserve valid authorization flow", status: "In Progress" }],
      notes: "",
      raw: "",
    };
    const ocr = {
      mode: "managed" as const,
      version: "1.12.5",
      schemaVersion: "ocr-review-json",
      status: "complete",
      model: "chatgpt-web",
      sessionId: "session-1",
      totalFiles: 2,
      reviewableFiles: 1,
      excludedFiles: 1,
      reviewedFiles: 1,
      toolCalls: 9,
      toolCallFailures: 0,
      excluded: [{ path: "src/a.test.ts", reason: "default_path" }],
    };

    const markdown = reviewMarkdown(result, pr, jira, ocr, {
      headSha: "b".repeat(40),
      result: {
        verdict: "CHANGES_REQUESTED",
        summary: "Previous blocker",
        jiraAlignment: "",
        specAlignment: "",
        testAssessment: "",
        findings: [{ ...result.findings[0], title: "Old state guard defect" }],
      },
    });
    expect(markdown).toContain("PR Re-Review — LCSP-42 Harden auth");
    expect(markdown).toContain("CHANGES REQUESTED — 1 P0–P2 blocker");
    expect(markdown).toContain("Bug found");
    expect(markdown).toContain("Exact HEAD reviewed:** " + "a".repeat(40));
    expect(markdown).toContain("Jira source of truth:** LCSP-42 — Harden auth");
    expect(markdown).toContain("OpenCodeReview v1.12.5 managed agent + ChatGPT Web LLM gateway");
    expect(markdown).toContain("OCR coverage:** 1/1 reviewable files reviewed; 1 explicitly excluded.");
    expect(markdown).toContain("OCR runtime:** complete · model chatgpt-web · 9 tool call(s) · 0 failure(s).");
    expect(markdown).toContain("Guard invalid state");
    expect(markdown).toContain("Preserve valid authorization flow");
    expect(markdown).toContain("<summary><strong>🔎 Changed scope reviewed</strong>");
    expect(markdown).toContain("### Checkpoint");
    expect(markdown).toContain("Authorization state transition");
    expect(markdown).toContain("### Root cause");
    expect(markdown).toContain("The refactor removed the required state guard");
    expect(markdown).toContain("### Suggested change");
    expect(markdown).toContain("Restore the state guard before continuing.");
    expect(markdown).toContain("✅ Resolved: P1 — Old state guard defect");
    expect(markdown).toContain("GitHub review event:** REQUEST_CHANGES");
    expect(markdown).toContain("Merge status:** ❌ CHANGES REQUIRED");
    expect(markdown).toContain("P1 — Wrong guard");

    const unicodeHeavy = reviewMarkdown({
      ...result,
      findings: [{ ...result.findings[0], evidence: "ữ".repeat(100_000) }],
    }, pr, jira, ocr);
    expect(Buffer.byteLength(unicodeHeavy, "utf8")).toBeLessThanOrEqual(58_000);
  });
  it("renders a PASS re-review with Jira checkpoints, reviewed-change dropdown and READY status", () => {
    const markdown = reviewMarkdown({
      verdict: "PASS",
      summary: "No P0–P2 defect remains on this exact head.",
      jiraAlignment: "LCSP-329 requirements were supplied to the managed review.",
      specAlignment: "No attached spec context.",
      testAssessment: "Repository CI is external to this runner.",
      findings: [],
    }, {
      repository: "example/repo",
      number: 329,
      title: "refactor(auth): LCSP-329 revise Auth/RBAC boundary",
      body: "",
      url: "https://github.com/example/repo/pull/329",
      headSha: "9".repeat(40),
      headBranch: "lcsp-329-auth-rbac",
      baseBranch: "develop",
      isDraft: false,
      state: "OPEN",
      author: "dev",
      changedFiles: 12,
    }, {
      primaryKey: "LCSP-329",
      status: "resolved",
      issues: [{
        key: "LCSP-329",
        summary: "Revised Auth/RBAC architecture",
        description: "Realign the boundary.",
        acceptanceCriteria: "AC1: Standard Auth module boundary\nAC2: RBAC owns authorization decisions\nAC3: Minimal Auth public surface",
        status: "In Review",
      }],
      notes: "",
      raw: "",
    }, {
      mode: "managed",
      version: "1.12.5",
      schemaVersion: "ocr-review-json",
      status: "complete",
      model: "chatgpt-web",
      sessionId: "session-pass",
      totalFiles: 12,
      reviewableFiles: 10,
      excludedFiles: 2,
      reviewedFiles: 10,
      toolCalls: 18,
      toolCallFailures: 0,
      excluded: [{ path: "docs/notes.md", reason: "unsupported_ext" }],
    });

    expect(markdown).toContain("# ✅ PR Re-Review — LCSP-329 Revised Auth/RBAC architecture");
    expect(markdown).toContain("Standard Auth module boundary");
    expect(markdown).toContain("RBAC owns authorization decisions");
    expect(markdown).toContain("<summary><strong>🔎 Changed scope reviewed</strong>");
    expect(markdown).toContain("✅ No supported P0–P2 defect remains on this exact head.");
    expect(markdown).toContain("**Merge status:** ✅ READY");
    expect(markdown).not.toContain("## Recommended fix order");
  });

});
