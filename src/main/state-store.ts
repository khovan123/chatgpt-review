import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_CONFIG,
  type CloudflareProvisioningRecord,
  type PersistedState,
  type RepositoryRecord,
  type ReviewConfig,
  type ReviewRecord,
  type WebhookDeliveryRecord,
} from "./types";

export class StateStore {
  private state: PersistedState = {
    version: 4,
    config: { ...DEFAULT_CONFIG },
    cloudflareProvisioning: null,
    repositories: [],
    reviews: [],
    webhookDeliveries: [],
  };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.state = migrateState(parsed);
      await this.flush();
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw error;
      await this.flush();
    }
  }

  getConfig(): ReviewConfig {
    return { ...this.state.config };
  }

  async setConfig(next: Partial<ReviewConfig>): Promise<ReviewConfig> {
    this.state.config = sanitizeConfig({ ...this.state.config, ...next });
    await this.flush();
    return this.getConfig();
  }

  getCloudflareProvisioning(): CloudflareProvisioningRecord | null {
    return this.state.cloudflareProvisioning ? structuredClone(this.state.cloudflareProvisioning) : null;
  }

  async setCloudflareProvisioning(record: CloudflareProvisioningRecord | null): Promise<CloudflareProvisioningRecord | null> {
    this.state.cloudflareProvisioning = record ? sanitizeCloudflareProvisioning(record) : null;
    await this.flush();
    return this.getCloudflareProvisioning();
  }

  listRepositories(): RepositoryRecord[] {
    return this.state.repositories.map((repository) => structuredClone(repository));
  }

  getRepository(fullName: string): RepositoryRecord | undefined {
    const normalized = normalizeRepository(fullName);
    const found = this.state.repositories.find((repository) => repository.fullName.toLowerCase() === normalized.toLowerCase());
    return found ? structuredClone(found) : undefined;
  }

  async upsertRepository(repository: RepositoryRecord): Promise<RepositoryRecord> {
    const sanitized = sanitizeRepository(repository);
    const index = this.state.repositories.findIndex((item) => item.fullName.toLowerCase() === sanitized.fullName.toLowerCase());
    if (index >= 0) this.state.repositories[index] = sanitized;
    else this.state.repositories.unshift(sanitized);
    this.state.repositories = this.state.repositories.slice(0, 100);
    await this.flush();
    return structuredClone(sanitized);
  }

  async removeRepository(fullName: string): Promise<void> {
    const normalized = normalizeRepository(fullName);
    this.state.repositories = this.state.repositories.filter((repository) => repository.fullName.toLowerCase() !== normalized.toLowerCase());
    await this.flush();
  }

  async updateRepositoryWebhook(fullName: string, update: Partial<RepositoryRecord["webhook"]>): Promise<RepositoryRecord> {
    const existing = this.getRepository(fullName);
    if (!existing) throw new Error(`Repository ${fullName} is not linked.`);
    existing.webhook = { ...existing.webhook, ...update };
    return this.upsertRepository(existing);
  }

  async updateRepositoryChatProject(fullName: string, projectUrl: string): Promise<RepositoryRecord> {
    const existing = this.getRepository(fullName);
    if (!existing) throw new Error(`Repository ${fullName} is not linked.`);
    const nextProjectUrl = sanitizeChatGptProjectUrl(projectUrl);
    if (existing.chatgptProjectUrl !== nextProjectUrl) existing.chatgptPrConversations = [];
    existing.chatgptProjectUrl = nextProjectUrl;
    return this.upsertRepository(existing);
  }

  async replaceRepositoryChatProject(
    fullName: string,
    expectedProjectUrl: string,
    projectUrl: string,
  ): Promise<RepositoryRecord> {
    const existing = this.getRepository(fullName);
    if (!existing) throw new Error(`Repository ${fullName} is not linked.`);
    const expected = sanitizeChatGptProjectUrl(expectedProjectUrl);
    const current = existing.chatgptProjectUrl ? sanitizeChatGptProjectUrl(existing.chatgptProjectUrl) : "";
    if (current !== expected) {
      throw new Error(`ChatGPT repository project changed concurrently for ${existing.fullName}. Retry the review.`);
    }
    existing.chatgptProjectUrl = sanitizeChatGptProjectUrl(projectUrl);
    existing.chatgptPrConversations = [];
    return this.upsertRepository(existing);
  }

  getPullRequestChatConversation(fullName: string, prNumber: number): string | undefined {
    const existing = this.getRepository(fullName);
    return existing?.chatgptPrConversations.find((binding) => binding.prNumber === prNumber)?.conversationUrl;
  }

  async updatePullRequestChatConversation(fullName: string, prNumber: number, conversationUrl: string): Promise<RepositoryRecord> {
    const existing = this.getRepository(fullName);
    if (!existing) throw new Error(`Repository ${fullName} is not linked.`);
    if (!existing.chatgptProjectUrl) throw new Error(`Repository ${fullName} does not have a ChatGPT project.`);
    const normalized = sanitizeChatGptConversationUrl(conversationUrl);
    const updatedAt = new Date().toISOString();
    existing.chatgptPrConversations = [
      { prNumber: sanitizePrNumber(prNumber), conversationUrl: normalized, updatedAt },
      ...existing.chatgptPrConversations.filter((binding) => binding.prNumber !== prNumber),
    ].slice(0, 500);
    return this.upsertRepository(existing);
  }

  async replacePullRequestChatConversation(
    fullName: string,
    prNumber: number,
    expectedConversationUrl: string,
    conversationUrl: string,
  ): Promise<RepositoryRecord> {
    const existing = this.getRepository(fullName);
    if (!existing) throw new Error(`Repository ${fullName} is not linked.`);
    const number = sanitizePrNumber(prNumber);
    const expected = sanitizeChatGptConversationUrl(expectedConversationUrl);
    const current = existing.chatgptPrConversations.find((binding) => binding.prNumber === number)?.conversationUrl ?? "";
    if (current !== expected) {
      throw new Error(`ChatGPT PR conversation changed concurrently for ${existing.fullName} PR #${number}. Retry the review.`);
    }
    const normalized = sanitizeChatGptConversationUrl(conversationUrl);
    existing.chatgptPrConversations = [
      { prNumber: number, conversationUrl: normalized, updatedAt: new Date().toISOString() },
      ...existing.chatgptPrConversations.filter((binding) => binding.prNumber !== number),
    ].slice(0, 500);
    return this.upsertRepository(existing);
  }

  listReviews(): ReviewRecord[] {
    return this.state.reviews.map((review) => structuredClone(review));
  }

  getReview(id: string): ReviewRecord | undefined {
    const found = this.state.reviews.find((review) => review.id === id);
    return found ? structuredClone(found) : undefined;
  }

  latestReviewForPr(repository: string, prNumber: number): ReviewRecord | undefined {
    const found = this.state.reviews.find((review) => review.repository.toLowerCase() === repository.toLowerCase() && review.prNumber === prNumber);
    return found ? structuredClone(found) : undefined;
  }

  async upsertReview(review: ReviewRecord): Promise<void> {
    const index = this.state.reviews.findIndex((item) => item.id === review.id);
    if (index >= 0) this.state.reviews[index] = structuredClone(review);
    else this.state.reviews.unshift(structuredClone(review));
    this.state.reviews = this.state.reviews.slice(0, 1000);
    await this.flush();
  }

  getWebhookDelivery(deliveryId: string): WebhookDeliveryRecord | undefined {
    const found = this.state.webhookDeliveries.find((delivery) => delivery.deliveryId === deliveryId);
    return found ? structuredClone(found) : undefined;
  }

  async recordWebhookDelivery(delivery: WebhookDeliveryRecord): Promise<"created" | "replayed"> {
    const existing = this.getWebhookDelivery(delivery.deliveryId);
    if (existing) {
      if (existing.payloadSha256 !== delivery.payloadSha256) {
        throw new Error("GitHub webhook delivery id was replayed with a different payload.");
      }
      return "replayed";
    }
    this.state.webhookDeliveries.unshift(structuredClone(delivery));
    this.state.webhookDeliveries = this.state.webhookDeliveries.slice(0, 2000);
    await this.flush();
    return "created";
  }

  private flush(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    });
    return this.writeChain;
  }
}

