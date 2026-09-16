import { randomUUID } from "node:crypto";

import { ChatGptWebDriver } from "./chatgpt-web-driver";
import { GitHubProvider } from "./github-provider";
import {
  buildChunkReviewPrompt,
  buildFinalReviewPrompt,
  buildJiraResolutionPrompt,
  extractJiraKeys,
  parseChunkReview,
  parseFinalReview,
  parseJiraResolution,
  reviewMarkdown,
  splitDiff,
} from "./review-protocol";
import { SpecMemoryStore } from "./spec-memory";
import { makeRepository, StateStore } from "./state-store";
import type {
  AppView,
  JiraResolution,
  PullRequestSummary,
  RepositoryRecord,
  ReviewPhase,
  ReviewRecord,
} from "./types";
import { shouldTriggerPullRequestReview, type GitHubWebhookEvent } from "./webhook-server";

export interface ReviewEngineEvent {
  type: "state" | "progress";
  reviewId?: string;
  taskId?: string;
  phase?: ReviewPhase;
  repository?: string;
  prNumber?: number;
  message: string;
}

type EngineView = Omit<AppView, "webhook" | "tunnel" | "cloudflareProvisioning">;

export class ReviewEngine {
  private prs: PullRequestSummary[] = [];
  private providerStatus = { ghInstalled: false, ghAuthenticated: false, detail: "Not checked." };
  private running = new Set<string>();
  private scheduled = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: {
    state: StateStore;
    specs: SpecMemoryStore;
    github: GitHubProvider;
    chatgpt: ChatGptWebDriver;
    webhookSecret: string;
    onEvent?: (event: ReviewEngineEvent) => void;
  }) {}

  async initialize(): Promise<void> {
    this.providerStatus = await this.dependencies.github.status();
    if (!this.providerStatus.ghAuthenticated) return;
    for (const repository of this.dependencies.state.listRepositories()) {
      if (!repository.enabled) continue;
      await this.refreshPullRequests(repository.fullName).catch((error) => {
        this.emit({ type: "progress", repository: repository.fullName, message: `Initial PR refresh failed: ${safeError(error)}` });
      });
    }
  }

  async view(): Promise<EngineView> {
    const chatReady = await this.dependencies.chatgpt.ready().catch(() => false);
    return {
      config: this.dependencies.state.getConfig(),
      specs: this.dependencies.specs.list(),
      reviews: this.dependencies.state.listReviews(),
      repositories: this.dependencies.state.listRepositories(),
      provider: { ...this.providerStatus },
      chatgpt: { ready: chatReady },
      prs: this.prs.map((pr) => ({ ...pr })),
    };
  }

  async refreshProviderStatus(): Promise<void> {
    this.providerStatus = await this.dependencies.github.status();
  }

  async linkRepository(repository: string): Promise<RepositoryRecord> {
    const config = this.dependencies.state.getConfig();
    if (!config.webhookPublicUrl) throw new Error("Connect and verify your personal Cloudflare named tunnel before linking a repository.");
    this.providerStatus = await this.dependencies.github.status();
    if (!this.providerStatus.ghAuthenticated) throw new Error(this.providerStatus.detail);

    const validated = await this.dependencies.github.validateRepository(repository);
    const existing = this.dependencies.state.getRepository(validated.fullName);
    const record = existing ?? makeRepository(validated.fullName);
    if (!record.chatgptConversationUrl) {
      const priorConversation = this.dependencies.state.listReviews()
        .find((review) => review.repository.toLowerCase() === validated.fullName.toLowerCase() && review.conversationUrl)?.conversationUrl;
      if (priorConversation) record.chatgptConversationUrl = priorConversation;
    }
    record.enabled = true;
    await this.dependencies.state.upsertRepository(record);

    let configured: RepositoryRecord;
    try {
      configured = await this.syncRepositoryWebhook(validated.fullName);
    } catch (error) {
      configured = await this.dependencies.state.updateRepositoryWebhook(validated.fullName, {
        status: "error",
        lastError: safeError(error),
      });
      this.emit({ type: "state", repository: validated.fullName, message: `Repository linked, but webhook setup failed: ${safeError(error)}` });
    }

    await this.refreshPullRequests(validated.fullName).catch((error) => {
      this.emit({ type: "progress", repository: validated.fullName, message: `Repository linked but PR refresh failed: ${safeError(error)}` });
    });
    return configured;
  }

  async unlinkRepository(repository: string): Promise<void> {
    const existing = this.dependencies.state.getRepository(repository);
    if (!existing) return;
    if (existing.webhook.hookId) {
      await this.dependencies.github.deleteWebhook(existing.fullName, existing.webhook.hookId).catch((error) => {
        this.emit({ type: "progress", repository: existing.fullName, message: `GitHub webhook cleanup failed during unlink: ${safeError(error)}` });
      });
    }
    await this.dependencies.state.removeRepository(existing.fullName);
    this.prs = this.prs.filter((pr) => pr.repository.toLowerCase() !== existing.fullName.toLowerCase());
    this.emit({ type: "state", repository: existing.fullName, message: `Unlinked ${existing.fullName}.` });
  }

  async syncRepositoryWebhook(repository: string): Promise<RepositoryRecord> {
    const config = this.dependencies.state.getConfig();
    if (!config.webhookPublicUrl) throw new Error("Personal Cloudflare named tunnel webhook URL is not configured.");
    const existing = this.dependencies.state.getRepository(repository);
    if (!existing) throw new Error(`Repository ${repository} is not linked.`);

    await this.dependencies.state.updateRepositoryWebhook(existing.fullName, {
      status: "pending",
      targetUrl: config.webhookPublicUrl,
      lastError: undefined,
    });
    try {
      const registration = await this.dependencies.github.ensureWebhook(
        existing.fullName,
        config.webhookPublicUrl,
        this.dependencies.webhookSecret,
        existing.webhook.hookId,
      );
      const latest = this.dependencies.state.getRepository(existing.fullName);
      const status = latest?.webhook.lastDeliveryAt ? latest.webhook.status : "pending";
      const updated = await this.dependencies.state.updateRepositoryWebhook(existing.fullName, {
        hookId: registration.hookId,
        targetUrl: registration.targetUrl,
        status,
        lastError: undefined,
      });
      this.emit({ type: "state", repository: existing.fullName, message: `GitHub webhook configured for ${existing.fullName}; waiting for a signed delivery/ping.` });
      return updated;
    } catch (error) {
      await this.dependencies.state.updateRepositoryWebhook(existing.fullName, { status: "error", lastError: safeError(error) });
      throw error;
    }
  }

  async syncAllWebhooks(): Promise<void> {
    for (const repository of this.dependencies.state.listRepositories()) {
      if (!repository.enabled) continue;
      await this.syncRepositoryWebhook(repository.fullName).catch((error) => {
        this.emit({ type: "progress", repository: repository.fullName, message: `Webhook sync failed: ${safeError(error)}` });
      });
    }
  }

  async refreshPullRequests(repository?: string): Promise<PullRequestSummary[]> {
    this.providerStatus = await this.dependencies.github.status();
    if (!this.providerStatus.ghAuthenticated) throw new Error(this.providerStatus.detail);

    if (repository) {
      const linked = this.dependencies.state.getRepository(repository);
      if (!linked || !linked.enabled) throw new Error(`Repository ${repository} is not linked.`);
      const next = await this.dependencies.github.listOpenPullRequests(linked.fullName);
      this.prs = [...this.prs.filter((pr) => pr.repository.toLowerCase() !== linked.fullName.toLowerCase()), ...next];
      return next.map((pr) => ({ ...pr }));
    }

    const all: PullRequestSummary[] = [];
    for (const linked of this.dependencies.state.listRepositories()) {
      if (!linked.enabled) continue;
      const next = await this.dependencies.github.listOpenPullRequests(linked.fullName);
      all.push(...next);
    }
    this.prs = all;
    return all.map((pr) => ({ ...pr }));
  }

  enqueueReview(repository: string, prNumber: number, force = false, trigger = "manual"): Promise<ReviewRecord> {
    const linked = this.dependencies.state.getRepository(repository);
    if (!linked || !linked.enabled) return Promise.reject(new Error(`Repository ${repository} is not linked.`));
    const key = `${linked.fullName.toLowerCase()}#${prNumber}`;
    if (this.scheduled.has(key) || (this.running.has(key) && trigger === "manual")) {
      return Promise.reject(new Error(`${linked.fullName} PR #${prNumber} is already queued or being reviewed.`));
    }
    this.scheduled.add(key);
    const execution = this.queue.then(() => {
      this.scheduled.delete(key);
      return this.reviewNow(linked.fullName, prNumber, force, trigger);
    });
    this.queue = execution.catch(() => undefined);
    return execution;
  }

  async handleWebhookEvent(event: GitHubWebhookEvent): Promise<void> {
    this.emit({
      type: "progress",
      repository: event.repository,
      prNumber: event.prNumber ?? undefined,
      message: `Webhook ${event.event}:${event.action} received for ${event.repository}${event.prNumber ? ` PR #${event.prNumber}` : ""}.`,
    });

    if (event.event === "ping") return;
    if (event.event !== "pull_request" || !event.prNumber) return;

    if (event.action === "closed") {
      this.prs = this.prs.filter((pr) => !(pr.repository.toLowerCase() === event.repository.toLowerCase() && pr.number === event.prNumber));
      this.emit({ type: "state", repository: event.repository, prNumber: event.prNumber, message: `PR #${event.prNumber} closed; removed from the active PR list.` });
      return;
    }

    let pr: PullRequestSummary;
    try {
      pr = await this.dependencies.github.getPullRequest(event.repository, event.prNumber);
    } catch (error) {
      throw new Error(`Failed to re-read webhook PR from GitHub: ${safeError(error)}`);
    }
    if (event.headSha && pr.headSha !== event.headSha) {
      this.emit({
        type: "progress",
        repository: event.repository,
        prNumber: event.prNumber,
        message: `Ignored stale webhook delivery for ${event.repository} PR #${event.prNumber}: webhook head ${event.headSha.slice(0, 10)} != current ${pr.headSha.slice(0, 10)}.`,
      });
      return;
    }
    this.upsertPrCache(pr);
    this.emit({ type: "state", repository: event.repository, prNumber: event.prNumber, message: `PR #${event.prNumber} refreshed from webhook event.` });

    const config = this.dependencies.state.getConfig();
    if (!config.autoReview || !shouldTriggerPullRequestReview(event.action)) return;
    if (pr.isDraft && !config.reviewDrafts) return;

    const force = event.action === "edited" || event.action === "reopened" || event.action === "ready_for_review";
    try {
      await this.enqueueReview(event.repository, event.prNumber, force, `webhook:${event.action}`);
    } catch (error) {
      if (safeError(error).includes("already queued or being reviewed")) {
        this.emit({
          type: "progress",
          repository: event.repository,
          prNumber: event.prNumber,
          message: `Coalesced webhook ${event.action} for ${event.repository} PR #${event.prNumber}; an existing queued follow-up will re-read the latest PR state before review.`,
        });
        return;
      }
      throw error;
    }
  }

  private async reviewNow(repository: string, prNumber: number, force: boolean, trigger: string): Promise<ReviewRecord> {
    const config = this.dependencies.state.getConfig();
    const key = `${repository.toLowerCase()}#${prNumber}`;
    if (this.running.has(key)) throw new Error(`${repository} PR #${prNumber} is already being reviewed.`);
    this.running.add(key);

    let record: ReviewRecord | undefined;
    try {
      this.providerStatus = await this.dependencies.github.status();
      if (!this.providerStatus.ghAuthenticated) throw new Error(this.providerStatus.detail);
      const pr = await this.dependencies.github.getPullRequest(repository, prNumber);
      this.upsertPrCache(pr);
      if (pr.isDraft && !config.reviewDrafts) throw new Error("Draft pull requests are excluded by current settings.");
      const existing = this.dependencies.state.latestReviewForPr(repository, pr.number);
      if (!force && existing?.headSha === pr.headSha && (existing.status === "completed" || existing.status === "blocked")) return existing;

      const now = new Date().toISOString();
      const taskId = `review_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      record = {
        id: `pr_${pr.number}_${pr.headSha.slice(0, 12)}_${Date.now()}`,
        taskId,
        repository,
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
        headSha: pr.headSha,
        status: "queued",
        phase: "queued",
        jiraKeys: extractJiraKeys(pr.title, pr.body),
        specDocumentIds: this.dependencies.specs.list().map((item) => item.id),
        startedAt: now,
        updatedAt: now,
        trigger,
      };
      await this.dependencies.state.upsertReview(record);
      await this.setPhase(record, "collecting-pr", `Collected ${repository} PR #${pr.number} at exact head ${pr.headSha.slice(0, 12)}.`);

      const diff = await this.dependencies.github.getPullRequestDiff(repository, pr.number);
      if (!diff.trim()) throw new Error("Pull request diff is empty.");
      const diffChunks = splitDiff(diff, config.maxDiffChunkBytes);
      if (!diffChunks.length) throw new Error("Pull request diff could not be chunked for review.");

      const repositoryRecord = this.dependencies.state.getRepository(repository);
      await this.dependencies.chatgpt.startTask(taskId, repositoryRecord?.chatgptConversationUrl);
      const bindConversation = (conversationUrl: string) => this.bindRepositoryConversation(record!, conversationUrl);
      let jira: JiraResolution;
      if (record.jiraKeys.length === 0) {
        jira = { primaryKey: null, status: "no-key", issues: [], notes: "No Jira key was found in PR title or description.", raw: "" };
      } else {
        await this.setPhase(record, "resolving-jira", `Resolving Jira keys: ${record.jiraKeys.join(", ")}`);
        const resolved = await this.dependencies.chatgpt.send(taskId, buildJiraResolutionPrompt({ taskId, pr, keys: record.jiraKeys }), bindConversation);
        await this.bindRepositoryConversation(record, resolved.conversationUrl);
        jira = parseJiraResolution(resolved.text, taskId);
      }
      record.jira = jira;
      record.updatedAt = new Date().toISOString();
      await this.dependencies.state.upsertReview(record);

      if (record.jiraKeys.length > 0 && jira.status === "resolved") {
        const candidateKeys = [...record.jiraKeys];
        const primaryKey = jira.primaryKey?.toUpperCase() ?? "";
        const resolvedKeys = jira.issues.map((issue) => issue.key.toUpperCase());
        const exactMapping = primaryKey.length > 0
          && candidateKeys.includes(primaryKey)
          && resolvedKeys.includes(primaryKey)
          && resolvedKeys.length > 0
          && resolvedKeys.every((issueKey) => candidateKeys.includes(issueKey));
        if (!exactMapping) {
          return this.block(record, "ChatGPT returned Jira context that did not exactly match the issue key(s) extracted from the PR title/description.");
        }
      }

      if (record.jiraKeys.length > 0 && config.requireJiraWhenKeyPresent && jira.status !== "resolved") {
        return this.block(record, `Jira mapping is required but ChatGPT could not resolve the referenced issue(s): ${jira.status}.`);
      }

      await this.setPhase(record, "retrieving-spec", `Retrieving relevant chunks from ${record.specDocumentIds.length} attached spec document(s).`);
      const jiraText = jira.issues.map((issue) => `${issue.key}\n${issue.summary}\n${issue.description}\n${issue.acceptanceCriteria}`).join("\n\n");
      const globalQuery = `${pr.title}\n${pr.body}\n${jiraText}`;
      const topSpec = this.dependencies.specs.search(globalQuery, 10);

      const chunkReviews = [];
      for (const chunk of diffChunks) {
        await this.setPhase(record, "reviewing-diff", `Reviewing diff chunk ${chunk.index}/${diffChunks.length}: ${chunk.files.join(", ")}`);
        const chunkSpec = this.dependencies.specs.search(`${globalQuery}\n${chunk.text.slice(0, 24_000)}`, 8);
        const response = await this.dependencies.chatgpt.send(taskId, buildChunkReviewPrompt({
          taskId,
          pr,
          jira,
          spec: chunkSpec,
          chunk,
          totalChunks: diffChunks.length,
        }), bindConversation);
        await this.bindRepositoryConversation(record, response.conversationUrl);
        chunkReviews.push(parseChunkReview(response.text, taskId, chunk.index));
        record.updatedAt = new Date().toISOString();
        await this.dependencies.state.upsertReview(record);
      }

      await this.setPhase(record, "synthesizing", `Synthesizing ${chunkReviews.length} bounded review result(s).`);
      const finalResponse = await this.dependencies.chatgpt.send(taskId, buildFinalReviewPrompt({ taskId, pr, jira, spec: topSpec, chunks: chunkReviews }), bindConversation);
      await this.bindRepositoryConversation(record, finalResponse.conversationUrl);
      record.rawReview = finalResponse.text;
      record.result = parseFinalReview(finalResponse.text, taskId);

      if (record.result.verdict === "BLOCKED") return this.block(record, record.result.summary || "ChatGPT marked the review blocked by missing evidence.");

      if (config.postComment) {
        await this.setPhase(record, "posting-comment", "Posting the completed review to GitHub.");
        await this.dependencies.github.postComment(repository, pr.number, reviewMarkdown(record.result, pr.headSha));
        record.commentPosted = true;
      }

      record.status = "completed";
      record.phase = "completed";
      record.completedAt = new Date().toISOString();
      record.updatedAt = record.completedAt;
      await this.dependencies.state.upsertReview(record);
      const commentMessage = config.postComment
        ? (record.commentPosted ? " GitHub comment posted." : " GitHub comment was not posted.")
        : " GitHub comment posting is disabled in Review settings.";
      this.emit({ type: "state", reviewId: record.id, taskId, repository, prNumber, phase: "completed", message: `${repository} PR #${pr.number} review completed: ${record.result.verdict}.${commentMessage}` });
      return record;
    } catch (error) {
      if (record) {
        record.status = "failed";
        record.phase = "failed";
        record.error = safeError(error);
        record.updatedAt = new Date().toISOString();
        record.completedAt = record.updatedAt;
        await this.dependencies.state.upsertReview(record).catch(() => undefined);
        this.emit({ type: "state", reviewId: record.id, taskId: record.taskId, repository, prNumber, phase: "failed", message: record.error });
      }
      throw error;
    } finally {
      if (record) this.dependencies.chatgpt.finishTask(record.taskId);
      this.running.delete(key);
    }
  }

  private upsertPrCache(pr: PullRequestSummary): void {
    this.prs = [
      ...this.prs.filter((item) => !(item.repository.toLowerCase() === pr.repository.toLowerCase() && item.number === pr.number)),
      pr,
    ];
  }

  private async bindRepositoryConversation(record: ReviewRecord, conversationUrl: string): Promise<void> {
    const repository = this.dependencies.state.getRepository(record.repository);
    if (!repository) throw new Error(`Repository ${record.repository} is not linked.`);

    if (repository.chatgptConversationUrl && repository.chatgptConversationUrl !== conversationUrl) {
      throw new Error(`ChatGPT conversation changed unexpectedly for ${record.repository}. Reviews for one repository must stay in one conversation.`);
    }

    const canonical = repository.chatgptConversationUrl
      ?? (await this.dependencies.state.updateRepositoryChatConversation(record.repository, conversationUrl)).chatgptConversationUrl;
    if (!canonical) throw new Error(`Could not bind a ChatGPT conversation to ${record.repository}.`);
    record.conversationUrl = canonical;
  }

  private async setPhase(record: ReviewRecord, phase: ReviewPhase, message: string): Promise<void> {
    record.status = phase === "blocked" ? "blocked" : phase === "failed" ? "failed" : phase === "completed" ? "completed" : "running";
    record.phase = phase;
    record.updatedAt = new Date().toISOString();
    await this.dependencies.state.upsertReview(record);
    this.emit({ type: "state", reviewId: record.id, taskId: record.taskId, repository: record.repository, prNumber: record.prNumber, phase, message });
  }

  private async block(record: ReviewRecord, reason: string): Promise<ReviewRecord> {
    record.status = "blocked";
    record.phase = "blocked";
    record.error = reason;
    record.completedAt = new Date().toISOString();
    record.updatedAt = record.completedAt;
    await this.dependencies.state.upsertReview(record);
    this.emit({ type: "state", reviewId: record.id, taskId: record.taskId, repository: record.repository, prNumber: record.prNumber, phase: "blocked", message: reason });
    return record;
  }

  private emit(event: ReviewEngineEvent): void {
    this.dependencies.onEvent?.(event);
  }
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.replace(/[\r\n]+/g, " ").slice(0, 2000) : "Unknown review error.";
}
