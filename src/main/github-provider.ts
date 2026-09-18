import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { PullRequestSummary } from "./types";

const execFileAsync = promisify(execFile);
const MAX_STDOUT = 16 * 1024 * 1024;

export interface GitHubWebhookRegistration {
  hookId: number;
  targetUrl: string;
  active: boolean;
}

export class GitHubProvider {
  async authenticateWithToken(token: string): Promise<void> {
    const normalized = token.trim();
    if (normalized.length < 20 || normalized.length > 4096 || /[\r\n]/.test(normalized)) {
      throw new Error("GitHub token is invalid.");
    }
    await runGhWithStdin(["auth", "login", "--hostname", "github.com", "--with-token"], `${normalized}\n`);
  }

  async status(): Promise<{ ghInstalled: boolean; ghAuthenticated: boolean; detail: string }> {
    try {
      await runGh(["--version"]);
    } catch {
      return { ghInstalled: false, ghAuthenticated: false, detail: "GitHub CLI (gh) is not installed." };
    }
    try {
      await runGh(["auth", "status"]);
      return { ghInstalled: true, ghAuthenticated: true, detail: "GitHub CLI is authenticated." };
    } catch (error) {
      return { ghInstalled: true, ghAuthenticated: false, detail: safeError(error) };
    }
  }

  async validateRepository(repository: string): Promise<{ fullName: string; url: string }> {
    const normalizedRepository = normalizeGitHubRepositoryInput(repository);
    const raw = await runGh(["repo", "view", normalizedRepository, "--json", "nameWithOwner,url"]);
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error("GitHub CLI returned an invalid repository object.");
    const fullName = requiredText(parsed.nameWithOwner, "repository name", 512);
    assertRepository(fullName);
    return { fullName, url: requiredHttps(parsed.url) };
  }

  async listOpenPullRequests(repository: string): Promise<PullRequestSummary[]> {
    assertRepository(repository);
    const raw = await runGh([
      "pr", "list", "-R", repository, "--state", "open", "--limit", "100",
      "--json", "number,title,body,url,headRefOid,headRefName,baseRefName,isDraft,state,author,files",
    ]);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("GitHub CLI returned an invalid pull request list.");
    return parsed.map((value) => parsePullRequest(repository, value));
  }

  async getPullRequest(repository: string, prNumber: number): Promise<PullRequestSummary> {
    assertRepository(repository);
    assertPrNumber(prNumber);
    const raw = await runGh([
      "pr", "view", String(prNumber), "-R", repository,
      "--json", "number,title,body,url,headRefOid,headRefName,baseRefName,isDraft,state,author,files",
    ]);
    return parsePullRequest(repository, JSON.parse(raw));
  }

  async getPullRequestDiff(repository: string, prNumber: number): Promise<string> {
    assertRepository(repository);
    assertPrNumber(prNumber);
    return runGh(["pr", "diff", String(prNumber), "-R", repository, "--patch"], MAX_STDOUT);
  }

  async postComment(repository: string, prNumber: number, body: string): Promise<void> {
    assertRepository(repository);
    assertPrNumber(prNumber);
    if (!body.trim()) throw new Error("Review comment is empty.");
    if (Buffer.byteLength(body, "utf8") > 60_000) throw new Error("Review comment exceeds the bounded GitHub comment size.");
    await runGh(["pr", "comment", String(prNumber), "-R", repository, "--body", body], 256 * 1024);
  }

  async ensureWebhook(repository: string, targetUrl: string, secret: string, knownHookId?: number | null): Promise<GitHubWebhookRegistration> {
    assertRepository(repository);
    assertWebhookTarget(targetUrl);
    if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error("Webhook secret is invalid.");

    const hooks = await this.listWebhooks(repository);
    const existing = hooks.find((hook) => knownHookId && hook.id === knownHookId)
      ?? hooks.find((hook) => hook.url === targetUrl);
    const payload = {
      name: "web",
      active: true,
      events: ["pull_request"],
      config: {
        url: targetUrl,
        content_type: "json",
        secret,
        insecure_ssl: "0",
      },
    };

    const raw = existing
      ? await runGhJson("PATCH", `repos/${repository}/hooks/${existing.id}`, payload)
      : await runGhJson("POST", `repos/${repository}/hooks`, payload);
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Number.isSafeInteger(parsed.id) || Number(parsed.id) < 1) throw new Error("GitHub returned an invalid webhook registration.");
    const config = isRecord(parsed.config) ? parsed.config : {};
    const url = typeof config.url === "string" ? config.url : targetUrl;
    return { hookId: Number(parsed.id), targetUrl: url, active: parsed.active !== false };
  }

  async deleteWebhook(repository: string, hookId: number): Promise<void> {
    assertRepository(repository);
    if (!Number.isSafeInteger(hookId) || hookId < 1) throw new Error("Webhook id is invalid.");
    await runGh(["api", "-X", "DELETE", `repos/${repository}/hooks/${hookId}`], 256 * 1024);
  }

  private async listWebhooks(repository: string): Promise<Array<{ id: number; url: string }>> {
    const raw = await runGh(["api", `repos/${repository}/hooks?per_page=100`], 2 * 1024 * 1024);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("GitHub returned an invalid webhook list.");
    return parsed.flatMap((value) => {
      if (!isRecord(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1) return [];
      const config = isRecord(value.config) ? value.config : {};
      const url = typeof config.url === "string" ? config.url : "";
      return [{ id: Number(value.id), url }];
    });
  }
}

