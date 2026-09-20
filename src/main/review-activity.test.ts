import { describe, expect, it } from "vitest";

import { canonicalReviewTaskId, ReviewActivityBuffer } from "./review-activity";

describe("review activity buffer", () => {
  it("maps OCR ChatGPT subtasks back to the parent review task", () => {
    expect(canonicalReviewTaskId("review_abc123__ocr_deadbeef")).toBe("review_abc123");
    expect(canonicalReviewTaskId("review_abc123")).toBe("review_abc123");
  });

  it("keeps bounded distinct progress and state entries per review", () => {
    const buffer = new ReviewActivityBuffer();
    const normalized = buffer.record({
      type: "progress",
      taskId: "review_abc123__ocr_deadbeef",
      phase: "reviewing-diff",
      message: "OCR agent LLM turn via ChatGPT Web.",
    });
    buffer.record({
      type: "progress",
      taskId: "review_abc123__ocr_deadbeef",
      phase: "reviewing-diff",
      message: "OCR agent LLM turn via ChatGPT Web.",
    });
    buffer.record({
      type: "state",
      taskId: "review_abc123",
      phase: "reviewing-diff",
      message: "OpenCodeReview is reviewing the exact PR head.",
    });

    expect(normalized.taskId).toBe("review_abc123");
    expect(buffer.snapshot(["review_abc123"]).review_abc123).toHaveLength(2);
    expect(buffer.snapshot(["review_abc123"]).review_abc123?.[0]?.type).toBe("progress");
    expect(buffer.snapshot(["other"])).toEqual({});
  });
});
