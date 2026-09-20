import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { OcrReviewMetadata, ParsedReviewResult, PullRequestSummary, ReviewFinding } from "./types";
import type { OcrChatGptGatewayBinding } from "./ocr-chatgpt-gateway";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const OCR_BACKGROUND_BYTES = 7_500;
const OCR_MAX_TOKENS = 24_000;
const OCR_REVIEW_TIMEOUT_MINUTES = 30;
const OCR_LLM_TIMEOUT_SECONDS = 600;

export interface OpenCodeReviewPreviewFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  willReview: boolean;
  excludeReason: string;
}

export interface OpenCodeReviewPreview {
  totalFiles: number;
  reviewableCount: number;
  excludedCount: number;
  totalInsertions: number;
  totalDeletions: number;
  files: OpenCodeReviewPreviewFile[];
}

export interface OpenCodeReviewComment {
  path: string;
  content: string;
  startLine: number | null;
  endLine: number | null;
  existingCode: string;
  suggestionCode: string;
  thinking: string;
  severity: string;
  category: string;
}

export interface OpenCodeReviewRunOutput {
  status: string;
  message: string;
  sessionId: string;
  provider: string;
  model: string;
  filesReviewed: number;
  commentCount: number;
  totalTokens: number;
  toolCallsTotal: number;
  toolCallsFailure: number;
  terminalState: string;
  selectedCount: number;
  completedCount: number;
  failedCount: number;
  waivedCount: number;
  comments: OpenCodeReviewComment[];
  warnings: string[];
}

export interface OpenCodeReviewManagedReview {
  version: string;
  preview: OpenCodeReviewPreview;
  output: OpenCodeReviewRunOutput;
  metadata: OcrReviewMetadata;
  result: ParsedReviewResult;
  raw: string;
}

export class OpenCodeReviewProvider {
  async status(): Promise<{ installed: boolean; version: string; detail: string }> {
    try {
      const raw = await runOcr(["--version"]);
      const version = raw.match(/open-code-review\s+v([^\s]+)/i)?.[1] ?? "unknown";
      return { installed: true, version, detail: `OpenCodeReview v${version} managed-agent mode is ready.` };
    } catch (error) {
      return { installed: false, version: "", detail: safeError(error) };
    }
  }

