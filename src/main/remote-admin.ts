import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { AppView, ReviewConfig } from "./types";
import type { ExtraHttpHandler } from "./webhook-server";

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

export class RemoteAdminTokenStore {
  constructor(private readonly filePath: string) {}

  async loadOrCreate(): Promise<string> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const existing = (await readFile(this.filePath, "utf8")).trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) return existing.toLowerCase();
      throw new Error("Stored remote admin token is invalid.");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw error;
      const token = randomBytes(32).toString("hex");
      await writeFile(this.filePath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
      return token;
    }
  }
}

export interface RemoteAdminBuildResult {
  ok: boolean;
  output: string;
}

export interface RemoteAdminDependencies {
  token: string;
  getView: () => Promise<AppView>;
  authenticateGitHubToken: (token: string) => Promise<AppView>;
  linkRepository: (repository: string) => Promise<AppView>;
  unlinkRepository: (repository: string) => Promise<AppView>;
  syncRepositoryWebhook: (repository: string) => Promise<AppView>;
  refreshPullRequests: (repository?: string) => Promise<AppView>;
  runReview: (repository: string, prNumber: number, force: boolean) => Promise<unknown>;
  cancelReview: (reviewId: string) => Promise<AppView>;
  openChatGptSetup: () => Promise<void>;
  restartCloudflare: () => Promise<AppView>;
  updateConfig: (config: Partial<ReviewConfig>) => Promise<AppView>;
  triggerBuild: () => Promise<RemoteAdminBuildResult>;
}

export function createRemoteAdminHandler(dependencies: RemoteAdminDependencies): ExtraHttpHandler {
  return async (request, response, requestUrl) => {
    if (!requestUrl.pathname.startsWith("/admin")) return false;
    try {
      if (request.method === "GET" && (requestUrl.pathname === "/admin" || requestUrl.pathname === "/admin/")) {
        const suppliedToken = bearerToken(request) || requestUrl.searchParams.get("token") || "";
        const initialView = suppliedToken && suppliedToken === dependencies.token ? toRemoteAdminView(await dependencies.getView()) : null;
        const initialError = suppliedToken && suppliedToken !== dependencies.token ? "Remote admin token is invalid." : "";
        writeHtml(response, renderAdminHtml(initialView, initialError));
        return true;
      }
      if (!requestUrl.pathname.startsWith("/admin/api/")) {
        writeJson(response, 404, { error: "not found" });
        return true;
      }
      if (!isAuthorized(request, requestUrl, dependencies.token)) {
        writeJson(response, 401, { error: "remote admin token is required" });
        return true;
      }

      if (request.method === "GET" && requestUrl.pathname === "/admin/api/view") {
        writeJson(response, 200, toRemoteAdminView(await dependencies.getView()));
        return true;
      }

      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" });
        return true;
      }

      const body = await readJsonBody(request);
      switch (requestUrl.pathname) {
        case "/admin/api/github/auth": {
          const token = requiredString(body, "token", 4096);
          writeJson(response, 200, await dependencies.authenticateGitHubToken(token));
          return true;
        }
        case "/admin/api/repositories/link": {
          const repository = requiredString(body, "repository", 512);
          writeJson(response, 200, await dependencies.linkRepository(repository));
          return true;
        }
        case "/admin/api/repositories/unlink": {
          const repository = requiredString(body, "repository", 512);
          writeJson(response, 200, await dependencies.unlinkRepository(repository));
          return true;
        }
        case "/admin/api/repositories/sync-webhook": {
          const repository = requiredString(body, "repository", 512);
          writeJson(response, 200, await dependencies.syncRepositoryWebhook(repository));
          return true;
        }
        case "/admin/api/prs/refresh": {
          const repository = optionalString(body, "repository", 512);
          writeJson(response, 200, await dependencies.refreshPullRequests(repository || undefined));
          return true;
        }
        case "/admin/api/reviews/run": {
          const repository = requiredString(body, "repository", 512);
          const prNumber = requiredPositiveInteger(body, "prNumber");
          const review = await dependencies.runReview(repository, prNumber, body.force === true);
          writeJson(response, 200, { review });
          return true;
        }
        case "/admin/api/reviews/cancel": {
          const reviewId = requiredString(body, "reviewId", 128);
          writeJson(response, 200, await dependencies.cancelReview(reviewId));
          return true;
        }
        case "/admin/api/chatgpt/setup": {
          await dependencies.openChatGptSetup();
          writeJson(response, 200, { ok: true, message: "ChatGPT setup window opened on the VPS display." });
          return true;
        }
        case "/admin/api/cloudflare/restart": {
          writeJson(response, 200, await dependencies.restartCloudflare());
          return true;
        }
        case "/admin/api/config/update": {
          writeJson(response, 200, await dependencies.updateConfig(remoteConfigInput(body)));
          return true;
        }
        case "/admin/api/system/build": {
          writeJson(response, 200, await dependencies.triggerBuild());
          return true;
        }
        default:
          writeJson(response, 404, { error: "not found" });
          return true;
      }
    } catch (error) {
      writeJson(response, 500, { error: safeError(error) });
      return true;
    }
  };
}

function isAuthorized(request: IncomingMessage, requestUrl: URL, token: string): boolean {
  const supplied = bearerToken(request) || requestUrl.searchParams.get("token") || "";
  return supplied === token;
}

function bearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (typeof value !== "string") return "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > MAX_ADMIN_BODY_BYTES) throw new Error("Remote admin request body exceeds 64 KiB.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Remote admin JSON body must be an object.");
  return parsed;
}

function requiredString(value: Record<string, any>, key: string, maxLength: number): string {
  const text = typeof value[key] === "string" ? value[key].trim() : "";
  if (!text || text.length > maxLength) throw new Error(`${key} is required.`);
  return text;
}

function optionalString(value: Record<string, any>, key: string, maxLength: number): string {
  const text = typeof value[key] === "string" ? value[key].trim() : "";
  return text.length <= maxLength ? text : "";
}

