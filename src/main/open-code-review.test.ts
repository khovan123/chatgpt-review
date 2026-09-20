import { describe, expect, it } from "vitest";

import {
  normalizeManagedReview,
  parseOpenCodeReviewPreview,
  parseOpenCodeReviewRunOutput,
} from "./open-code-review";

describe("OpenCodeReview managed integration", () => {
  it("parses OCR review preview coverage and exclusions", () => {
    const preview = parseOpenCodeReviewPreview(JSON.stringify({
      files: [
        { path: "src/a.ts", status: "modified", insertions: 8, deletions: 2, will_review: true },
        { path: "src/a.test.ts", status: "modified", insertions: 4, deletions: 1, will_review: false, exclude_reason: "default_path" },
      ],
      total_insertions: 12,
      total_deletions: 3,
      total_files: 2,
      reviewable_count: 1,
      excluded_count: 1,
    }));

    expect(preview.reviewableCount).toBe(1);
    expect(preview.excludedCount).toBe(1);
    expect(preview.files[0]?.willReview).toBe(true);
    expect(preview.files[1]?.excludeReason).toBe("default_path");
  });

  it("parses managed OCR JSON and normalizes findings without a second review prompt", () => {
    const output = parseOpenCodeReviewRunOutput(JSON.stringify({
      status: "complete",
      llm: { model: "chatgpt-web" },
      summary: { files_reviewed: 2, comments: 2, total_tokens: 4200 },
      tool_calls: { total: 11, failure: 0 },
      comments: [
        {
          path: "src/auth.ts",
          content: "Missing authorization guard allows a caller to cross the workspace boundary.",
          start_line: 42,
          end_line: 44,
          existing_code: "return repo.find(id)",
          suggestion_code: "assertWorkspaceAccess(id); return repo.find(id)",
          severity: "high",
          category: "security",
        },
        {
          path: "src/ui.ts",
          content: "The label can be clearer.",
          start_line: 8,
          severity: "low",
          category: "style",
        },
      ],
      session_id: "session-123",
      manifest: {
        terminal_state: "complete",
        coverage: {
          selected: ["src/auth.ts", "src/ui.ts"],
          completed: ["src/auth.ts", "src/ui.ts"],
          failed: [],
          waived: [],
        },
      },
    }));

    const result = normalizeManagedReview(output, {
      mode: "managed",
      version: "1.12.5",
      schemaVersion: "ocr-review-json",
      status: output.status,
      model: output.model,
      sessionId: output.sessionId,
      totalFiles: 2,
      reviewableFiles: 2,
      excludedFiles: 0,
      reviewedFiles: 2,
      toolCalls: output.toolCallsTotal,
      toolCallFailures: output.toolCallsFailure,
      excluded: [],
    });

    expect(output.sessionId).toBe("session-123");
    expect(output.toolCallsTotal).toBe(11);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings[0]?.severity).toBe("P1");
    expect(result.findings[0]?.file).toBe("src/auth.ts");
    expect(result.findings[0]?.suggestion).toContain("assertWorkspaceAccess");
    expect(result.findings[1]?.severity).toBe("P3");
  });

  it("fails closed when OCR coverage or tool execution is incomplete", () => {
    const output = parseOpenCodeReviewRunOutput(JSON.stringify({
      status: "completed_with_errors",
      llm: { model: "chatgpt-web" },
      summary: { files_reviewed: 1, comments: 0 },
      tool_calls: { total: 6, failure: 1 },
      comments: [],
      manifest: {
        terminal_state: "partial",
        coverage: {
          selected: ["src/a.ts", "src/b.ts"],
          completed: ["src/a.ts"],
          failed: ["src/b.ts"],
          waived: [],
        },
      },
    }));

    const result = normalizeManagedReview(output, {
      mode: "managed",
      version: "1.12.5",
      schemaVersion: "ocr-review-json",
      status: output.status,
      model: output.model,
      sessionId: "",
      totalFiles: 2,
      reviewableFiles: 2,
      excludedFiles: 0,
      reviewedFiles: 1,
      toolCalls: output.toolCallsTotal,
      toolCallFailures: output.toolCallsFailure,
      excluded: [],
    });

    expect(result.verdict).toBe("BLOCKED");
    expect(result.summary).toContain("coverage 1/2");
    expect(result.summary).toContain("tool call");
  });
});