function migrateState(input: unknown): PersistedState {
  const value = isRecord(input) ? input : {};
  const config = sanitizeConfig(value.config);
  const repositories = Array.isArray(value.repositories)
    ? value.repositories.filter(isRepositoryRecord).map(sanitizeRepository).slice(0, 100)
    : [];

  const legacyConfig = isRecord(value.config) ? value.config : {};
  if (repositories.length === 0 && typeof legacyConfig.repository === "string" && isRepositoryName(legacyConfig.repository.trim())) {
    repositories.push(makeRepository(legacyConfig.repository.trim(), "Legacy repository migrated from polling configuration. Connect a personal Cloudflare named tunnel before syncing its GitHub webhook."));
  }

  const cloudflareProvisioning = safeCloudflareProvisioning(value.cloudflareProvisioning);
  const reviews = Array.isArray(value.reviews) ? value.reviews.filter(isReviewRecord).slice(0, 1000) : [];

  return {
    version: 4,
    config,
    cloudflareProvisioning,
    repositories,
    reviews,
    webhookDeliveries: Array.isArray(value.webhookDeliveries) ? value.webhookDeliveries.filter(isWebhookDelivery).slice(0, 2000) : [],
  };
}

export function makeRepository(fullName: string, lastError?: string): RepositoryRecord {
  const normalized = normalizeRepository(fullName);
  return {
    id: `repo_${createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 16)}`,
    fullName: normalized,
    addedAt: new Date().toISOString(),
    enabled: true,
    chatgptPrConversations: [],
    webhook: {
      hookId: null,
      targetUrl: "",
      status: lastError ? "error" : "pending",
      ...(lastError ? { lastError } : {}),
    },
  };
}