function requiredPositiveInteger(value: Record<string, any>, key: string): number {
  const number = Number(value[key]);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${key} must be a positive integer.`);
  return number;
}

function remoteConfigInput(value: Record<string, any>): Partial<ReviewConfig> {
  const config: Partial<ReviewConfig> = {};
  for (const key of ["autoReview", "postComment", "reviewDrafts", "requireJiraWhenKeyPresent"] as const) {
    if (typeof value[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
    config[key] = value[key];
  }
  const maxDiffChunkBytes = Number(value.maxDiffChunkBytes);
  if (!Number.isInteger(maxDiffChunkBytes) || maxDiffChunkBytes < 12_000 || maxDiffChunkBytes > 90_000) {
    throw new Error("maxDiffChunkBytes must be between 12000 and 90000.");
  }
  config.maxDiffChunkBytes = maxDiffChunkBytes;

  const webhookListenHost = requiredString(value, "webhookListenHost", 64);
  const webhookListenPort = Number(value.webhookListenPort);
  if (!Number.isInteger(webhookListenPort) || webhookListenPort < 1024 || webhookListenPort > 65535) {
    throw new Error("webhookListenPort must be between 1024 and 65535.");
  }
  config.webhookListenHost = webhookListenHost;
  config.webhookListenPort = webhookListenPort;
  return config;
}

function writeHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(html);
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1000) : "unknown error";
}


function toRemoteAdminView(view: AppView): Record<string, unknown> {
  const root = record(view);
  const config = record(root.config);
  return {
    config: {
      autoReview: config.autoReview === true,
      postComment: config.postComment === true,
      reviewDrafts: config.reviewDrafts === true,
      requireJiraWhenKeyPresent: config.requireJiraWhenKeyPresent === true,
      maxDiffChunkBytes: number(config.maxDiffChunkBytes) || 42_000,
      webhookListenHost: text(config.webhookListenHost) || "127.0.0.1",
      webhookListenPort: number(config.webhookListenPort) || 8787,
      webhookPublicUrl: text(config.webhookPublicUrl),
      cloudflareHostname: text(config.cloudflareHostname),
    },
    provider: root.provider ?? null,
    ocr: root.ocr ?? null,
    chatgpt: root.chatgpt ?? null,
    webhook: root.webhook ?? null,
    tunnel: root.tunnel ?? null,
    repositories: array(root.repositories).map((item) => {
      const repo = record(item);
      const webhook = record(repo.webhook);
      return {
        id: text(repo.id),
        fullName: text(repo.fullName),
        addedAt: text(repo.addedAt),
        enabled: repo.enabled !== false,
        chatgptProjectUrl: text(repo.chatgptProjectUrl),
        chatgptPrConversations: array(repo.chatgptPrConversations).map((conversation) => {
          const value = record(conversation);
          return {
            prNumber: number(value.prNumber),
            conversationUrl: text(value.conversationUrl),
            updatedAt: text(value.updatedAt),
          };
        }),
        webhook: repo.webhook
          ? {
              hookId: webhook.hookId ?? null,
              targetUrl: text(webhook.targetUrl),
              status: text(webhook.status),
              lastDeliveryAt: text(webhook.lastDeliveryAt),
              lastEvent: text(webhook.lastEvent),
            }
          : null,
      };
    }),
    prs: array(root.prs).map((item) => {
      const pr = record(item);
      return {
        repository: text(pr.repository),
        number: number(pr.number),
        title: text(pr.title),
        url: text(pr.url),
        headSha: text(pr.headSha),
        headBranch: text(pr.headBranch),
        baseBranch: text(pr.baseBranch),
        isDraft: pr.isDraft === true,
        state: text(pr.state),
        author: text(pr.author),
        changedFiles: number(pr.changedFiles),
      };
    }),
    reviews: array(root.reviews).slice(0, 100).map((item) => {
      const review = record(item);
      const jira = record(review.jira);
      return {
        id: text(review.id),
        taskId: text(review.taskId),
        trigger: text(review.trigger),
        status: text(review.status),
        phase: text(review.phase),
        repository: text(review.repository),
        prNumber: number(review.prNumber),
        prTitle: text(review.prTitle),
        prUrl: text(review.prUrl),
        headSha: text(review.headSha),
        startedAt: text(review.startedAt),
        updatedAt: text(review.updatedAt),
        completedAt: text(review.completedAt),
        error: text(review.error),
        conversationUrl: text(review.conversationUrl),
        jiraKeys: array(review.jiraKeys).map(text),
        jiraStatus: text(jira.status),
      };
    }),
    reviewActivity: Object.fromEntries(
      Object.entries(record(root.reviewActivity))
        .slice(0, 200)
        .map(([taskId, entries]) => [
          text(taskId),
          array(entries).slice(-120).map((entry) => {
            const activity = record(entry);
            return {
              type: text(activity.type) === "state" ? "state" : "progress",
              phase: text(activity.phase),
              message: text(activity.message).slice(0, 2_000),
              at: text(activity.at),
            };
          }),
        ]),
    ),
  };
}

function record(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderAdminHtml(initialView: Record<string, unknown> | null = null, initialError = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ChatGPT Review Remote Admin</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #11100f;
      color: #f4f2ee;
      --background: #11100f;
      --surface: #171614;
      --surface-raised: #1d1b18;
      --sidebar: #181715;
      --sidebar-hover: #25231f;
      --sidebar-active: #302d29;
      --border: #34312c;
      --border-soft: #292722;
      --foreground: #f4f2ee;
      --muted: #aaa49b;
      --muted-2: #7f7970;
      --primary: #e9e4dc;
      --danger: #ff9d9d;
      --warning: #e6c272;
      --success: #8fd6a9;
      --info: #9dbcf0;
      --shadow: rgba(0,0,0,.34);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: var(--background); }
    body { min-width: 980px; color: var(--foreground); }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .5; }
    .hidden { display: none !important; }
    .desktop-shell { display: grid; grid-template-columns: 258px minmax(0,1fr); width: 100vw; height: 100vh; }
    .app-sidebar { position: relative; z-index: 10; display: flex; min-height: 0; flex-direction: column; border-right: 1px solid var(--border); background: var(--sidebar); padding: 12px; }
    .brand-row { display: flex; align-items: center; gap: 10px; padding: 4px 8px 14px; }
    .brand-mark { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; border: 1px solid #49453f; border-radius: 9px; background: #24211e; color: #fff; font-size: 10px; font-weight: 800; letter-spacing: .04em; }
    .brand-copy { min-width: 0; }
    .brand-copy strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 650; letter-spacing: -.01em; }
    .brand-copy span { display: block; margin-top: 2px; color: var(--muted); font-size: 10.5px; }
    .remote-access { display: grid; gap: 8px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-raised); padding: 10px; }
    .remote-access-label { color: var(--muted-2); font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
    .remote-access-form { display: grid; gap: 7px; }
    .remote-token-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
    .sidebar-scroll { min-height: 0; flex: 1; overflow-y: auto; padding: 18px 0 12px; }
    .sidebar-section-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 8px 7px; color: var(--muted-2); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
    .sidebar-repositories, .sidebar-reviews { display: grid; gap: 2px; }
    .sidebar-reviews { padding-bottom: 8px; }
    .sidebar-recents-collapsed .sidebar-reviews { display: none; }
    .repository-nav-item { position: relative; display: grid; grid-template-columns: 18px minmax(0,1fr) 8px; align-items: center; gap: 8px; width: 100%; min-height: 48px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); padding: 7px 9px; text-align: left; transition: background .15s ease, color .15s ease; }
    .repository-nav-item.is-stale { opacity: .62; }
    .sidebar-section-button { width: 100%; border: 0; background: transparent; color: inherit; padding: 0; text-align: left; }
    .sidebar-section-button:hover { color: var(--foreground); }
    .sidebar-section-chevron { display: inline-grid; width: 16px; height: 16px; place-items: center; color: var(--muted-2); font-size: 13px; transition: transform .15s ease; }
    .sidebar-recents-collapsed .sidebar-section-chevron { transform: rotate(-90deg); }
    .repository-nav-item:hover { background: var(--sidebar-hover); color: var(--foreground); }
    .repository-nav-item.selected { background: var(--sidebar-active); color: var(--foreground); box-shadow: inset 0 0 0 1px var(--border); }
    .repository-active-accent { position: absolute; left: 0; top: 50%; width: 3px; height: 22px; transform: translateY(-50%); border-radius: 0 4px 4px 0; background: var(--primary); opacity: 0; }
    .repository-nav-item.selected .repository-active-accent { opacity: 1; }
    .repository-icon { color: var(--muted-2); font-size: 16px; }
    .repository-nav-copy { min-width: 0; }
    .repository-nav-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 600; }
    .repository-nav-meta { display: block; margin-top: 2px; color: var(--muted-2); font-size: 9.5px; font-weight: 500; }
    .repo-health { display: block; width: 7px; height: 7px; border-radius: 999px; background: var(--muted-2); }
    .repo-health.success { background: var(--success); }
    .repo-health.warning { background: var(--warning); }
    .repo-health.danger { background: var(--danger); }
    .sidebar-footer { flex: 0 0 auto; border-top: 1px solid var(--border-soft); padding-top: 9px; }
    .sidebar-settings { display: flex; width: 100%; align-items: center; gap: 9px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); padding: 9px 10px; text-align: left; font-size: 12px; font-weight: 550; }
    .sidebar-settings:hover { background: var(--sidebar-hover); color: var(--foreground); }
    .workspace-surface { position: relative; display: grid; min-width: 0; min-height: 0; grid-template-rows: minmax(0,1fr); background: var(--background); }
    .notice { position: fixed; z-index: 120; top: 16px; right: 18px; max-width: 520px; border: 1px solid #465263; border-radius: 9px; background: #151d27; box-shadow: 0 12px 32px var(--shadow); color: #dbe6f3; padding: 10px 12px; font-size: 10.5px; line-height: 1.45; }
    .notice.error { border-color: #673c40; background: #271718; color: #ffc4c7; }
    .review-workspace { display: grid; min-width: 0; min-height: 0; grid-template-columns: 326px minmax(0,1fr); }
    .pr-column { min-width: 0; min-height: 0; overflow-y: auto; border-right: 1px solid var(--border); background: #141310; padding: 17px 12px; }
    .column-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 5px 11px; }
    .column-eyebrow { margin: 0 0 5px; color: var(--muted-2); font-size: 9px; font-weight: 650; letter-spacing: .1em; text-transform: uppercase; }
    .column-header h2, .history-heading h3 { margin: 0; font-size: 13px; font-weight: 650; }
    .count-pill { display: inline-flex; min-width: 24px; height: 22px; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--muted); padding: 0 7px; font-size: 9.5px; font-weight: 650; }
    .pr-list { display: grid; gap: 3px; }
    .pr-nav-item { display: grid; gap: 6px; width: 100%; border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--foreground); padding: 10px; text-align: left; transition: background .15s ease, border-color .15s ease; }
    .pr-nav-item:hover { background: #211f1b; }
    .pr-nav-item.selected { border-color: var(--border); background: var(--sidebar-active); }
    .pr-nav-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .pr-number { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 9.5px; }
    .pr-nav-title { display: -webkit-box; overflow: hidden; color: #eeeae4; font-size: 11.5px; font-weight: 600; line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .pr-nav-meta { overflow: hidden; color: var(--muted-2); font-size: 9.5px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
    .review-detail { min-width: 0; min-height: 0; overflow-y: auto; background: var(--background); }
    .pr-detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; border-bottom: 1px solid var(--border); padding: 24px 28px 22px; }
    .pr-detail-title-group { min-width: 0; }
    .mono-label { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 10px; }
    .pr-detail-header h2 { margin: 0; max-width: 850px; font-size: 20px; font-weight: 650; line-height: 1.3; letter-spacing: -.02em; }
    .pr-detail-meta { margin: 8px 0 0; color: var(--muted); font-size: 10.5px; }
    .workspace-actions, .button-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .history-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 22px 28px 10px; }
    .review-list { display: grid; gap: 10px; padding: 0 28px 36px; }
    .review-item, .panel-card { border: 1px solid var(--border); border-radius: 11px; background: var(--surface); padding: 14px; }
    .review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .review-title { color: #e9e5de; font-size: 11.5px; font-weight: 650; }
    .review-meta { margin-top: 4px; color: var(--muted-2); font-size: 9.5px; line-height: 1.45; }
    .review-body { display: grid; gap: 11px; margin-top: 12px; }
    .review-summary { color: #d4cfc7; font-size: 11px; line-height: 1.58; white-space: pre-wrap; }
    .review-error { color: var(--danger); font-size: 10.5px; line-height: 1.5; white-space: pre-wrap; }
    .review-activity { overflow: hidden; border: 1px solid var(--border-soft); border-radius: 9px; background: #12110f; }
    .review-activity-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--border-soft); padding: 8px 10px; }
    .review-activity-title { color: #d9d4cc; font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .review-activity-count { color: var(--muted-2); font-size: 8.5px; }
    .review-activity-log { display: grid; max-height: 260px; overflow: auto; padding: 5px 0; }
    .review-activity-row { display: grid; grid-template-columns: 8px minmax(0,1fr); gap: 7px; padding: 5px 10px; }
    .review-activity-row + .review-activity-row { border-top: 1px solid rgba(255,255,255,.025); }
    .review-activity-dot { width: 5px; height: 5px; margin-top: 5px; border-radius: 999px; background: var(--muted-2); }
    .review-activity-row.state .review-activity-dot { background: var(--info); }
    .review-activity-copy { min-width: 0; }
    .review-activity-message { overflow-wrap: anywhere; color: #bdb7ae; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 9.5px; line-height: 1.5; white-space: pre-wrap; }
    .review-activity-meta { margin-top: 2px; color: var(--muted-2); font-size: 8px; }
    .overview-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; padding: 0 28px 36px; }
    .panel-card h3 { margin: 0 0 8px; font-size: 12px; }
    .panel-card p { margin: 0 0 10px; color: var(--muted); font-size: 10.5px; line-height: 1.5; }
    .connection-list { display: grid; gap: 0; overflow: hidden; border: 1px solid var(--border-soft); border-radius: 9px; background: #12110f; }
    .connection-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px; }
    .connection-item + .connection-item { border-top: 1px solid var(--border-soft); }
    .connection-copy strong { display: block; font-size: 10.5px; }
    .connection-copy span { display: block; margin-top: 3px; overflow-wrap: anywhere; color: var(--muted); font-size: 9.5px; line-height: 1.45; }
    .button { min-height: 32px; border: 1px solid #e4dfd7; border-radius: 8px; background: #ece8e1; color: #171513; padding: 7px 11px; font-size: 10.5px; font-weight: 700; text-decoration: none; }
    .button:hover { background: #fff; }
    .button.secondary { border-color: var(--border); background: var(--surface-raised); color: #ded9d1; }
    .button.secondary:hover { background: var(--sidebar-hover); }
    .button.danger { border-color: #60383b; background: transparent; color: var(--danger); }
    .button.danger:hover { background: #271718; }
    .badge { display: inline-flex; min-height: 19px; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; font-size: 8.5px; font-weight: 750; white-space: nowrap; }
    .badge.success { border-color: #315a42; background: #14271c; color: var(--success); }
    .badge.warning { border-color: #62502b; background: #251f12; color: var(--warning); }
    .badge.danger { border-color: #62383b; background: #271718; color: var(--danger); }
    .badge.info { border-color: #364e6c; background: #151d28; color: var(--info); }
    input, select { width: 100%; min-height: 34px; border: 1px solid var(--border); border-radius: 8px; outline: none; background: #141310; color: var(--foreground); padding: 7px 9px; font-size: 10.5px; }
    input:focus, select:focus { border-color: #6e685e; box-shadow: 0 0 0 2px rgba(255,255,255,.035); }
    .setting-grid { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
    .remote-settings-list { display: grid; gap: 0; overflow: hidden; border: 1px solid var(--border-soft); border-radius: 9px; background: #12110f; }
    .remote-toggle { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px; cursor: pointer; }
    .remote-toggle + .remote-toggle { border-top: 1px solid var(--border-soft); }
    .remote-toggle-copy strong { display: block; font-size: 10.5px; }
    .remote-toggle-copy span { display: block; margin-top: 3px; color: var(--muted); font-size: 9.5px; line-height: 1.45; }
    .remote-toggle input[type="checkbox"] { width: 16px; min-height: 16px; height: 16px; flex: 0 0 auto; accent-color: #e7e1d7; }
    .remote-setting-fields { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 8px; margin-top: 10px; }
    .remote-field { display: grid; gap: 5px; color: var(--muted); font-size: 9px; }
    .remote-config-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
    .empty { color: var(--muted); padding: 16px 8px; font-size: 10.5px; line-height: 1.5; }
    a { color: #8ab4ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 1120px) { .desktop-shell { grid-template-columns: 224px minmax(0,1fr); } .review-workspace { grid-template-columns: 286px minmax(0,1fr); } .overview-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="desktop-shell">
    <aside class="app-sidebar" aria-label="Remote administration navigation">
      <div class="brand-row">
        <div class="brand-mark" aria-hidden="true">CR</div>
        <div class="brand-copy"><strong>ChatGPT Review</strong><span>Remote admin</span></div>
      </div>
      <section class="remote-access">
        <div class="remote-access-label">Access</div>
        <form id="tokenForm" class="remote-access-form" method="get" action="/admin/">
          <div class="remote-token-row">
            <input id="token" name="token" type="password" placeholder="Remote token" autocomplete="current-password" />
            <button class="button" id="save-token" type="submit">Save</button>
          </div>
          <button id="reload" class="button secondary" type="button">Reload</button>
        </form>
        <div id="auth-message" class="repository-nav-meta">Read token from the VPS remote-admin-token file.</div>
      </section>
      <nav class="sidebar-scroll" aria-label="Repositories">
        <div class="sidebar-section-heading"><span>Repositories</span><span id="repoCount">0</span></div>
        <div id="repositories" class="sidebar-repositories"></div>
        <button id="recentToggle" class="sidebar-section-heading sidebar-section-button" style="margin-top:18px" data-action="toggle-recent" type="button"><span>Recent</span><span><span id="reviewCount">0</span><span class="sidebar-section-chevron" aria-hidden="true">⌄</span></span></button>
        <div id="sidebarReviews" class="sidebar-reviews"></div>
      </nav>
      <div class="sidebar-footer">
        <button class="sidebar-settings" data-action="show-overview" type="button"><span aria-hidden="true">⚙</span><span>Workspace</span></button>
      </div>
    </aside>
    <main class="workspace-surface">
      <section id="notice" class="notice hidden" role="status"></section>
      <div class="review-workspace">
        <section class="pr-column" aria-label="Open pull requests">
          <div class="column-header">
            <div><p class="column-eyebrow">OPEN</p><h2>Pull requests</h2></div>
            <span id="prCount" class="count-pill">0</span>
          </div>
          <div id="prs" class="pr-list"></div>
        </section>
        <section id="detail" class="review-detail" aria-label="Remote admin detail"></section>
      </div>
    </main>
  </div>
<script>
const BOOTSTRAP_VIEW = ${safeScriptJson(initialView)};
const BOOTSTRAP_ERROR = ${safeScriptJson(initialError)};
const state = { view: null, busy: false, selectedRepo: '', selectedPr: 0, showOverview: true, recentCollapsed: false, lastViewJson: '' };
window.addEventListener('error', (event) => showFatal(event.message || String(event.error || 'Unknown script error')));
window.addEventListener('unhandledrejection', (event) => showFatal(event.reason && event.reason.message ? event.reason.message : String(event.reason || 'Unhandled promise rejection')));
const tokenInput = document.getElementById('token');
const initialToken = new URLSearchParams(location.search).get('token') || localStorage.getItem('chatgpt-review-admin-token') || '';
tokenInput.value = initialToken;
if (initialToken) localStorage.setItem('chatgpt-review-admin-token', initialToken);
let bootstrapConsumed = false;

document.getElementById('tokenForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return setAuthMessage('Paste the remote admin token first.', false);
  localStorage.setItem('chatgpt-review-admin-token', token);
  location.href = '/admin/?token=' + encodeURIComponent(token) + '&v=' + Date.now();
});
document.getElementById('reload').addEventListener('click', () => { bootstrapConsumed = true; void load(true, { silent: false, forceRender: true }); });
document.addEventListener('click', (event) => {
  const element = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!element) return;
  const action = element.getAttribute('data-action') || '';
  const repository = element.getAttribute('data-repository') || '';
  const prNumber = Number(element.getAttribute('data-pr-number') || '0');
  try {
    if (action === 'select-repo') {
      state.selectedRepo = repository;
      state.showOverview = false;
      const firstPr = prsForRepo(repository)[0];
      state.selectedPr = firstPr ? firstPr.number : 0;
      render();
    } else if (action === 'select-pr') {
      state.selectedRepo = repository;
      state.selectedPr = prNumber;
      state.showOverview = false;
      render();
    } else if (action === 'show-overview') {
      state.showOverview = true;
      render();
    } else if (action === 'toggle-recent') {
      state.recentCollapsed = !state.recentCollapsed;
      renderSidebar();
    } else if (action === 'refresh-prs') {
      void post('/admin/api/prs/refresh', { repository: repository || undefined });
    } else if (action === 'sync-webhook') {
      void post('/admin/api/repositories/sync-webhook', { repository: repository || repoInputValue() });
    } else if (action === 'link-repo') {
      void post('/admin/api/repositories/link', { repository: repoInputValue() });
    } else if (action === 'unlink-repo') {
      void post('/admin/api/repositories/unlink', { repository: repository || repoInputValue() });
    } else if (action === 'run-review') {
      void post('/admin/api/reviews/run', { repository, prNumber, force: element.getAttribute('data-force') === 'true' });
    } else if (action === 'cancel-review') {
      void post('/admin/api/reviews/cancel', { reviewId: element.getAttribute('data-review-id') || '' });
    } else if (action === 'github-auth') {
      void post('/admin/api/github/auth', { token: inputValue('github-token') });
    } else if (action === 'chatgpt-setup') {
      void post('/admin/api/chatgpt/setup', {});
    } else if (action === 'cloudflare-restart') {
      void post('/admin/api/cloudflare/restart', {});
    } else if (action === 'save-config') {
      void saveRemoteConfig().catch(() => undefined);
    } else if (action === 'build-app') {
      void buildApp();
    }
  } catch (error) {
    alert(error.message || String(error));
  }
});
function adminToken() { return (localStorage.getItem('chatgpt-review-admin-token') || tokenInput.value || '').trim(); }
function inputValue(id) { const node = document.getElementById(id); return node && 'value' in node ? String(node.value).trim() : ''; }
function repoInputValue() { const repo = inputValue('repoInput'); if (!repo) throw new Error('Repository is required.'); return repo; }
function checkboxValue(id) { const node = document.getElementById(id); return Boolean(node && 'checked' in node && node.checked); }
async function saveRemoteConfig() {
  await post('/admin/api/config/update', {
    autoReview: checkboxValue('remote-auto-review'),
    postComment: checkboxValue('remote-post-comment'),
    reviewDrafts: checkboxValue('remote-review-drafts'),
    requireJiraWhenKeyPresent: checkboxValue('remote-require-jira'),
    maxDiffChunkBytes: Number(inputValue('remote-max-diff')),
    webhookListenHost: inputValue('remote-webhook-host'),
    webhookListenPort: Number(inputValue('remote-webhook-port')),
  });
  showNotice('Settings saved and synchronized with the desktop app.', false);
}
function withToken(path) { const token = adminToken(); if (!token) return path; return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token); }
function authHeaders() { return { authorization: 'Bearer ' + adminToken(), 'content-type': 'application/json' }; }
async function api(path, options) {
  const response = await fetch(withToken(path), Object.assign({}, options || {}, { headers: Object.assign({}, authHeaders(), (options && options.headers) || {}) }));
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = { error: text || 'Invalid JSON response' }; }
  if (!response.ok) throw new Error((payload && payload.error) || 'HTTP ' + response.status);
  return payload;
}
async function post(path, body, refresh) {
  try {
    setBusy(true);
    const payload = await api(path, { method: 'POST', body: JSON.stringify(body || {}) });
    if (refresh !== false) await load(true, { silent: false, forceRender: true });
    return payload;
  } catch (error) {
    showNotice(error.message || String(error), true);
    throw error;
  } finally {
    setBusy(false);
  }
}
async function buildApp() {
  const result = await post('/admin/api/system/build', {}, false);
  showNotice((result && result.output) || 'Build finished.', !(result && result.ok));
  await load(true, { silent: false, forceRender: true });
}
async function load(forceApi, options) {
  const silent = options && options.silent === true;
  const forceRender = options && options.forceRender === true;
  try {
    if (!silent) setBusy(true);
    if (BOOTSTRAP_ERROR && !bootstrapConsumed && !forceApi) {
      bootstrapConsumed = true;
      setAuthMessage(BOOTSTRAP_ERROR, false);
      return renderShellEmpty(BOOTSTRAP_ERROR);
    }
    if (BOOTSTRAP_VIEW && !bootstrapConsumed && !forceApi) {
      state.view = BOOTSTRAP_VIEW;
      state.lastViewJson = JSON.stringify(BOOTSTRAP_VIEW);
      bootstrapConsumed = true;
      setAuthMessage(viewSummary(state.view), true);
      ensureSelection();
      render();
      return;
    }
    bootstrapConsumed = true;
    if (!adminToken()) {
      setAuthMessage('Paste the remote admin token, then Save.', false);
      return renderShellEmpty('Waiting for remote admin token.');
    }
    const nextView = await api('/admin/api/view');
    const nextViewJson = JSON.stringify(nextView);
    const changed = nextViewJson !== state.lastViewJson;
    state.view = nextView;
    state.lastViewJson = nextViewJson;
    setAuthMessage(viewSummary(state.view), true);
    ensureSelection();
    if (!silent || forceRender || changed) render();
  } catch (error) {
    const message = error.message || String(error);
    if (!silent) {
      setAuthMessage(message, false);
      renderShellEmpty(message);
    }
  } finally {
    if (!silent) setBusy(false);
  }
}
function setBusy(value) { state.busy = value; document.querySelectorAll('button').forEach((button) => { button.disabled = value; }); }
function setHtmlIfChanged(id, html) { const node = document.getElementById(id); if (node && node.innerHTML !== html) node.innerHTML = html; }
function setTextIfChanged(id, value) { const node = document.getElementById(id); const text = String(value); if (node && node.textContent !== text) node.textContent = text; }
function setAuthMessage(message, ok) { setHtmlIfChanged('auth-message', '<span class="' + (ok ? 'ok' : 'bad') + '">' + escapeHtml(message) + '</span>'); }
function showNotice(message, error) { const node = document.getElementById('notice'); node.className = 'notice' + (error ? ' error' : ''); node.textContent = message; setTimeout(() => { node.classList.add('hidden'); }, 7000); }
function showFatal(message) { setAuthMessage(message, false); renderShellEmpty(message); }
function renderShellEmpty(message) {
  setHtmlIfChanged('repositories', '<div class="empty">' + escapeHtml(message) + '</div>');
  setHtmlIfChanged('prs', '<div class="empty">' + escapeHtml(message) + '</div>');
  setHtmlIfChanged('detail', '<div class="review-list" style="padding-top:28px"><div class="review-item"><div class="review-error">' + escapeHtml(message) + '</div></div></div>');
}
function ensureSelection() {
  const repos = repositories();
  if (!state.selectedRepo && repos[0]) state.selectedRepo = repos[0].fullName;
  if (!state.selectedPr) {
    const firstPr = prsForRepo(state.selectedRepo)[0] || prs()[0];
    if (firstPr) state.selectedPr = firstPr.number;
  }
}
function render() {
  if (!state.view) return;
  renderSidebar();
  renderPrList();
  if (state.showOverview) renderOverview(); else renderPrDetail();
}
function repositories() { return (state.view && state.view.repositories) || []; }
function prs() { return (state.view && state.view.prs) || []; }
function reviews() { return (state.view && state.view.reviews) || []; }
function prsForRepo(repository) { return prs().filter((pr) => !repository || pr.repository === repository); }
function reviewsFor(repository, prNumber) { return reviews().filter((review) => review.repository === repository && Number(review.prNumber) === Number(prNumber)); }
function reviewTimestamp(review) { return review.updatedAt || review.completedAt || review.startedAt || ''; }
function latestReviewGroups() {
  const map = new Map();
  for (const review of reviews()) {
    const key = review.repository + '#' + String(review.prNumber);
    const existing = map.get(key);
    if (!existing || reviewTimestamp(review) > reviewTimestamp(existing)) map.set(key, review);
  }
  return Array.from(map.values()).sort((a, b) => reviewTimestamp(b).localeCompare(reviewTimestamp(a)));
}
function renderSidebar() {
  const repos = repositories();
  const latestReviews = latestReviewGroups();
  setTextIfChanged('repoCount', repos.length);
  setTextIfChanged('reviewCount', latestReviews.length);
  const recentToggle = document.getElementById('recentToggle');
  if (recentToggle) recentToggle.classList.toggle('sidebar-recents-collapsed', state.recentCollapsed);
  const repositoriesHtml = repos.map((repo) => {
    const health = repo.webhook && repo.webhook.status === 'healthy' ? 'success' : repo.enabled ? 'warning' : 'danger';
    const selected = repo.fullName === state.selectedRepo && !state.showOverview;
    const prCount = prsForRepo(repo.fullName).length;
    return '<button class="repository-nav-item ' + (selected ? 'selected' : '') + '" data-action="select-repo" data-repository="' + escapeAttr(repo.fullName) + '" type="button"><span class="repository-active-accent"></span><span class="repository-icon">▱</span><span class="repository-nav-copy"><span class="repository-nav-name">' + escapeHtml(repo.fullName) + '</span><span class="repository-nav-meta">' + prCount + ' open PRs</span></span><span class="repo-health ' + health + '"></span></button>';
  }).join('') || '<div class="empty">No repositories linked.</div>';
  setHtmlIfChanged('repositories', repositoriesHtml);
  const sidebarReviews = document.getElementById('sidebarReviews');
  sidebarReviews.classList.toggle('hidden', state.recentCollapsed);
  const sidebarReviewsHtml = latestReviews.slice(0, 8).map((review) => {
    const selected = review.repository === state.selectedRepo && Number(review.prNumber) === Number(state.selectedPr) && !state.showOverview;
    const currentHead = prs().find((pr) => pr.repository === review.repository && Number(pr.number) === Number(review.prNumber))?.headSha || '';
    const stale = currentHead && review.headSha && currentHead !== review.headSha;
    return '<button class="repository-nav-item ' + (selected ? 'selected ' : '') + (stale ? 'is-stale' : '') + '" data-action="select-pr" data-repository="' + escapeAttr(review.repository) + '" data-pr-number="' + String(review.prNumber) + '" type="button"><span class="repository-active-accent"></span><span class="repository-icon">#</span><span class="repository-nav-copy"><span class="repository-nav-name">PR #' + String(review.prNumber) + ' · ' + escapeHtml(review.phase || review.status) + '</span><span class="repository-nav-meta">' + escapeHtml(review.status || '') + (stale ? ' · stale' : '') + '</span></span><span class="repo-health ' + statusTone(review.status) + '"></span></button>';
  }).join('') || '<div class="empty">No reviews yet.</div>';
  setHtmlIfChanged('sidebarReviews', sidebarReviewsHtml);
}
function renderPrList() {
  const list = prsForRepo(state.selectedRepo);
  setTextIfChanged('prCount', list.length || prs().length);
  const source = list.length ? list : prs();
  const prsHtml = source.map((pr) => {
    const selected = pr.repository === state.selectedRepo && Number(pr.number) === Number(state.selectedPr) && !state.showOverview;
    const latest = reviewsFor(pr.repository, pr.number)[0];
    return '<button class="pr-nav-item ' + (selected ? 'selected' : '') + '" data-action="select-pr" data-repository="' + escapeAttr(pr.repository) + '" data-pr-number="' + String(pr.number) + '" type="button"><span class="pr-nav-top"><span class="pr-number">#' + String(pr.number) + '</span>' + (latest ? badge(latest.status, statusTone(latest.status)) : '<span class="repository-nav-meta">unreviewed</span>') + '</span><span class="pr-nav-title">' + escapeHtml(pr.title) + '</span><span class="pr-nav-meta">' + escapeHtml(pr.headBranch + ' → ' + pr.baseBranch) + ' · ' + String(pr.changedFiles || 0) + ' files</span></button>';
  }).join('') || '<div class="empty">No open PRs loaded.</div>';
  setHtmlIfChanged('prs', prsHtml);
}
function renderOverview() {
  const view = state.view;
  const webhook = view.webhook || {};
  const tunnel = view.tunnel || {};
  const provider = view.provider || {};
  const ocr = view.ocr || {};
  const chatgpt = view.chatgpt || {};
  const config = view.config || {};
  const ingressLocked = Boolean(config.cloudflareHostname);
  const detailHtml = '<header class="pr-detail-header"><div class="pr-detail-title-group"><div class="mono-label">REMOTE ADMIN</div><h2>ChatGPT Review workspace</h2><p class="pr-detail-meta">Manage the VPS worker with the same navigation model as the desktop app.</p></div><div class="workspace-actions"><button class="button secondary" data-action="refresh-prs">Refresh PRs</button><button class="button" data-action="chatgpt-setup">Open ChatGPT setup</button></div></header>'
    + '<div class="history-heading"><div><p class="column-eyebrow">STATUS</p><h3>Connections</h3></div><span class="count-pill">' + String(repositories().length) + '</span></div>'
    + '<div class="overview-grid"><section class="panel-card"><h3>Connection status</h3><div class="connection-list">'
    + connectionRow('GitHub CLI', provider.ghAuthenticated ? 'Ready' : provider.detail || 'Not ready', provider.ghAuthenticated)
    + connectionRow('OpenCodeReview', ocr.installed ? ('v' + (ocr.version || 'unknown')) : (ocr.detail || 'Missing'), Boolean(ocr.installed))
    + connectionRow('ChatGPT Web', chatgpt.ready ? 'Ready' : 'Setup required', chatgpt.ready)
    + connectionRow('Local webhook', webhook.listening ? webhook.localUrl : webhook.lastError || 'Stopped', webhook.listening)
    + connectionRow('Cloudflare tunnel', tunnel.running && tunnel.reachable ? tunnel.publicUrl : tunnel.lastError || 'Not ready', tunnel.running && tunnel.reachable)
    + '</div></section>'
    + '<section class="panel-card"><h3>Repository</h3><p>Link repositories and keep GitHub webhook configuration synchronized.</p><div class="setting-grid"><input id="repoInput" placeholder="owner/repo" value="' + escapeAttr(state.selectedRepo || '') + '" /><button class="button" data-action="link-repo">Link</button></div><div class="button-row" style="margin-top:8px"><button class="button secondary" data-action="sync-webhook">Sync webhook</button><button class="button secondary" data-action="refresh-prs">Refresh PRs</button><button class="button danger" data-action="unlink-repo">Unlink</button></div></section>'
    + '<section class="panel-card"><h3>GitHub setup</h3><p>Paste a GitHub token once. The app passes it to gh auth login --with-token.</p><div class="setting-grid"><input id="github-token" type="password" placeholder="GitHub token" /><button class="button" data-action="github-auth">Authenticate gh</button></div></section>'
    + '<section class="panel-card"><h3>Review settings</h3><p>These values are shared with the desktop Settings screen and take effect for new review runs.</p><div class="remote-settings-list">'
    + remoteToggle('remote-auto-review', 'Auto review', 'Automatically review eligible PR webhook events.', Boolean(config.autoReview))
    + remoteToggle('remote-post-comment', 'Post GitHub review', 'Submit the completed review back to GitHub.', Boolean(config.postComment))
    + remoteToggle('remote-review-drafts', 'Include draft PRs', 'Allow draft pull requests into the automatic review queue.', Boolean(config.reviewDrafts))
    + remoteToggle('remote-require-jira', 'Require Jira mapping', 'Block when a referenced Jira key cannot be resolved.', Boolean(config.requireJiraWhenKeyPresent))
    + '</div><div class="remote-setting-fields"><label class="remote-field"><span>Max diff chunk bytes</span><input id="remote-max-diff" type="number" min="12000" max="90000" step="1000" value="' + escapeAttr(String(config.maxDiffChunkBytes || 42000)) + '" /></label></div><div class="remote-config-actions"><button class="button" data-action="save-config">Save settings</button></div></section>'
    + '<section class="panel-card"><h3>Local webhook ingress</h3><p>' + (ingressLocked ? 'Host and port are locked while the Cloudflare named tunnel is connected.' : 'Configure the local listener used by GitHub webhook ingress.') + '</p><div class="remote-setting-fields"><label class="remote-field"><span>Listen host</span><input id="remote-webhook-host" value="' + escapeAttr(config.webhookListenHost || '127.0.0.1') + '" ' + disabledAttr(ingressLocked) + ' /></label><label class="remote-field"><span>Listen port</span><input id="remote-webhook-port" type="number" min="1024" max="65535" value="' + escapeAttr(String(config.webhookListenPort || 8787)) + '" ' + disabledAttr(ingressLocked) + ' /></label></div><div class="review-meta">Public webhook: ' + escapeHtml(config.webhookPublicUrl || 'Not connected') + '</div></section>'
    + '<section class="panel-card"><h3>Operations</h3><p>Build or restart worker-side services from the browser.</p><div class="button-row"><button class="button secondary" data-action="cloudflare-restart">Restart Cloudflare tunnel</button><button class="button secondary" data-action="build-app">Run npm build</button></div></section></div>';
  setHtmlIfChanged('detail', detailHtml);
}
function renderPrDetail() {
  const pr = prs().find((item) => item.repository === state.selectedRepo && Number(item.number) === Number(state.selectedPr));
  if (!pr) return renderOverview();
  const items = reviewsFor(pr.repository, pr.number);
  const detailHtml = '<header class="pr-detail-header"><div class="pr-detail-title-group"><div class="mono-label">PR #' + String(pr.number) + '</div><h2>' + escapeHtml(pr.title) + '</h2><p class="pr-detail-meta">' + escapeHtml(pr.repository + ' · ' + pr.headBranch + ' → ' + pr.baseBranch + ' · ' + String(pr.changedFiles || 0) + ' changed files') + '</p></div><div class="workspace-actions"><a class="button secondary" href="' + escapeAttr(pr.url) + '" target="_blank">Open PR</a><button class="button" data-action="run-review" data-repository="' + escapeAttr(pr.repository) + '" data-pr-number="' + String(pr.number) + '" data-force="false">Review now</button><button class="button secondary" data-action="run-review" data-repository="' + escapeAttr(pr.repository) + '" data-pr-number="' + String(pr.number) + '" data-force="true">Re-review head</button></div></header><div class="history-heading"><div><p class="column-eyebrow">HISTORY</p><h3>Review runs</h3></div><span class="count-pill">' + String(items.length) + '</span></div><div class="review-list">' + (items.map(renderReview).join('') || '<div class="review-item"><div class="review-summary">No reviews yet.</div></div>') + '</div>';
  setHtmlIfChanged('detail', detailHtml);
}
function renderReview(review) {
  const canCancel = review.status === 'running' || review.status === 'queued';
  const activityMap = state.view && state.view.reviewActivity ? state.view.reviewActivity : {};
  const activity = Array.isArray(activityMap[review.taskId]) ? activityMap[review.taskId] : [];
  const activityHtml = activity.length
    ? renderReviewActivity(activity)
    : '<div class="review-summary">' + (review.status === 'running' ? 'Review is in progress. Waiting for the next activity update…' : 'Review completed or waiting for details.') + '</div>';
  return '<article class="review-item"><div class="review-head"><div><div class="review-title">' + escapeHtml((review.trigger || 'manual') + ' · ' + (review.phase || review.status)) + '</div><div class="review-meta">' + escapeHtml(String(review.headSha || '').slice(0, 12) + ' · ' + (review.startedAt || '')) + '</div></div>' + badge(review.status, statusTone(review.status)) + '</div><div class="review-body"><div class="review-meta">Jira ' + escapeHtml((review.jiraKeys || []).join(', ') || 'none') + ' · ' + escapeHtml(review.jiraStatus || 'pending') + '</div>' + (review.error ? '<div class="review-error">' + escapeHtml(review.error) + '</div>' : activityHtml) + '<div class="button-row">' + (review.conversationUrl ? '<a class="button secondary" href="' + escapeAttr(review.conversationUrl) + '" target="_blank">Open Chat</a>' : '') + (canCancel ? '<button class="button danger" data-action="cancel-review" data-review-id="' + escapeAttr(review.id) + '">Cancel review</button>' : '') + '</div></div></article>';
}
function renderReviewActivity(entries) {
  const rows = entries.slice(-80).map((entry) => {
    const meta = [entry.phase || '', formatActivityTime(entry.at)].filter(Boolean).join(' · ');
    return '<div class="review-activity-row ' + (entry.type === 'state' ? 'state' : 'progress') + '"><span class="review-activity-dot"></span><div class="review-activity-copy"><div class="review-activity-message">' + escapeHtml(entry.message || '') + '</div>' + (meta ? '<div class="review-activity-meta">' + escapeHtml(meta) + '</div>' : '') + '</div></div>';
  }).join('');
  return '<div class="review-activity"><div class="review-activity-head"><span class="review-activity-title">Activity</span><span class="review-activity-count">' + String(entries.length) + ' event(s)</span></div><div class="review-activity-log">' + rows + '</div></div>';
}
function formatActivityTime(value) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function remoteToggle(id, title, detail, checked) { return '<label class="remote-toggle"><span class="remote-toggle-copy"><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(detail) + '</span></span><input id="' + escapeAttr(id) + '" type="checkbox" ' + checkedAttr(checked) + ' /></label>'; }
function checkedAttr(value) { return value ? 'checked' : ''; }
function disabledAttr(value) { return value ? 'disabled' : ''; }
function connectionRow(label, detail, ok) { return '<div class="connection-item"><span class="connection-copy"><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(detail || '') + '</span></span>' + badge(ok ? 'ready' : 'attention', ok ? 'success' : 'danger') + '</div>'; }
function badge(text, tone) { return '<span class="badge ' + (tone || '') + '">' + escapeHtml(text || '') + '</span>'; }
function statusTone(status) { if (status === 'completed') return 'success'; if (status === 'running' || status === 'queued') return 'info'; if (status === 'failed' || status === 'blocked') return 'danger'; if (status === 'cancelled') return 'warning'; return 'warning'; }
function viewSummary(view) { return 'Token accepted. Loaded ' + ((view.repositories || []).length) + ' repo(s), ' + ((view.prs || []).length) + ' PR(s), ' + ((view.reviews || []).length) + ' review(s).'; }
function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch])); }
function escapeAttr(value) { return escapeHtml(value).replace(/\`/g, '&#096;'); }
void load(false, { silent: false, forceRender: true });
setInterval(() => {
  if (!state.busy && document.visibilityState === 'visible') {
    void load(true, { silent: true });
  }
}, 5000);
</script>
</body>
</html>`;
}