  async reviewPullRequest(
    repository: string,
    pr: PullRequestSummary,
    background: string,
    gateway: OcrChatGptGatewayBinding,
  ): Promise<OpenCodeReviewManagedReview> {
    assertRepository(repository);
    assertPullRequest(pr);
    assertGateway(gateway);

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "chatgpt-review-ocr-"));
    const checkout = path.join(tempRoot, "repository");
    const ocrHome = path.join(tempRoot, "ocr-home");
    const outputPath = path.join(tempRoot, "review-result.json");

    try {
      await checkoutPullRequest(repository, pr, checkout);
      const versionStatus = await this.status();
      if (!versionStatus.installed) throw new Error(versionStatus.detail);

      const boundedBackground = truncateUtf8(background.trim(), OCR_BACKGROUND_BYTES);
      const rangeArgs = ["--from", `origin/${pr.baseBranch}`, "--to", pr.headSha];

      const ocrEnvironment = managedOcrEnvironment(gateway, ocrHome);
      const previewArgs = ["review", "--preview", "--format", "json", "--audience", "agent", ...rangeArgs];
      if (boundedBackground) previewArgs.push("--background", boundedBackground);
      const preview = parseOpenCodeReviewPreview(await runOcr(previewArgs, checkout, ocrEnvironment));

      const reviewArgs = [
        "review",
        "--format", "json",
        "--audience", "agent",
        "--output", outputPath,
        "--concurrency", "1",
        "--effort", "medium",
        "--max-tokens", String(OCR_MAX_TOKENS),
        "--timeout", String(OCR_REVIEW_TIMEOUT_MINUTES),
        ...rangeArgs,
      ];
      if (boundedBackground) reviewArgs.push("--background", boundedBackground);

      await runOcr(
        reviewArgs,
        checkout,
        ocrEnvironment,
        OCR_REVIEW_TIMEOUT_MINUTES * 60_000 + 120_000,
      );
      const raw = await readFile(outputPath, "utf8");
      const output = parseOpenCodeReviewRunOutput(raw);
      const metadata = buildManagedMetadata(versionStatus.version, preview, output);
      const result = normalizeManagedReview(output, metadata);

      return { version: versionStatus.version, preview, output, metadata, result, raw };
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function parseOpenCodeReviewPreview(raw: string): OpenCodeReviewPreview {
  const parsed = parseJsonObject(raw, "OpenCodeReview preview");
  if (!Array.isArray(parsed.files)) throw new Error("OpenCodeReview preview files are invalid.");
  const files = parsed.files.map((value, index): OpenCodeReviewPreviewFile => {
    if (!isRecord(value)) throw new Error(`OpenCodeReview preview file ${index + 1} is invalid.`);
    const willReview = value.will_review === true;
    return {
      path: requiredText(value.path, "OpenCodeReview file path", 4096),
      status: requiredText(value.status, "OpenCodeReview file status", 128),
      insertions: safeCount(value.insertions, 0),
      deletions: safeCount(value.deletions, 0),
      willReview,
      excludeReason: willReview ? "" : optionalText(value.exclude_reason, 1024),
    };
  });
  return {
    totalFiles: safeCount(parsed.total_files, files.length),
    reviewableCount: safeCount(parsed.reviewable_count, files.filter((file) => file.willReview).length),
    excludedCount: safeCount(parsed.excluded_count, files.filter((file) => !file.willReview).length),
    totalInsertions: safeCount(parsed.total_insertions, 0),
    totalDeletions: safeCount(parsed.total_deletions, 0),
    files,
  };
}

export function parseOpenCodeReviewRunOutput(raw: string): OpenCodeReviewRunOutput {
  const parsed = parseJsonObject(raw, "OpenCodeReview managed review");
  const summary = isRecord(parsed.summary) ? parsed.summary : {};
  const llm = isRecord(parsed.llm) ? parsed.llm : {};
  const toolCalls = isRecord(parsed.tool_calls) ? parsed.tool_calls : {};
  const manifest = isRecord(parsed.manifest) ? parsed.manifest : {};
  const coverage = isRecord(manifest.coverage) ? manifest.coverage : {};
  const commentsValue = Array.isArray(parsed.comments) ? parsed.comments : [];
  const comments = commentsValue.map((value, index): OpenCodeReviewComment => {
    if (!isRecord(value)) throw new Error(`OpenCodeReview comment ${index + 1} is invalid.`);
    return {
      path: requiredText(value.path, "OpenCodeReview comment path", 4096),
      content: requiredText(value.content, "OpenCodeReview comment content", 40_000),
      startLine: nullableLine(value.start_line),
      endLine: nullableLine(value.end_line),
      existingCode: optionalText(value.existing_code, 20_000),
      suggestionCode: optionalText(value.suggestion_code, 20_000),
      thinking: optionalText(value.thinking, 20_000),
      severity: optionalText(value.severity, 64).toLowerCase(),
      category: optionalText(value.category, 64).toLowerCase(),
    };
  });

  return {
    status: optionalText(parsed.status, 128).toLowerCase() || "unknown",
    message: optionalText(parsed.message, 20_000),
    sessionId: optionalText(parsed.session_id, 512),
    provider: optionalText(llm.provider, 256),
    model: optionalText(llm.model, 256),
    filesReviewed: safeCount(summary.files_reviewed, 0),
    commentCount: safeCount(summary.comments, comments.length),
    totalTokens: safeCount(summary.total_tokens, 0),
    toolCallsTotal: safeCount(toolCalls.total, 0),
    toolCallsFailure: safeCount(toolCalls.failure, 0),
    terminalState: optionalText(manifest.terminal_state, 128).toLowerCase(),
    selectedCount: coverageCount(coverage.selected),
    completedCount: coverageCount(coverage.completed),
    failedCount: coverageCount(coverage.failed),
    waivedCount: coverageCount(coverage.waived),
    comments,
    warnings: parseWarnings(parsed.warnings),
  };
}

export function normalizeManagedReview(
  output: OpenCodeReviewRunOutput,
  metadata: OcrReviewMetadata,
): ParsedReviewResult {
  const findings = output.comments.map(normalizeComment);
  const blockingFindings = findings.filter((finding) => finding.severity !== "P3");
  const blockReasons: string[] = [];

  if (metadata.reviewableFiles > metadata.reviewedFiles) {
    blockReasons.push(`coverage ${metadata.reviewedFiles}/${metadata.reviewableFiles}`);
  }
  if (output.failedCount > 0) blockReasons.push(`${output.failedCount} OCR review subtask(s) failed`);
  if (output.toolCallsFailure > 0) blockReasons.push(`${output.toolCallsFailure} OCR tool call(s) failed`);
  if (output.terminalState && !["complete", "skipped"].includes(output.terminalState)) {
    blockReasons.push(`terminal state ${output.terminalState}`);
  }
  if (output.status.includes("error")) blockReasons.push(`status ${output.status}`);
  if (output.status === "skipped" && metadata.reviewableFiles > 0) {
    blockReasons.push("OCR skipped despite reviewable files");
  }

  const verdict: ParsedReviewResult["verdict"] = blockReasons.length
    ? "BLOCKED"
    : blockingFindings.length
      ? "CHANGES_REQUESTED"
      : "PASS";

  const summary = blockReasons.length
    ? `OpenCodeReview managed review is incomplete: ${blockReasons.join("; ")}.`
    : `OpenCodeReview managed review completed ${metadata.reviewedFiles}/${metadata.reviewableFiles} selected file(s) with ${findings.length} finding(s).`;

  return {
    verdict,
    summary,
    jiraAlignment: "Jira evidence, when resolved, was supplied to OpenCodeReview as supplemental review background.",
    specAlignment: "Retrieved spec memory, when available, was supplied to OpenCodeReview as supplemental review background.",
    testAssessment: findings.some((finding) => /test/i.test(finding.title) || /test/i.test(finding.explanation))
      ? "OpenCodeReview reported test-related review findings; see findings below."
      : "No separate test execution was performed by chatgpt-review; test-related issues come from OpenCodeReview analysis.",
    findings,
  };
}

function normalizeComment(comment: OpenCodeReviewComment): ReviewFinding {
  const severity = mapSeverity(comment.severity, comment.category);
  const range = comment.startLine === null
    ? comment.path
    : comment.endLine && comment.endLine !== comment.startLine
      ? `${comment.path}:${comment.startLine}-${comment.endLine}`
      : `${comment.path}:${comment.startLine}`;
  return {
    severity,
    file: comment.path,
    line: comment.startLine,
    title: findingTitle(comment.content),
    explanation: comment.content,
    evidence: comment.existingCode
      ? `OpenCodeReview finding at ${range}. Existing code:\n${comment.existingCode}`
      : `OpenCodeReview managed-agent finding at ${range}.`,
    jiraRef: "",
    specRef: "",
    suggestion: comment.suggestionCode
      ? `Suggested replacement:\n${comment.suggestionCode}`
      : "Address the concrete issue identified by OpenCodeReview and add regression coverage where applicable.",
    impact: severity === "P0" || severity === "P1"
      ? "OpenCodeReview classified this as a high-impact finding."
      : severity === "P2"
        ? "OpenCodeReview classified this as a meaningful correctness or maintainability risk."
        : undefined,
    reproduction: comment.startLine === null ? undefined : `Inspect the changed behavior around ${range} and exercise the scenario described by the OCR finding.`,
    regressionTests: severity === "P3" ? undefined : "Add a focused regression test that fails before the fix and passes after it.",
  };
}

function mapSeverity(severity: string, category: string): ReviewFinding["severity"] {
  switch (severity) {
    case "critical": return "P0";
    case "high": return "P1";
    case "medium": return "P2";
    case "low": return "P3";
    default: return category === "style" || category === "documentation" ? "P3" : "P2";
  }
}

function findingTitle(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const sentence = firstLine.match(/^(.{1,140}?)(?:[.!?](?:\s|$)|$)/)?.[1]?.trim() ?? firstLine;
  if (!sentence) return "OpenCodeReview finding";
  return sentence.length > 140 ? `${sentence.slice(0, 137)}…` : sentence;
}

function buildManagedMetadata(
  version: string,
  preview: OpenCodeReviewPreview,
  output: OpenCodeReviewRunOutput,
): OcrReviewMetadata {
  const reviewedFiles = Math.max(output.filesReviewed, output.completedCount + Math.max(0, output.waivedCount));
  return {
    mode: "managed",
    version,
    schemaVersion: "ocr-review-json",
    status: output.status,
    model: output.model || "chatgpt-web",
    sessionId: output.sessionId,
    totalFiles: preview.totalFiles,
    reviewableFiles: preview.reviewableCount,
    excludedFiles: preview.excludedCount,
    reviewedFiles: Math.min(preview.reviewableCount, reviewedFiles),
    toolCalls: output.toolCallsTotal,
    toolCallFailures: output.toolCallsFailure,
    excluded: preview.files
      .filter((file) => !file.willReview)
      .slice(0, 200)
      .map((file) => ({ path: file.path, reason: file.excludeReason || "excluded" })),
  };
}

async function checkoutPullRequest(repository: string, pr: PullRequestSummary, checkout: string): Promise<void> {
  await runCommand("gh", ["repo", "clone", repository, checkout, "--", "--no-checkout", "--filter=blob:none"], undefined, 180_000);
  const baseRef = `refs/remotes/origin/${pr.baseBranch}`;
  const pullRef = `refs/remotes/origin/chatgpt-review-pr-${pr.number}`;
  await runCommand("git", [
    "-C", checkout, "fetch", "--no-tags", "origin",
    `+refs/heads/${pr.baseBranch}:${baseRef}`,
    `+refs/pull/${pr.number}/head:${pullRef}`,
  ], undefined, 180_000);
  const fetchedHead = (await runCommand("git", ["-C", checkout, "rev-parse", pullRef])).trim().toLowerCase();
  if (fetchedHead !== pr.headSha.toLowerCase()) {
    throw new Error(`OpenCodeReview checkout head mismatch: expected ${pr.headSha}, fetched ${fetchedHead || "unknown"}.`);
  }
  await runCommand("git", ["-C", checkout, "checkout", "--detach", pr.headSha], undefined, 120_000);
}

async function runOcr(
  args: string[],
  cwd?: string,
  env: NodeJS.ProcessEnv = baseOcrEnvironment(),
  timeout = 30 * 60_000,
): Promise<string> {
  const launcher = require.resolve("@alibaba-group/open-code-review/bin/ocr.js");
  return runCommand(process.execPath, [launcher, ...args], cwd, timeout, env);
}

async function runCommand(
  program: string,
  args: string[],
  cwd?: string,
  timeout = 120_000,
  env: NodeJS.ProcessEnv = repositoryEnvironment(),
): Promise<string> {
  try {
    const result = await execFileAsync(program, args, { cwd, encoding: "utf8", timeout, maxBuffer: MAX_COMMAND_OUTPUT, env });
    return result.stdout;
  } catch (error) {
    throw new Error(`${program} failed: ${safeError(error)}`);
  }
}

function managedOcrEnvironment(gateway: OcrChatGptGatewayBinding, home: string): NodeJS.ProcessEnv {
  return {
    ...baseOcrEnvironment(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    OCR_LLM_URL: `${gateway.baseUrl}/chat/completions`,
    OCR_LLM_TOKEN: gateway.token,
    OCR_LLM_MODEL: gateway.model,
    OCR_LLM_PROTOCOL: "openai",
    OCR_USE_ANTHROPIC: "false",
    OCR_LLM_TIMEOUT: String(OCR_LLM_TIMEOUT_SECONDS),
  };
}

function baseOcrEnvironment(): NodeJS.ProcessEnv {
  return { ...runtimeEnvironment(), ELECTRON_RUN_AS_NODE: "1", OCR_NO_UPDATE: "1" };
}

function repositoryEnvironment(): NodeJS.ProcessEnv {
  return {
    ...runtimeEnvironment(),
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
  };
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GH_HOST: process.env.GH_HOST,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
    GIT_ASKPASS: process.env.GIT_ASKPASS,
    SSH_ASKPASS: process.env.SSH_ASKPASS,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
  };
}

function parseWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((warning) => {
    if (typeof warning === "string") return warning.slice(0, 4000);
    if (isRecord(warning)) return JSON.stringify(warning).slice(0, 4000);
    return String(warning).slice(0, 4000);
  });
}

function coverageCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return safeCount(value, 0);
}

function nullableLine(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseJsonObject(raw: string, label: string): Record<string, any> {
  try {
    const value = JSON.parse(raw);
    if (!isRecord(value)) throw new Error("root value is not an object");
    return value;
  } catch (error) {
    throw new Error(`${label} JSON is invalid: ${safeError(error)}`);
  }
}

function safeCount(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Repository must use owner/name format.");
}

function assertPullRequest(pr: PullRequestSummary): void {
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error("Pull request number is invalid.");
  requiredSha(pr.headSha, "pull request head");
  if (!pr.baseBranch.trim() || /[\r\n]/.test(pr.baseBranch)) throw new Error("Pull request base branch is invalid.");
}

function assertGateway(gateway: OcrChatGptGatewayBinding): void {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(gateway.baseUrl)) throw new Error("OCR ChatGPT Web gateway URL is invalid.");
  if (!gateway.token || gateway.token.length < 32) throw new Error("OCR ChatGPT Web gateway token is invalid.");
  if (gateway.model !== "chatgpt-web") throw new Error("OCR ChatGPT Web gateway model is invalid.");
}

function requiredSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /\0/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function optionalText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  const suffix = "…";
  const payload = encoded.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8")));
  return `${payload.toString("utf8").replace(/\uFFFD+$/g, "")}${suffix}`;
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.replace(/[\r\n]+/g, " ").slice(0, 4000);
  return "Unknown OpenCodeReview error.";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
