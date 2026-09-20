import { randomUUID } from "node:crypto";

import { ChatGptWebDriver } from "./chatgpt-web-driver";
import { GitHubProvider } from "./github-provider";
import { OcrChatGptGateway } from "./ocr-chatgpt-gateway";
import { OpenCodeReviewProvider } from "./open-code-review";
import {
  buildOpenCodeReviewBackground,
  buildJiraRepairPrompt,
  buildJiraResolutionPrompt,
  extractJiraKeys,
  githubReviewEventForVerdict,
  parseJiraResolution,
  reviewMarkdown,
} from "./review-protocol";
import { SpecMemoryStore } from "./spec-memory";
import { makeRepository, StateStore } from "./state-store";
import type {
  AppView,
  GitHubPullRequestGate,
  JiraResolution,
  PullRequestSummary,
  RepositoryRecord,
  ReviewPhase,
  ReviewRecord,
} from "./types";
import { shouldTriggerPullRequestReview, type GitHubWebhookEvent } from "./webhook-server";

const JIRA_FORMAT_RETRIES = 2;
const MAX_CONCURRENT_REVIEWS = 3;
const CI_POLL_INTERVAL_MS = 10_000;
const CI_DISCOVERY_GRACE_MS = 60_000;
const CI_SETTLE_MS = 10_000;
const CI_WAIT_TIMEOUT_MS = 2 * 60 * 60_000;

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
  private ocrStatus = { installed: false, version: "", detail: "Not checked." };
  private running = new Set<string>();
  private scheduled = new Set<string>();
  private activeReviewCount = 0;
  private reviewSlotWaiters: Array<() => void> = [];
  private repositoryProjectPromises = new Map<string, Promise<string>>();
  private cancelledTasks = new Set<string>();

  constructor(private readonly dependencies: {
    state: StateStore;
    specs: SpecMemoryStore;
    github: GitHubProvider;
    ocr: OpenCodeReviewProvider;
    chatgpt: ChatGptWebDriver;
    webhookSecret: string;
    onEvent?: (event: ReviewEngineEvent) => void;
  }) {}

  async initialize(): Promise<void> {
    [this.providerStatus, this.ocrStatus] = await Promise.all([
      this.dependencies.github.status(),
      this.dependencies.ocr.status(),
    ]);
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
      ocr: { ...this.ocrStatus },
      chatgpt: { ready: chatReady },
      prs: this.prs.map((pr) => ({ ...pr })),
    };
  }

  async refreshProviderStatus(): Promise<void> {
    [this.providerStatus, this.ocrStatus] = await Promise.all([
      this.dependencies.github.status(),
      this.dependencies.ocr.status(),
    ]);
  }

  async linkRepository(repository: string): Promise<RepositoryRecord> {
    const config = this.dependencies.state.getConfig();
    if (!config.webhookPublicUrl) throw new Error("Connect and verify your personal Cloudflare named tunnel before linking a repository.");
    this.providerStatus = await this.dependencies.github.status();
    if (!this.providerStatus.ghAuthenticated) throw new Error(this.providerStatus.detail);

    const validated = await this.dependencies.github.validateRepository(repository);
    const existing = this.dependencies.state.getRepository(validated.fullName);
    const record = existing ?? makeRepository(validated.fullName);
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

    await this.ensureRepositoryProject(validated.fullName).catch((error) => {
      this.emit({ type: "progress", repository: validated.fullName, message: `Repository linked; ChatGPT Project setup is pending: ${safeError(error)}` });
    });
    await this.refreshPullRequests(validated.fullName).catch((error) => {
      this.emit({ type: "progress", repository: validated.fullName, message: `Repository linked but PR refresh failed: ${safeError(error)}` });
    });
    return this.dependencies.state.getRepository(validated.fullName) ?? configured;
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
    const execution = (async () => {
      while (this.running.has(key)) await new Promise((resolve) => setTimeout(resolve, 250));
      this.scheduled.delete(key);
      return this.reviewNow(linked.fullName, prNumber, force, trigger);
    })();
    void execution.catch(() => {
      this.scheduled.delete(key);
    });
    return execution;
  }

  async cancelReview(reviewId: string): Promise<ReviewRecord> {
    const review = this.dependencies.state.getReview(reviewId);
    if (!review) throw new Error("Review was not found.");
    if (review.status === "completed" || review.status === "blocked" || review.status === "failed" || review.status === "cancelled") return review;

    this.cancelledTasks.add(review.taskId);
    // Destroying the task window immediately interrupts any in-flight ChatGPT
    // DOM wait/send loop. Non-ChatGPT work checks cancelledTasks at phase
    // boundaries and exits before the next expensive stage.
    this.dependencies.chatgpt.finishTask(review.taskId);

    const now = new Date().toISOString();
    review.status = "cancelled";
    review.phase = "cancelled";
    review.error = "Review cancelled by user.";
    review.updatedAt = now;
    review.completedAt = now;
    await this.dependencies.state.upsertReview(review);
    this.emit({
      type: "state",
      reviewId: review.id,
      taskId: review.taskId,
      repository: review.repository,
      prNumber: review.prNumber,
      phase: "cancelled",
      message: review.error,
    });
    return review;
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
    let reviewSlotAcquired = false;
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
      record.githubGate = await this.waitForExactHeadCi(record, pr.headSha);
      record.updatedAt = new Date().toISOString();
      await this.dependencies.state.upsertReview(record);

      await this.setPhase(record, "queued", `Exact-head CI is complete; waiting for an available review execution slot.`);
      await this.acquireReviewSlot();
      reviewSlotAcquired = true;
      const projectUrl = await this.ensureRepositoryProject(repository);
      this.assertNotCancelled(record);
      const storedConversationUrl = this.dependencies.state.getPullRequestChatConversation(repository, pr.number);
      const taskStart = await this.dependencies.chatgpt.startTask(taskId, projectUrl, storedConversationUrl);
      let staleConversationUrl: string | undefined;
      if (storedConversationUrl && taskStart.fallbackToNewConversation) {
        // One PR owns one canonical conversation inside the repository Project.
        // If that chat vanished, the first new conversation created by this task
        // replaces only this PR's stale binding.
        staleConversationUrl = storedConversationUrl;
        this.emit({
          type: "progress",
          reviewId: record.id,
          taskId: record.taskId,
          repository: record.repository,
          prNumber: record.prNumber,
          phase: record.phase,
          message: `Stored ChatGPT conversation for ${record.repository} PR #${record.prNumber} is unavailable; creating a new conversation inside the repository Project.`,
        });
      } else if (taskStart.conversationUrl) {
        await this.bindPullRequestConversation(record, taskStart.conversationUrl);
      }
      const bindConversation = async (conversationUrl: string) => {
        if (staleConversationUrl) {
          const expected = staleConversationUrl;
          staleConversationUrl = undefined;
          await this.rebindStalePullRequestConversation(record!, expected, conversationUrl);
          return;
        }
        await this.bindPullRequestConversation(record!, conversationUrl);
      };
      let jira: JiraResolution;
      if (record.jiraKeys.length === 0) {
        jira = { primaryKey: null, status: "no-key", issues: [], notes: "No Jira key was found in PR title or description.", raw: "" };
      } else {
        await this.setPhase(record, "resolving-jira", `Resolving Jira keys: ${record.jiraKeys.join(", ")}`);
        let response = await this.dependencies.chatgpt.send(taskId, buildJiraResolutionPrompt({ taskId, pr, keys: record.jiraKeys }), bindConversation);
        this.assertNotCancelled(record);
        await bindConversation(response.conversationUrl);
        let parsedJira: JiraResolution | undefined;
        let parseError: unknown;
        for (let attempt = 0; attempt <= JIRA_FORMAT_RETRIES; attempt += 1) {
          try {
            parsedJira = parseJiraResolution(response.text, taskId);
            break;
          } catch (error) {
            parseError = error;
            if (attempt >= JIRA_FORMAT_RETRIES || !isRetryableJiraFormatError(error)) break;
            const retryNumber = attempt + 1;
            this.emit({
              type: "progress",
              reviewId: record.id,
              taskId: record.taskId,
              repository: record.repository,
              prNumber: record.prNumber,
              phase: record.phase,
              message: `Jira context format was invalid; asking ChatGPT to reformat it (${retryNumber}/${JIRA_FORMAT_RETRIES}).`,
            });
            response = await this.dependencies.chatgpt.send(taskId, buildJiraRepairPrompt({
              taskId,
              keys: record.jiraKeys,
              parseError: safeError(error),
              attempt: retryNumber,
              maxAttempts: JIRA_FORMAT_RETRIES,
            }), bindConversation);
            this.assertNotCancelled(record);
            await bindConversation(response.conversationUrl);
          }
        }
        if (!parsedJira) throw parseError instanceof Error ? parseError : new Error("Jira context could not be parsed.");
        jira = parsedJira;
      }
      this.assertNotCancelled(record);
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

      await this.setPhase(record, "reviewing-diff", "OpenCodeReview managed agent is reviewing the exact PR head through the local ChatGPT Web LLM gateway.");
      const ocrBackground = buildOpenCodeReviewBackground({ pr, jira, spec: topSpec, githubGate: record.githubGate });
      const gateway = new OcrChatGptGateway(
        this.dependencies.chatgpt,
        projectUrl,
        (message) => this.emit({
          type: "progress",
          reviewId: record!.id,
          taskId: record!.taskId,
          repository: record!.repository,
          prNumber: record!.prNumber,
          phase: record!.phase,
          message,
        }),
      );

      const gatewayBinding = await gateway.start();
      try {
        const managedReview = await this.dependencies.ocr.reviewPullRequest(
          repository,
          pr,
          ocrBackground,
          gatewayBinding,
        );
        this.assertNotCancelled(record);
        record.ocr = managedReview.metadata;
        record.rawReview = managedReview.raw;
        record.result = managedReview.result;
        record.updatedAt = new Date().toISOString();
        await this.dependencies.state.upsertReview(record);
      } finally {
        await gateway.stop().catch(() => undefined);
      }

      await this.setPhase(
        record,
        "synthesizing",
        `Using OpenCodeReview managed-agent result: ${record.ocr?.reviewedFiles ?? 0}/${record.ocr?.reviewableFiles ?? 0} selected files, ${record.result?.findings.length ?? 0} finding(s), ${record.ocr?.toolCalls ?? 0} tool call(s).`,
      );
      if (!record.result) throw new Error("OpenCodeReview managed review did not produce a normalized result.");
      this.assertNotCancelled(record);

      record.githubGate = await this.waitForExactHeadCi(record, pr.headSha, 0, "before-publish");
      record.updatedAt = new Date().toISOString();
      await this.dependencies.state.upsertReview(record);

      const blockedReason = record.result.verdict === "BLOCKED"
        ? (record.result.summary || "ChatGPT marked the review blocked by missing evidence.")
        : "";

      let githubReviewMessage = " GitHub review submission is disabled in Review settings.";
      if (config.postComment) {
        const reviewEvent = githubReviewEventForVerdict(record.result.verdict);
        await this.setPhase(record, "posting-comment", `Submitting the completed ${reviewEvent} review to GitHub.`);
        const submission = await this.dependencies.github.submitPullRequestReview(
          repository,
          pr.number,
          reviewMarkdown(record.result, pr, jira, record.ocr, record.githubGate, existing ? { headSha: existing.headSha, result: existing.result } : undefined),
          reviewEvent,
        );
        this.assertNotCancelled(record);
        record.commentPosted = true;
        githubReviewMessage = submission.fallbackEvent
          ? ` GitHub rejected the intended ${submission.event} self-review; ${submission.fallbackEvent} fallback submitted.`
          : ` GitHub ${submission.event} review submitted.`;
      }

      if (blockedReason) {
        return this.block(record, `${blockedReason}${githubReviewMessage}`);
      }

      this.assertNotCancelled(record);
      record.status = "completed";
      record.phase = "completed";
      record.completedAt = new Date().toISOString();
      record.updatedAt = record.completedAt;
      await this.dependencies.state.upsertReview(record);
      this.emit({ type: "state", reviewId: record.id, taskId, repository, prNumber, phase: "completed", message: `${repository} PR #${pr.number} review completed: ${record.result.verdict}.${githubReviewMessage}` });
      return record;
    } catch (error) {
      if (record && (this.cancelledTasks.has(record.taskId) || this.dependencies.state.getReview(record.id)?.status === "cancelled")) {
        const persisted = this.dependencies.state.getReview(record.id);
        if (persisted?.status === "cancelled") return persisted;
        const now = new Date().toISOString();
        record.status = "cancelled";
        record.phase = "cancelled";
        record.error = "Review cancelled by user.";
        record.updatedAt = now;
        record.completedAt = now;
        await this.dependencies.state.upsertReview(record).catch(() => undefined);
        this.emit({ type: "state", reviewId: record.id, taskId: record.taskId, repository, prNumber, phase: "cancelled", message: record.error });
        return record;
      }
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
      if (record) {
        this.dependencies.chatgpt.finishTask(record.taskId);
        this.cancelledTasks.delete(record.taskId);
      }
      if (reviewSlotAcquired) this.releaseReviewSlot();
      this.running.delete(key);
    }
  }

  private upsertPrCache(pr: PullRequestSummary): void {
    this.prs = [
      ...this.prs.filter((item) => !(item.repository.toLowerCase() === pr.repository.toLowerCase() && item.number === pr.number)),
      pr,
    ];
  }

  private async ensureRepositoryProject(repository: string): Promise<string> {
    const key = repository.toLowerCase();
    const existingPromise = this.repositoryProjectPromises.get(key);
    if (existingPromise) return existingPromise;

    const execution = (async () => {
      const current = this.dependencies.state.getRepository(repository);
      if (!current) throw new Error(`Repository ${repository} is not linked.`);
      const binding = await this.dependencies.chatgpt.ensureProject(current.fullName, current.chatgptProjectUrl);
      let updated = current;
      if (!current.chatgptProjectUrl) {
        updated = await this.dependencies.state.updateRepositoryChatProject(current.fullName, binding.projectUrl);
        this.emit({ type: "progress", repository: current.fullName, message: `Created and bound ChatGPT Project for ${current.fullName}.` });
      } else if (current.chatgptProjectUrl !== binding.projectUrl) {
        updated = await this.dependencies.state.replaceRepositoryChatProject(current.fullName, current.chatgptProjectUrl, binding.projectUrl);
        this.emit({ type: "progress", repository: current.fullName, message: `Recreated the missing ChatGPT Project for ${current.fullName}; stale PR conversation bindings were cleared.` });
      }
      if (!updated.chatgptProjectUrl) throw new Error(`Could not bind a ChatGPT Project to ${current.fullName}.`);
      return updated.chatgptProjectUrl;
    })();

    this.repositoryProjectPromises.set(key, execution);
    try {
      return await execution;
    } finally {
      if (this.repositoryProjectPromises.get(key) === execution) this.repositoryProjectPromises.delete(key);
    }
  }

  private async bindPullRequestConversation(record: ReviewRecord, conversationUrl: string): Promise<void> {
    const current = this.dependencies.state.getPullRequestChatConversation(record.repository, record.prNumber);
    if (current && current !== conversationUrl) {
      throw new Error(`ChatGPT conversation changed unexpectedly for ${record.repository} PR #${record.prNumber}. Each PR must stay in one conversation.`);
    }

    const created = !current;
    const updated = current
      ? this.dependencies.state.getRepository(record.repository)
      : await this.dependencies.state.updatePullRequestChatConversation(record.repository, record.prNumber, conversationUrl);
    const canonical = updated?.chatgptPrConversations.find((binding) => binding.prNumber === record.prNumber)?.conversationUrl ?? current;
    if (!canonical) throw new Error(`Could not bind a ChatGPT conversation to ${record.repository} PR #${record.prNumber}.`);
    record.conversationUrl = canonical;
    if (created) {
      this.emit({
        type: "progress",
        reviewId: record.id,
        taskId: record.taskId,
        repository: record.repository,
        prNumber: record.prNumber,
        phase: record.phase,
        message: `Created and bound ChatGPT conversation for ${record.repository} PR #${record.prNumber} inside its repository Project.`,
      });
    }
  }

  private async rebindStalePullRequestConversation(
    record: ReviewRecord,
    expectedConversationUrl: string,
    conversationUrl: string,
  ): Promise<void> {
    const updated = await this.dependencies.state.replacePullRequestChatConversation(
      record.repository,
      record.prNumber,
      expectedConversationUrl,
      conversationUrl,
    );
    const canonical = updated.chatgptPrConversations.find((binding) => binding.prNumber === record.prNumber)?.conversationUrl;
    if (!canonical) throw new Error(`Could not recover the ChatGPT conversation for ${record.repository} PR #${record.prNumber}.`);
    record.conversationUrl = canonical;
    this.emit({
      type: "progress",
      reviewId: record.id,
      taskId: record.taskId,
      repository: record.repository,
      prNumber: record.prNumber,
      phase: record.phase,
      message: `Created and bound a new ChatGPT conversation for ${record.repository} PR #${record.prNumber} inside its repository Project.`,
    });
  }

  private async acquireReviewSlot(): Promise<void> {
    if (this.activeReviewCount < MAX_CONCURRENT_REVIEWS) {
      this.activeReviewCount += 1;
      return;
    }
    await new Promise<void>((resolve) => this.reviewSlotWaiters.push(resolve));
    this.activeReviewCount += 1;
  }

  private releaseReviewSlot(): void {
    this.activeReviewCount = Math.max(0, this.activeReviewCount - 1);
    const next = this.reviewSlotWaiters.shift();
    next?.();
  }

  private async waitForExactHeadCi(
    record: ReviewRecord,
    expectedHeadSha: string,
    discoveryGraceMs = CI_DISCOVERY_GRACE_MS,
    purpose: "before-review" | "before-publish" = "before-review",
  ): Promise<GitHubPullRequestGate> {
    await this.setPhase(
      record,
      "waiting-ci",
      purpose === "before-review"
        ? `Waiting for all GitHub CI checks on exact head ${expectedHeadSha.slice(0, 12)} to finish before review.`
        : `Re-checking GitHub CI on exact head ${expectedHeadSha.slice(0, 12)} before publishing the review result.`,
    );
    const startedAt = Date.now();
    let stableSince = 0;
    let stableFingerprint = "";

    while (true) {
      this.assertNotCancelled(record);
      const gate = await this.dependencies.github.getPullRequestGate(record.repository, record.prNumber);
      if (gate.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
        await this.cancelSupersededReview(record, gate.headSha);
        throw new Error("Review superseded by a newer PR head.");
      }

      record.githubGate = gate;
      record.updatedAt = new Date().toISOString();
      await this.dependencies.state.upsertReview(record);

      const elapsed = Date.now() - startedAt;
      if (!gate.checks.length) {
        stableFingerprint = "";
        stableSince = 0;
        if (elapsed >= discoveryGraceMs) {
          this.emit({
            type: "progress",
            reviewId: record.id,
            taskId: record.taskId,
            repository: record.repository,
            prNumber: record.prNumber,
            phase: "waiting-ci",
            message: `No GitHub CI checks were registered for exact head ${expectedHeadSha.slice(0, 12)} after the discovery grace period; continuing review.`,
          });
          return gate;
        }
        this.emit({
          type: "progress",
          reviewId: record.id,
          taskId: record.taskId,
          repository: record.repository,
          prNumber: record.prNumber,
          phase: "waiting-ci",
          message: `Waiting for GitHub CI checks to register for exact head ${expectedHeadSha.slice(0, 12)}.`,
        });
      } else if (!gate.allChecksComplete) {
        stableFingerprint = "";
        stableSince = 0;
        const pending = gate.checks.filter((check) => check.status !== "COMPLETED").length;
        this.emit({
          type: "progress",
          reviewId: record.id,
          taskId: record.taskId,
          repository: record.repository,
          prNumber: record.prNumber,
          phase: "waiting-ci",
          message: `Waiting for ${pending}/${gate.checks.length} GitHub CI check(s) on exact head ${expectedHeadSha.slice(0, 12)}.`,
        });
      } else {
        const fingerprint = ciGateFingerprint(gate);
        if (fingerprint !== stableFingerprint) {
          stableFingerprint = fingerprint;
          stableSince = Date.now();
          this.emit({
            type: "progress",
            reviewId: record.id,
            taskId: record.taskId,
            repository: record.repository,
            prNumber: record.prNumber,
            phase: "waiting-ci",
            message: `All ${gate.checks.length} GitHub CI check(s) are terminal; waiting briefly for dependent checks to register.`,
          });
        } else if (Date.now() - stableSince >= CI_SETTLE_MS) {
          this.emit({
            type: "progress",
            reviewId: record.id,
            taskId: record.taskId,
            repository: record.repository,
            prNumber: record.prNumber,
            phase: "waiting-ci",
            message: purpose === "before-review"
              ? `Exact-head CI finished with ${gate.ciConclusion}; GitHub mergeable=${gate.mergeable}. Starting review.`
              : `Exact-head CI re-check finished with ${gate.ciConclusion}; GitHub mergeable=${gate.mergeable}. Finalizing review output.`,
          });
          return gate;
        }
      }

      if (elapsed >= CI_WAIT_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for all GitHub CI checks on exact head ${expectedHeadSha.slice(0, 12)} to finish.`);
      }
      await sleep(CI_POLL_INTERVAL_MS);
    }
  }

  private async cancelSupersededReview(record: ReviewRecord, currentHeadSha: string): Promise<void> {
    this.cancelledTasks.add(record.taskId);
    const now = new Date().toISOString();
    record.status = "cancelled";
    record.phase = "cancelled";
    record.error = `Review superseded: expected head ${record.headSha.slice(0, 12)}, current GitHub head is ${currentHeadSha.slice(0, 12)}.`;
    record.updatedAt = now;
    record.completedAt = now;
    await this.dependencies.state.upsertReview(record);
    this.emit({
      type: "state",
      reviewId: record.id,
      taskId: record.taskId,
      repository: record.repository,
      prNumber: record.prNumber,
      phase: "cancelled",
      message: record.error,
    });
  }

  private async setPhase(record: ReviewRecord, phase: ReviewPhase, message: string): Promise<void> {
    this.assertNotCancelled(record);
    record.status = phase === "blocked" ? "blocked" : phase === "failed" ? "failed" : phase === "cancelled" ? "cancelled" : phase === "completed" ? "completed" : "running";
    record.phase = phase;
    record.updatedAt = new Date().toISOString();
    await this.dependencies.state.upsertReview(record);
    this.emit({ type: "state", reviewId: record.id, taskId: record.taskId, repository: record.repository, prNumber: record.prNumber, phase, message });
  }

  private assertNotCancelled(record: ReviewRecord): void {
    if (this.cancelledTasks.has(record.taskId) || this.dependencies.state.getReview(record.id)?.status === "cancelled") {
      throw new Error("Review cancelled by user.");
    }
  }

  private async block(record: ReviewRecord, reason: string): Promise<ReviewRecord> {
    this.assertNotCancelled(record);
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

function ciGateFingerprint(gate: GitHubPullRequestGate): string {
  return gate.checks
    .map((check) => [check.workflow, check.name, check.status, check.conclusion].join("\u0000"))
    .sort()
    .join("\u0001");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableJiraFormatError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "ChatGPT did not return a [JIRA_CONTEXT] block."
    || error.message.startsWith("Jira context JSON is invalid:")
    || error.message === "Jira issue context is invalid.";
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message.replace(/[\r\n]+/g, " ").slice(0, 2000) : "Unknown review error.";
}
