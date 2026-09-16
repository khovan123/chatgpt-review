import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { StateStore } from "./state-store";
import type { WebhookDeliveryRecord, WebhookRuntimeStatus } from "./types";

export const WEBHOOK_PATH = "/webhooks/v1/github";
export const WEBHOOK_HEALTH_PATH = "/healthz";
const MAX_BODY_BYTES = 256 * 1024;

export interface GitHubWebhookEvent {
  deliveryId: string;
  event: string;
  action: string;
  repository: string;
  prNumber: number | null;
  headSha: string | null;
}

export class WebhookSecretStore {
  constructor(private readonly filePath: string) {}

  async loadOrCreate(): Promise<string> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const existing = (await readFile(this.filePath, "utf8")).trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) return existing.toLowerCase();
      throw new Error("Stored webhook secret is invalid.");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw error;
      const secret = randomBytes(32).toString("hex");
      await writeFile(this.filePath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
      return secret;
    }
  }
}

export class GitHubWebhookServer {
  private server: Server | null = null;
  private runtime: WebhookRuntimeStatus = { listening: false, localUrl: "", publicUrl: "" };

  constructor(private readonly dependencies: {
    state: StateStore;
    secret: string;
    onEvent: (event: GitHubWebhookEvent) => Promise<void>;
    onProgress?: (message: string) => void;
  }) {}

  status(): WebhookRuntimeStatus {
    return { ...this.runtime };
  }

  async start(input: { host: string; port: number; publicUrl: string }): Promise<WebhookRuntimeStatus> {
    await this.stop();
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.dependencies.onProgress?.(`Webhook ingress failed: ${safeError(error)}`);
        if (!response.headersSent) writeJson(response, 500, { error: "webhook ingress failed" });
        else response.destroy();
      });
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(input.port, input.host);
      });
      const displayHost = input.host === "0.0.0.0" || input.host === "::" ? "127.0.0.1" : input.host;
      this.runtime = {
        listening: true,
        localUrl: `http://${displayHost}:${input.port}${WEBHOOK_PATH}`,
        publicUrl: input.publicUrl,
      };
    } catch (error) {
      this.server = null;
      this.runtime = {
        listening: false,
        localUrl: "",
        publicUrl: input.publicUrl,
        lastError: safeError(error),
      };
      throw error;
    }
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.runtime = { ...this.runtime, listening: false };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && requestUrl.pathname === WEBHOOK_HEALTH_PATH) {
      writeJson(response, 200, { status: "ok", service: "chatgpt-review-webhook" });
      return;
    }

    if (request.method !== "POST" || requestUrl.pathname !== WEBHOOK_PATH) {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    const deliveryId = boundedHeader(request, "x-github-delivery", 256);
    const event = boundedHeader(request, "x-github-event", 64);
    const signature = boundedHeader(request, "x-hub-signature-256", 128);
    if (!deliveryId || !event || !signature) {
      writeJson(response, 400, { error: "missing required GitHub webhook headers" });
      return;
    }

    let body: Buffer;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      if (safeError(error).includes("exceeds 256 KiB")) {
        writeJson(response, 413, { error: "GitHub webhook body exceeds 256 KiB" });
        return;
      }
      throw error;
    }
    if (!verifyGitHubSignature(signature, body, this.dependencies.secret)) {
      writeJson(response, 401, { error: "invalid GitHub webhook signature" });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      writeJson(response, 400, { error: "invalid GitHub webhook JSON body" });
      return;
    }
    if (!isRecord(payload)) {
      writeJson(response, 400, { error: "invalid GitHub webhook payload" });
      return;
    }

    const repository = readRepository(payload);
    if (!repository) {
      writeJson(response, 400, { error: "missing repository.full_name" });
      return;
    }
    const linked = this.dependencies.state.getRepository(repository);
    if (!linked || !linked.enabled) {
      writeJson(response, 404, { error: "repository is not linked" });
      return;
    }

    const observation = parseObservation(deliveryId, event, repository, payload);
    const receivedAt = new Date().toISOString();
    const delivery: WebhookDeliveryRecord = {
      deliveryId,
      payloadSha256: createHash("sha256").update(body).digest("hex"),
      repository,
      event,
      action: observation.action,
      prNumber: observation.prNumber,
      headSha: observation.headSha,
      receivedAt,
    };

    let disposition: "created" | "replayed";
    try {
      disposition = await this.dependencies.state.recordWebhookDelivery(delivery);
    } catch (error) {
      writeJson(response, 409, { error: safeError(error) });
      return;
    }

    await this.dependencies.state.updateRepositoryWebhook(repository, {
      status: "healthy",
      lastDeliveryAt: receivedAt,
      lastEvent: `${event}:${observation.action}`,
      lastError: undefined,
    });

    if (disposition === "replayed") {
      writeJson(response, 200, { accepted: true, replayed: true });
      return;
    }

    writeJson(response, 202, { accepted: true, replayed: false });
    void this.dependencies.onEvent(observation).catch(async (error) => {
      const detail = safeError(error);
      this.dependencies.onProgress?.(`Webhook event ${event}:${observation.action} for ${repository} failed: ${detail}`);
      await this.dependencies.state.updateRepositoryWebhook(repository, { lastError: detail }).catch(() => undefined);
    });
  }
}

export function verifyGitHubSignature(signature: string, body: Buffer, secret: string): boolean {
  const encoded = signature.startsWith("sha256=") ? signature.slice(7) : "";
  if (!/^[a-f0-9]{64}$/i.test(encoded)) return false;
  const supplied = Buffer.from(encoded, "hex");
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function shouldTriggerPullRequestReview(action: string): boolean {
  return action === "opened"
    || action === "reopened"
    || action === "synchronize"
    || action === "ready_for_review"
    || action === "edited";
}

function parseObservation(deliveryId: string, event: string, repository: string, payload: Record<string, any>): GitHubWebhookEvent {
  const action = typeof payload.action === "string" ? payload.action.slice(0, 128) : event === "ping" ? "ping" : "unknown";
  if (event !== "pull_request") {
    return { deliveryId, event, action, repository, prNumber: null, headSha: null };
  }
  const pull = isRecord(payload.pull_request) ? payload.pull_request : {};
  const number = Number.isSafeInteger(payload.number) && Number(payload.number) > 0 ? Number(payload.number) : null;
  const head = isRecord(pull.head) ? pull.head : {};
  const sha = typeof head.sha === "string" && /^[a-f0-9]{40}$/i.test(head.sha) ? head.sha.toLowerCase() : null;
  return { deliveryId, event, action, repository, prNumber: number, headSha: sha };
}

function readRepository(payload: Record<string, any>): string | null {
  const repository = isRecord(payload.repository) ? payload.repository : {};
  const fullName = typeof repository.full_name === "string" ? repository.full_name.trim() : "";
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) ? fullName : null;
}

function boundedHeader(request: IncomingMessage, name: string, maxLength: number): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return "";
  return value;
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new Error("GitHub webhook body exceeds 256 KiB.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("GitHub webhook body exceeds 256 KiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function writeJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  response.end(body);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.replace(/[\r\n]+/g, " ").slice(0, 2000) : "unknown webhook error";
}