function sanitizeConfig(input: unknown): ReviewConfig {
  const value = isRecord(input) ? input : {};
  const cloudflareHostname = sanitizeCloudflareHostname(value.cloudflareHostname);
  return {
    autoReview: value.autoReview !== false,
    postComment: value.postComment === true,
    reviewDrafts: value.reviewDrafts === true,
    requireJiraWhenKeyPresent: value.requireJiraWhenKeyPresent !== false,
    maxDiffChunkBytes: boundedNumber(value.maxDiffChunkBytes, 12_000, 90_000, DEFAULT_CONFIG.maxDiffChunkBytes),
    cloudflareHostname,
    webhookPublicUrl: cloudflareHostname ? `https://${cloudflareHostname}/webhooks/v1/github` : "",
    webhookListenHost: sanitizeListenHost(value.webhookListenHost),
    webhookListenPort: boundedNumber(value.webhookListenPort, 1024, 65535, DEFAULT_CONFIG.webhookListenPort),
  };
}

function safeCloudflareProvisioning(value: unknown): CloudflareProvisioningRecord | null {
  if (!isCloudflareProvisioningRecord(value)) return null;
  try {
    return sanitizeCloudflareProvisioning(value);
  } catch {
    return null;
  }
}

function sanitizeCloudflareProvisioning(value: CloudflareProvisioningRecord): CloudflareProvisioningRecord {
  const hostname = sanitizeCloudflareHostname(value.hostname);
  const zoneName = sanitizeCloudflareHostname(value.zoneName);
  const tunnelName = sanitizeText(value.tunnelName, 256);
  if (!hostname) throw new Error("Cloudflare provisioning hostname is invalid.");
  if (!zoneName) throw new Error("Cloudflare provisioning zone name is invalid.");
  if (!tunnelName) throw new Error("Cloudflare provisioning tunnel name is invalid.");
  return {
    mode: "api",
    accountId: sanitizeCloudflareId(value.accountId, "account"),
    accountName: sanitizeText(value.accountName, 256),
    zoneId: sanitizeCloudflareId(value.zoneId, "zone"),
    zoneName,
    tunnelId: sanitizeCloudflareId(value.tunnelId, "tunnel"),
    tunnelName,
    dnsRecordId: sanitizeCloudflareId(value.dnsRecordId, "DNS record"),
    hostname,
    provisionedAt: typeof value.provisionedAt === "string" && value.provisionedAt.length <= 128 ? value.provisionedAt : new Date().toISOString(),
  };
}

