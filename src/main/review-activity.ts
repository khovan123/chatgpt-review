import type { ReviewActivityEntry } from "./types";

const MAX_ACTIVITY_PER_TASK = 120;
const MAX_ACTIVITY_TASKS = 200;
const MAX_ACTIVITY_MESSAGE = 2_000;
const REVIEW_TASK_ID_PATTERN = /^review_[a-f0-9]{16}(?:__ocr_[a-f0-9]{16})?$/;
const PARENT_REVIEW_TASK_ID_PATTERN = /^review_[a-f0-9]{16}$/;

export interface ReviewActivityEvent {
  type: "state" | "progress";
  taskId?: string;
  phase?: string;
  message: string;
}

export class ReviewActivityBuffer {
  private readonly byTask = new Map<string, ReviewActivityEntry[]>();

  record<T extends ReviewActivityEvent>(event: T): T {
    const canonicalTaskId = canonicalReviewTaskId(event.taskId);
    const normalized = (canonicalTaskId ? { ...event, taskId: canonicalTaskId } : event) as T;
    if (!canonicalTaskId) return normalized;

    const message = compactActivityMessage(event.message);
    if (!message) return normalized;

    const entries = this.byTask.get(canonicalTaskId) ?? [];
    const last = entries.at(-1);
    if (last?.type === event.type && last.message === message && last.phase === event.phase) {
      return normalized;
    }

    entries.push({
      type: event.type,
      phase: event.phase ?? "",
      message,
      at: new Date().toISOString(),
    });
    if (entries.length > MAX_ACTIVITY_PER_TASK) {
      entries.splice(0, entries.length - MAX_ACTIVITY_PER_TASK);
    }
    this.byTask.delete(canonicalTaskId);
    this.byTask.set(canonicalTaskId, entries);

    while (this.byTask.size > MAX_ACTIVITY_TASKS) {
      const oldest = this.byTask.keys().next().value;
      if (!oldest) break;
      this.byTask.delete(oldest);
    }
    return normalized;
  }

  snapshot(taskIds: Iterable<string>): Record<string, ReviewActivityEntry[]> {
    const result: Record<string, ReviewActivityEntry[]> = {};
    for (const taskId of taskIds) {
      const canonical = canonicalReviewTaskId(taskId);
      if (!canonical) continue;
      const entries = this.byTask.get(canonical);
      if (!entries?.length) continue;
      result[canonical] = entries.map((entry) => ({ ...entry }));
    }
    return result;
  }
}

export function isValidReviewTaskId(taskId: string): boolean {
  return REVIEW_TASK_ID_PATTERN.test(taskId);
}

export function makeOcrReviewTaskId(parentTaskId: string, digest: string): string {
  if (!PARENT_REVIEW_TASK_ID_PATTERN.test(parentTaskId)) {
    throw new Error("Parent review task id is invalid.");
  }
  if (!/^[a-f0-9]{16}$/.test(digest)) {
    throw new Error("OCR review task digest is invalid.");
  }
  return `${parentTaskId}__ocr_${digest}`;
}

export function canonicalReviewTaskId(taskId: string | undefined): string {
  if (!taskId) return "";
  const match = taskId.match(/^(review_[a-f0-9]{16})(?:__ocr_[a-f0-9]{16})?$/);
  return match?.[1] ?? taskId;
}

function compactActivityMessage(value: string): string {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_ACTIVITY_MESSAGE);
}
