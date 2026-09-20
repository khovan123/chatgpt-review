import { describe, expect, it } from "vitest";

import { ReviewEngine } from "./review-engine";
import type { ReviewRecord } from "./types";

function reviewRecord(): ReviewRecord {
  return {
    id: "review-record",
    taskId: "review_0123456789abcdef",
    repository: "owner/repo",
    prNumber: 337,
    prTitle: "Test",
    prUrl: "https://github.com/owner/repo/pull/337",
    headSha: "a".repeat(40),
    status: "completed",
    phase: "completed",
    jiraKeys: [],
    specDocumentIds: [],
    startedAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:10:00.000Z",
    completedAt: "2026-09-20T00:10:00.000Z",
    conversationUrl: "https://chatgpt.com/c/main-review",
  };
}

describe("review conversation cleanup", () => {
  it("deletes main and OCR child conversations, clears only the PR binding, and keeps a successful review successful", async () => {
    const deleted: string[] = [];
    const removed: Array<{ repository: string; prNumber: number; expected?: string }> = [];
    const persisted: ReviewRecord[] = [];
    let bound = "https://chatgpt.com/c/main-review";

    const engine = new ReviewEngine({
      state: {
        getPullRequestChatConversation: () => bound,
        removePullRequestChatConversation: async (repository: string, prNumber: number, expected?: string) => {
          removed.push({ repository, prNumber, expected });
          bound = "";
          return { chatgptProjectUrl: "https://chatgpt.com/g/g-p-project/project", chatgptPrConversations: [] };
        },
        upsertReview: async (record: ReviewRecord) => {
          persisted.push(structuredClone(record));
          return record;
        },
      } as any,
      specs: {} as any,
      github: {} as any,
      ocr: {} as any,
      chatgpt: {
        deleteConversation: async (url: string) => {
          deleted.push(url);
        },
      } as any,
      webhookSecret: "secret",
    });

    const record = reviewRecord();
    await (engine as any).cleanupReviewConversations(
      record,
      new Set(["https://chatgpt.com/c/ocr-child"]),
    );

    expect(new Set(deleted)).toEqual(new Set([
      "https://chatgpt.com/c/main-review",
      "https://chatgpt.com/c/ocr-child",
    ]));
    expect(removed).toEqual([{
      repository: "owner/repo",
      prNumber: 337,
      expected: "https://chatgpt.com/c/main-review",
    }]);
    expect(record.conversationUrl).toBeUndefined();
    expect(record.status).toBe("completed");
    expect(record.phase).toBe("completed");
    expect(persisted.at(-1)?.conversationUrl).toBeUndefined();
  });

  it.each(["failed", "cancelled"] as const)(
    "still deletes review conversations when the review ends %s",
    async (status) => {
      const deleted: string[] = [];
      let bound = "https://chatgpt.com/c/main-review";
      const engine = new ReviewEngine({
        state: {
          getPullRequestChatConversation: () => bound,
          removePullRequestChatConversation: async () => {
            bound = "";
            return { chatgptProjectUrl: "https://chatgpt.com/g/g-p-project/project", chatgptPrConversations: [] };
          },
          upsertReview: async (record: ReviewRecord) => record,
        } as any,
        specs: {} as any,
        github: {} as any,
        ocr: {} as any,
        chatgpt: {
          deleteConversation: async (url: string) => {
            deleted.push(url);
          },
        } as any,
        webhookSecret: "secret",
      });

      const record = reviewRecord();
      record.status = status;
      record.phase = status;
      record.error = status === "failed" ? "review failed" : "Review cancelled by user.";

      await (engine as any).cleanupReviewConversations(
        record,
        new Set(["https://chatgpt.com/c/ocr-child"]),
      );

      expect(new Set(deleted)).toEqual(new Set([
        "https://chatgpt.com/c/main-review",
        "https://chatgpt.com/c/ocr-child",
      ]));
      expect(record.status).toBe(status);
      expect(record.phase).toBe(status);
      expect(record.conversationUrl).toBeUndefined();
      expect(bound).toBe("");
    },
  );

  it("preserves the completed review outcome when conversation cleanup still fails after retries", async () => {
    let attempts = 0;
    const persisted: ReviewRecord[] = [];
    const events: Array<{ type: string; message: string }> = [];
    const engine = new ReviewEngine({
      state: {
        getPullRequestChatConversation: () => "https://chatgpt.com/c/main-review",
        removePullRequestChatConversation: async () => ({ chatgptProjectUrl: "https://chatgpt.com/g/g-p-project/project" }),
        upsertReview: async (record: ReviewRecord) => {
          persisted.push(structuredClone(record));
          return record;
        },
      } as any,
      specs: {} as any,
      github: {} as any,
      ocr: {} as any,
      chatgpt: {
        deleteConversation: async () => {
          attempts += 1;
          throw new Error("delete failed");
        },
      } as any,
      webhookSecret: "secret",
      onEvent: (event: any) => events.push({ type: event.type, message: event.message }),
    });

    const record = reviewRecord();
    await (engine as any).cleanupReviewConversations(record, new Set());

    expect(attempts).toBe(3);
    expect(record.status).toBe("completed");
    expect(record.phase).toBe("completed");
    expect(record.error).toBeUndefined();
    expect(record.conversationUrl).toBe("https://chatgpt.com/c/main-review");
    expect(persisted.at(-1)?.status).toBe("completed");
    expect(events.at(-1)?.type).toBe("progress");
    expect(events.at(-1)?.message).toMatch(/cleanup incomplete/i);
    expect(events.at(-1)?.message).toMatch(/1\/1 conversation/);
  });
});