function sanitizeRepository(value: RepositoryRecord): RepositoryRecord {
  const fullName = normalizeRepository(value.fullName);
  const webhook: Record<string, any> = isRecord(value.webhook) ? value.webhook : {};
  const status = webhook.status === "healthy" || webhook.status === "error" || webhook.status === "disabled" ? webhook.status : "pending";
  return {
    id: typeof value.id === "string" && /^repo_[a-f0-9]{16}$/.test(value.id) ? value.id : makeRepository(fullName).id,
    fullName,
    addedAt: typeof value.addedAt === "string" ? value.addedAt : new Date().toISOString(),
    enabled: value.enabled !== false,
    ...(safeChatGptProjectUrl(value.chatgptProjectUrl) ? { chatgptProjectUrl: safeChatGptProjectUrl(value.chatgptProjectUrl)! } : {}),
    chatgptPrConversations: sanitizePrConversationBindings(value.chatgptPrConversations),
    webhook: {
      hookId: Number.isSafeInteger(webhook.hookId) && Number(webhook.hookId) > 0 ? Number(webhook.hookId) : null,
      targetUrl: typeof webhook.targetUrl === "string" ? webhook.targetUrl.slice(0, 2048) : "",
      status,
      ...(typeof webhook.lastDeliveryAt === "string" ? { lastDeliveryAt: webhook.lastDeliveryAt } : {}),
      ...(typeof webhook.lastEvent === "string" ? { lastEvent: webhook.lastEvent.slice(0, 256) } : {}),
      ...(typeof webhook.lastError === "string" ? { lastError: webhook.lastError.slice(0, 2000) } : {}),
    },
  };
}

function isCloudflareProvisioningRecord(value: unknown): value is CloudflareProvisioningRecord {
  return isRecord(value)
    && value.mode === "api"
    && typeof value.accountId === "string"
    && typeof value.accountName === "string"
    && typeof value.zoneId === "string"
    && typeof value.zoneName === "string"
    && typeof value.tunnelId === "string"
    && typeof value.tunnelName === "string"
    && typeof value.dnsRecordId === "string"
    && typeof value.hostname === "string"
    && typeof value.provisionedAt === "string";
}

function isRepositoryRecord(value: unknown): value is RepositoryRecord {
  return isRecord(value) && typeof value.fullName === "string" && isRepositoryName(value.fullName) && isRecord(value.webhook);
}

function isReviewRecord(value: unknown): value is ReviewRecord {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.taskId === "string"
    && typeof value.repository === "string"
    && Number.isSafeInteger(value.prNumber)
    && typeof value.prTitle === "string"
    && typeof value.prUrl === "string"
    && typeof value.headSha === "string"
    && typeof value.status === "string"
    && typeof value.phase === "string"
    && Array.isArray(value.jiraKeys)
    && Array.isArray(value.specDocumentIds)
    && typeof value.startedAt === "string"
    && typeof value.updatedAt === "string";
}

