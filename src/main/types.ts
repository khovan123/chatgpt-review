export type ReviewStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export type ReviewPhase = "queued" | "collecting-pr" | "resolving-jira" | "retrieving-spec" | "reviewing-diff" | "synthesizing" | "posting-comment" | "completed" | "blocked" | "failed" | "cancelled";
export type RepositoryWebhookStatus = "pending" | "healthy" | "error" | "disabled";

export interface ReviewConfig {
  autoReview: boolean;
  postComment: boolean;
  reviewDrafts: boolean;
  requireJiraWhenKeyPresent: boolean;
  maxDiffChunkBytes: number;
  cloudflareHostname: string;
  webhookPublicUrl: string;
  webhookListenHost: string;
  webhookListenPort: number;
}

export const DEFAULT_CONFIG: ReviewConfig = {
  autoReview: true,
  postComment: false,
  reviewDrafts: false,
  requireJiraWhenKeyPresent: true,
  maxDiffChunkBytes: 42_000,
  cloudflareHostname: "",
  webhookPublicUrl: "",
  webhookListenHost: "127.0.0.1",
  webhookListenPort: 8787,
};

export interface CloudflareZoneOption {
  zoneId: string;
  zoneName: string;
  accountId: string;
  accountName: string;
}

export interface CloudflareSetupSessionView {
  id: string;
  zones: CloudflareZoneOption[];
  expiresAt: string;
}

export interface CloudflareProvisioningRecord {
  mode: "api";
  accountId: string;
  accountName: string;
  zoneId: string;
  zoneName: string;
  tunnelId: string;
  tunnelName: string;
  dnsRecordId: string;
  hostname: string;
  provisionedAt: string;
}

export interface ChatGptPrConversationBinding {
  prNumber: number;
  conversationUrl: string;
  updatedAt: string;
}

export interface RepositoryRecord {
  id: string;
  fullName: string;
  addedAt: string;
  enabled: boolean;
  chatgptProjectUrl?: string;
  chatgptPrConversations: ChatGptPrConversationBinding[];
  webhook: {
    hookId: number | null;
    targetUrl: string;
    status: RepositoryWebhookStatus;
    lastDeliveryAt?: string;
    lastEvent?: string;
    lastError?: string;
  };
}

export interface PullRequestSummary {
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
  headSha: string;
  headBranch: string;
  baseBranch: string;
  isDraft: boolean;
  state: string;
  author: string;
  changedFiles: number;
}

export interface JiraIssueContext {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  status: string;
}

export interface JiraResolution {
  primaryKey: string | null;
  status: "resolved" | "not-found" | "unavailable" | "no-key";
  issues: JiraIssueContext[];
  notes: string;
  raw: string;
}

export interface SpecChunk {
  id: string;
  documentId: string;
  documentName: string;
  index: number;
  text: string;
  terms: Record<string, number>;
}

export interface SpecDocument {
  id: string;
  name: string;
  hash: string;
  bytes: number;
  addedAt: string;
  chunkCount: number;
  chunks: SpecChunk[];
}

export interface SpecDocumentView {
  id: string;
  name: string;
  hash: string;
  bytes: number;
  addedAt: string;
  chunkCount: number;
}

export interface RetrievedSpecChunk {
  documentId: string;
  documentName: string;
  chunkId: string;
  score: number;
  text: string;
}

export interface ReviewFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  file: string;
  line: number | null;
  title: string;
  explanation: string;
  evidence: string;
  jiraRef: string;
  specRef: string;
  suggestion: string;
  impact?: string;
  reproduction?: string;
  regressionTests?: string;
}

export interface OcrReviewMetadata {
  mode: "managed" | "delegation";
  version: string;
  schemaVersion: string;
  status: string;
  model: string;
  sessionId: string;
  totalFiles: number;
  reviewableFiles: number;
  excludedFiles: number;
  reviewedFiles: number;
  toolCalls: number;
  toolCallFailures: number;
  excluded: Array<{ path: string; reason: string }>;
}

export type GitHubPullRequestReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface ParsedReviewResult {
  verdict: "PASS" | "CHANGES_REQUESTED" | "BLOCKED";
  summary: string;
  jiraAlignment: string;
  specAlignment: string;
  testAssessment: string;
  findings: ReviewFinding[];
}

export interface ReviewRecord {
  id: string;
  taskId: string;
  repository: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headSha: string;
  status: ReviewStatus;
  phase: ReviewPhase;
  jiraKeys: string[];
  jira?: JiraResolution;
  specDocumentIds: string[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  conversationUrl?: string;
  rawReview?: string;
  result?: ParsedReviewResult;
  ocr?: OcrReviewMetadata;
  commentPosted?: boolean;
  trigger?: string;
  error?: string;
}

export interface WebhookDeliveryRecord {
  deliveryId: string;
  payloadSha256: string;
  repository: string;
  event: string;
  action: string;
  prNumber: number | null;
  headSha: string | null;
  receivedAt: string;
}

export interface PersistedState {
  version: 4;
  config: ReviewConfig;
  cloudflareProvisioning: CloudflareProvisioningRecord | null;
  repositories: RepositoryRecord[];
  reviews: ReviewRecord[];
  webhookDeliveries: WebhookDeliveryRecord[];
}

export interface WebhookRuntimeStatus {
  listening: boolean;
  localUrl: string;
  publicUrl: string;
  lastError?: string;
}

export interface CloudflareTunnelRuntimeStatus {
  installed: boolean;
  configured: boolean;
  running: boolean;
  reachable: boolean;
  mode: "named-token";
  originUrl: string;
  hostname: string;
  publicUrl: string;
  version?: string;
  restartCount: number;
  lastError?: string;
}

export interface AppView {
  config: ReviewConfig;
  cloudflareProvisioning: CloudflareProvisioningRecord | null;
  specs: SpecDocumentView[];
  reviews: ReviewRecord[];
  repositories: RepositoryRecord[];
  provider: {
    ghInstalled: boolean;
    ghAuthenticated: boolean;
    detail: string;
  };
  ocr: {
    installed: boolean;
    version: string;
    detail: string;
  };
  chatgpt: {
    ready: boolean;
  };
  prs: PullRequestSummary[];
  webhook: WebhookRuntimeStatus;
  tunnel: CloudflareTunnelRuntimeStatus;
}