async function runGh(args: string[], maxBuffer = 2 * 1024 * 1024): Promise<string> {
  try {
    const result = await execFileAsync("gh", args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer,
      env: ghEnvironment(),
    });
    return result.stdout;
  } catch (error) {
    throw new Error(`GitHub CLI failed: ${safeError(error)}`);
  }
}


async function runGhWithStdin(args: string[], input: string, maxBuffer = 2 * 1024 * 1024): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("gh", args, {
      env: ghEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("GitHub CLI authentication timed out."));
    }, 120_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 256 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`GitHub CLI failed: ${safeError(error)}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8").replace(/[\r\n]+/g, " ").trim();
      if (code === 0) resolve(out);
      else reject(new Error(`GitHub CLI failed: ${err || `exit ${code ?? "unknown"}`}`));
    });
    child.stdin.end(input);
  });
}

async function runGhJson(method: "POST" | "PATCH", endpoint: string, payload: unknown): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("gh", ["api", "-X", method, endpoint, "--input", "-"], {
      env: ghEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("GitHub CLI webhook request timed out."));
    }, 120_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 2 * 1024 * 1024) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 256 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`GitHub CLI failed: ${safeError(error)}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8").replace(/[\r\n]+/g, " ").trim();
      if (code === 0) resolve(out);
      else reject(new Error(`GitHub CLI failed: ${err || `exit ${code ?? "unknown"}`}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function ghEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GH_HOST: process.env.GH_HOST,
  };
}

function parsePullRequest(repository: string, value: unknown): PullRequestSummary {
  if (!isRecord(value)) throw new Error("GitHub CLI returned an invalid pull request object.");
  const author = isRecord(value.author) && typeof value.author.login === "string" ? value.author.login : "unknown";
  const files = Array.isArray(value.files) ? value.files.length : 0;
  return {
    repository,
    number: requiredInteger(value.number, "pull request number"),
    title: requiredText(value.title, "pull request title", 2048),
    body: optionalText(value.body, 100_000),
    url: requiredHttps(value.url),
    headSha: requiredSha(value.headRefOid),
    headBranch: requiredText(value.headRefName, "head branch", 512),
    baseBranch: requiredText(value.baseRefName, "base branch", 512),
    isDraft: value.isDraft === true,
    state: typeof value.state === "string" ? value.state : "UNKNOWN",
    author,
    changedFiles: files,
  };
}

export function normalizeGitHubRepositoryInput(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("Repository is required.");

  const direct = normalizeRepositoryName(input);
  if (direct) return direct;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Repository must be owner/name or an HTTPS github.com repository URL.");
  }

  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "github.com"
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("Repository must be owner/name or an HTTPS github.com repository URL.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("GitHub repository URL must point directly to https://github.com/owner/repository.");
  }
  const repository = segments[1].toLowerCase().endsWith(".git") ? segments[1].slice(0, -4) : segments[1];
  const normalized = normalizeRepositoryName(`${segments[0]}/${repository}`);
  if (!normalized) throw new Error("GitHub repository URL contains an invalid owner or repository name.");
  return normalized;
}

function normalizeRepositoryName(value: string): string | null {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : null;
}

function assertRepository(repository: string): void {
  if (!normalizeRepositoryName(repository)) throw new Error("Repository must use owner/name format.");
}

function assertWebhookTarget(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Webhook public URL must be an HTTPS URL without embedded credentials.");
}

function assertPrNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Pull request number is invalid.");
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} is invalid.`);
  return Number(value);
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} is invalid.`);
  return value;
}

function optionalText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function requiredSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) throw new Error("Pull request head SHA is invalid.");
  return value.toLowerCase();
}

function requiredHttps(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub URL is invalid.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("GitHub URL must be an HTTPS github.com URL.");
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.replace(/[\r\n]+/g, " ").slice(0, 2000);
  return "unknown error";
}