function isWebhookDelivery(value: unknown): value is WebhookDeliveryRecord {
  return isRecord(value)
    && typeof value.deliveryId === "string"
    && typeof value.payloadSha256 === "string"
    && typeof value.repository === "string"
    && typeof value.event === "string"
    && typeof value.action === "string"
    && (value.prNumber === null || Number.isSafeInteger(value.prNumber))
    && (value.headSha === null || typeof value.headSha === "string")
    && typeof value.receivedAt === "string";
}

function normalizeRepository(repository: string): string {
  const normalized = repository.trim();
  if (!isRepositoryName(normalized)) throw new Error("Repository must use owner/name format.");
  return normalized;
}

function isRepositoryName(repository: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
}

function safeChatGptConversationUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return "";
    const segments = url.pathname.split("/").filter(Boolean);
    const conversationIndex = segments.findIndex((segment) => segment === "c");
    if (conversationIndex < 0 || !segments[conversationIndex + 1]) return "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    url.search = "";
    url.hash = "";
    const normalized = url.toString();
    return normalized.length <= 2048 ? normalized : "";
  } catch {
    return "";
  }
}

function sanitizeChatGptConversationUrl(value: unknown): string {
  const normalized = safeChatGptConversationUrl(value);
  if (!normalized) throw new Error("ChatGPT PR conversation URL is invalid.");
  return normalized;
}

function safeChatGptProjectUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return "";
    const segments = url.pathname.split("/").filter(Boolean);
    const projectIdIndex = segments.findIndex((segment) => /^g-p-[A-Za-z0-9_-]+$/.test(segment));
    if (projectIdIndex >= 0) {
      url.pathname = `/${[...segments.slice(0, projectIdIndex + 1), "project"].join("/")}`;
    } else {
      const projectIndex = segments.findIndex((segment) => segment === "project" || segment === "projects");
      if (projectIndex < 0 || !segments[projectIndex + 1]) return "";
      url.pathname = `/${segments.slice(0, projectIndex + 2).join("/")}`;
    }
    url.search = "";
    url.hash = "";
    const normalized = url.toString();
    return normalized.length <= 2048 ? normalized : "";
  } catch {
    return "";
  }
}

function sanitizeChatGptProjectUrl(value: unknown): string {
  const normalized = safeChatGptProjectUrl(value);
  if (!normalized) throw new Error("ChatGPT repository project URL is invalid.");
  return normalized;
}

function sanitizePrConversationBindings(value: unknown): RepositoryRecord["chatgptPrConversations"] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const result: RepositoryRecord["chatgptPrConversations"] = [];
  for (const item of value) {
    if (!isRecord(item) || !Number.isSafeInteger(item.prNumber) || Number(item.prNumber) <= 0) continue;
    const prNumber = Number(item.prNumber);
    if (seen.has(prNumber)) continue;
    const conversationUrl = safeChatGptConversationUrl(item.conversationUrl);
    if (!conversationUrl) continue;
    seen.add(prNumber);
    result.push({
      prNumber,
      conversationUrl,
      updatedAt: typeof item.updatedAt === "string" && item.updatedAt.length <= 128 ? item.updatedAt : new Date().toISOString(),
    });
    if (result.length >= 500) break;
  }
  return result;
}

function sanitizePrNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Pull request number is invalid.");
  return number;
}

function sanitizeCloudflareHostname(value: unknown): string {
  if (typeof value !== "string") return "";
  const input = value.trim().toLowerCase().replace(/\.$/, "");
  if (input.length < 3 || input.length > 253 || !input.includes(".") || input.includes("://") || input.includes("/") || input.includes("@")) return "";
  if (input.endsWith(".trycloudflare.com")) return "";
  const labels = input.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return "";
  return input;
}

function sanitizeCloudflareId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) throw new Error(`Cloudflare ${label} id is invalid.`);
  return value;
}

function sanitizeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\r\n\0]+/g, " ").trim().slice(0, max) : "";
}

function sanitizeListenHost(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_CONFIG.webhookListenHost;
  const host = value.trim();
  if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "::") return host;
  return DEFAULT_CONFIG.webhookListenHost;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
