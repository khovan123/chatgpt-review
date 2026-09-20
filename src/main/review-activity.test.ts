import { describe, expect, it } from "vitest";

import { canonicalReviewTaskId, isValidReviewTaskId, makeOcrReviewTaskId, ReviewActivityBuffer } from "./review-activity";

describe("review activity buffer", () => {
  it("maps OCR ChatGPT subtasks back to the parent review task", () => {
    expect(canonicalReviewTaskId("review_0123456789abcdef__ocr_fedcba9876543210")).toBe("review_0123456789abcdef");
    expect(canonicalReviewTaskId("review_0123456789abcdef")).toBe("review_0123456789abcdef");
  });


  it("shares one strict task-id contract between parent reviews and OCR child tasks", () => {
    const parent = "review_0123456789abcdef";
    const child = makeOcrReviewTaskId(parent, "fedcba9876543210");

    expect(child).toBe("review_0123456789abcdef__ocr_fedcba9876543210");
    expect(isValidReviewTaskId(parent)).toBe(true);
    expect(isValidReviewTaskId(child)).toBe(true);
    expect(isValidReviewTaskId("review_parent__ocr_deadbeef")).toBe(false);
    expect(() => makeOcrReviewTaskId("review_parent", "fedcba9876543210")).toThrow(/parent review task id/i);
  });

  it("keeps bounded distinct progress and state entries per review", () => {
    const buffer = new ReviewActivityBuffer();
    const normalized = buffer.record({
      type: "progress",
      taskId: "review_0123456789abcdef__ocr_fedcba9876543210",
      phase: "reviewing-diff",
      message: "OCR agent LLM turn via ChatGPT Web.",
    });
    buffer.record({
      type: "progress",
      taskId: "review_0123456789abcdef__ocr_fedcba9876543210",
      phase: "reviewing-diff",
      message: "OCR agent LLM turn via ChatGPT Web.",
    });
    buffer.record({
      type: "state",
      taskId: "review_0123456789abcdef",
      phase: "reviewing-diff",
      message: "OpenCodeReview is reviewing the exact PR head.",
    });

    expect(normalized.taskId).toBe("review_0123456789abcdef");
    expect(buffer.snapshot(["review_0123456789abcdef"]).review_0123456789abcdef).toHaveLength(2);
    expect(buffer.snapshot(["review_0123456789abcdef"]).review_0123456789abcdef?.[0]?.type).toBe("progress");
    expect(buffer.snapshot(["other"])).toEqual({});
  });
});
