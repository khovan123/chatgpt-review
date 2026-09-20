# ChatGPT Review

Desktop PR-review app that uses **OpenCodeReview managed-agent mode** for code review and **ChatGPT Web** as a local OpenAI-compatible LLM backend. OCR owns file selection, grouping, repository tool calls, code navigation, filtering, findings, sessions and coverage. Jira evidence and attached specification memory are supplemental review background.nistic review selection/rules and **ChatGPT Web** for model reasoning. Reviews are event-driven from signed GitHub webhooks. Code/diff evidence is primary; Jira evidence and attached specification memory are supplemental requirement context. No separate OCR model/API key is required.

## Event-driven flow

There is no recurring PR polling loop.

```text
GitHub pull_request webhook
  -> user's personal Cloudflare named tunnel
  -> signed local webhook ingress
  -> delivery idempotency check
  -> linked repository lookup
  -> re-read exact PR + current head SHA through gh
  -> repository-scoped ChatGPT Project
  -> PR-scoped canonical ChatGPT conversation
  -> Jira key mapping from PR title/description
  -> Jira evidence through ChatGPT Atlassian connector
  -> relevant spec-memory retrieval (optional)
  -> temporary exact-head Git checkout
  -> temporary exact-head Git checkout
  -> local authenticated OpenAI-compatible gateway backed by ChatGPT Web
  -> ocr review --format json --audience agent
  -> OCR-managed grouping + repository tool-call loop + filtering
  -> OCR run manifest / coverage / tool-call validation
  -> normalize OCR findings to app verdict
  -> optional GitHub Pull Request Review (APPROVE / REQUEST_CHANGES; COMMENT fallback for self-review)
```

Automatic review triggers on `pull_request` actions that can materially change review evidence: `opened`, `reopened`, `synchronize`, `ready_for_review`, and `edited`. `closed` updates the active PR list but does not run a review. A webhook head SHA that no longer matches GitHub's current PR head is ignored as stale.

## Repository management

The app manages multiple repositories. Linking a repository validates access through the authenticated `gh` CLI and automatically creates or updates its GitHub `pull_request` webhook using `gh api`. Unlinking attempts to remove the managed hook.

Each repository stores its webhook id/health, last delivery/event/error, open PRs, and review history. Repository linking is blocked until the user's personal Cloudflare route has been verified end to end.

## Personal Cloudflare named tunnel

Public webhook ingress is intentionally **per user**. The app does not provision or use a shared server-side Cloudflare account/tunnel and it never falls back to Cloudflare Quick Tunnels (`*.trycloudflare.com`).

### Automatic first-time provisioning

The default onboarding uses a **one-time Cloudflare API token owned by the user**. The token should be scoped only to the Cloudflare account/zones the user wants this installation to manage, with:

- Account → Cloudflare Tunnel → Edit;
- Zone → DNS → Edit;
- Zone → Zone → Read.

In **Settings → Connections** the user pastes the API token and selects **Discover zones**. The token is sent only to the Electron main process, kept only in an in-memory setup session, automatically erased after 10 minutes if unused, consumed when provisioning starts, and never written to application state or returned to the renderer.

After the user selects one discovered zone and an optional hostname label, the app performs the complete Cloudflare bootstrap inside that user's account:

1. verifies the requested hostname is not already occupied;
2. creates a remotely-managed **Named Tunnel**;
3. writes the remote tunnel ingress configuration so the selected hostname proxies to the local webhook origin (default `http://127.0.0.1:8787`) with a final `http_status:404` catch-all rule;
4. creates a proxied CNAME `<hostname> -> <tunnel-id>.cfargotunnel.com`;
5. obtains the named tunnel **runtime token**;
6. persists only the Cloudflare resource identifiers needed for deterministic cleanup (account, zone, tunnel and DNS record ids);
7. stores the runtime tunnel token outside the repository with app-owned permissions;
8. starts `cloudflared` with `--token-file`;
9. replaces `HOME` / `USERPROFILE` with an isolated app-owned directory, preventing fallback to `~/.cloudflared`, `cert.pem`, or another Cloudflare account already authenticated on the machine;
10. verifies `https://<hostname>/healthz` reaches this exact application;
11. derives the GitHub webhook endpoint as `https://<hostname>/webhooks/v1/github`;
12. only then allows repositories to be linked and their GitHub webhooks to be created/synchronized.

If a Cloudflare API call fails during provisioning, resources already created by that attempt are rolled back when possible. If the Cloudflare resources were successfully created but the local `cloudflared` process or public health check is not ready yet, the resource metadata and runtime token remain local so the connector can be restarted without asking for the provisioning API token again.

The provisioning API token is **not retained for runtime**. If the user later chooses **Delete tunnel + DNS**, the UI asks for a fresh user-owned API token and deletes exactly the persisted DNS record and named tunnel before removing the local runtime token.

While a named tunnel is connected, the local webhook host/port is locked because the remote ingress configuration points at that origin. Disconnect/deprovision before changing it.

### Existing named tunnel (advanced)

Users who already own a remotely-managed named tunnel can still use **Advanced: connect an existing remotely-managed named tunnel** and supply its hostname plus runtime token. The same isolated `cloudflared` runtime, Quick-Tunnel rejection and end-to-end health verification apply.

The local listener defaults to:

```text
http://127.0.0.1:8787
```


## Remote web administration

The same local listener that receives GitHub webhooks also exposes an authenticated remote admin UI at:

```text
https://<cloudflare-hostname>/admin
```

This is intended for VPS deployments so the worker can be managed without VNC for day-to-day operations. The remote page uses a separate app-generated 32-byte token stored outside the repository at the Electron user-data path as `remote-admin-token`. On the VPS, read it as the service user, for example:

```bash
runuser -u chatgpt-review -- cat "/home/chatgpt-review/.config/ChatGPT Review/remote-admin-token"
```

Remote admin capabilities are deliberately bounded and token-protected:

- view GitHub, ChatGPT, webhook and Cloudflare readiness;
- authenticate `gh` by pasting a GitHub token once into `gh auth login --with-token`;
- link/unlink repositories and synchronize their GitHub webhooks;
- refresh open PRs;
- trigger or force re-run a review;
- cancel queued/running reviews;
- restart the configured Cloudflare tunnel;
- run the fixed project build command (`npm run build`) and return bounded output.

The remote UI does not expose arbitrary shell execution. ChatGPT sign-in and connector setup still happen inside the app-owned Electron ChatGPT session; the remote button opens that setup window on the VPS display when manual sign-in/connector repair is needed.

## Webhook security

- app-generated 32-byte GitHub webhook secret stored outside the repository;
- GitHub `X-Hub-Signature-256` HMAC-SHA256 validation over the exact raw body before JSON parsing;
- bounded `X-GitHub-Delivery` and `X-GitHub-Event` headers;
- 256 KiB request-body limit;
- delivery id + raw-body SHA-256 persisted for restart-safe idempotency;
- same delivery id with a different payload is rejected;
- unknown/unlinked repositories are rejected;
- exact current GitHub head SHA is re-read before automatic review.

## ChatGPT Web isolation and review lanes

No OpenAI API/model API is used. ChatGPT Web runs in a dedicated persistent Electron partition with `nodeIntegration: false`, `contextIsolation: true`, Chromium sandboxing, no preload bridge exposed to `chatgpt.com`, restricted navigation, task-bound structured responses, bounded prompts/responses, and secret redaction before diff content is sent.

The review context is isolated with these invariants:

- **1 linked repository = 1 ChatGPT Project**, named `PR Review - owner - repo`;
- new app-managed Projects are created with the current ChatGPT default memory setting; the app only manages the repository-to-Project binding and does not change the user's Project memory setting;
- **1 PR number = 1 canonical ChatGPT conversation** inside that repository Project; all later reviews of the same PR reuse that conversation;
- if a PR conversation no longer exists, the next review creates a replacement conversation inside the same repository Project and updates only that PR binding;
- if the repository Project no longer exists, the app recreates it, clears the stale PR-chat bindings, and lets each PR establish a new conversation inside the replacement Project;
- legacy pre-Project repository-wide conversation state is intentionally not promoted into the new model, preventing an old shared chat from contaminating multiple PRs.

Different PRs may review concurrently. Each active review gets its own hidden Electron `BrowserWindow` while all windows share the signed-in persistent ChatGPT session. Concurrency is bounded to **3 active reviews** to protect the VPS/browser session. The same PR is still serialized/coalesced so two review turns cannot race inside its canonical conversation. Project creation/recovery for the same repository is also serialized to prevent duplicate Projects.

## OpenCodeReview managed agent

The review engine pins `@alibaba-group/open-code-review` and runs the normal OCR-managed `ocr review` workflow. ChatGPT Web is exposed only on loopback through a short-lived bearer-authenticated OpenAI-compatible gateway; OCR sees it as the configured model endpoint and remains responsible for the agent loop.

For every PR review the app:

1. creates a temporary Git checkout through the authenticated `gh` CLI;
2. fetches the PR ref and base branch and verifies the fetched head SHA exactly matches the GitHub PR head already collected by the app;
3. runs `ocr review --preview --format json --audience agent` to capture deterministic selection/exclusions;
4. starts a loopback-only `/v1/chat/completions` gateway backed by the signed-in ChatGPT Web session;
5. runs `ocr review --format json --audience agent --from <base> --to <exact-head>` with OCR configured to use that gateway;
6. lets OCR perform grouping, full-file reads, code search, changed-file inspection, `code_comment`, `task_done`, filtering and session/manifest tracking;
7. parses OCR's JSON output, run manifest, coverage and tool-call counters directly — there is no second app-owned code-review synthesis prompt;
8. fails closed when selected-file coverage is incomplete, OCR reports failed subtasks, or any OCR tool call fails;
9. removes the temporary checkout and stops the gateway after the run.

The gateway does **not** execute OCR repository tools. It only converts OCR's OpenAI Chat Completions requests into bounded ChatGPT Web turns and converts the structured response back into native OpenAI `tool_calls`. This keeps OpenCodeReview, not chatgpt-review, in control of repository exploration and review decisions.

Jira and spec context are compact optional background. They do not replace code evidence and they do not decide which repository tools OCR calls.

## Jira mapping

Jira keys matching `PROJECT-123` are collected deterministically from PR title first and description second, with duplicates removed. When a key exists, ChatGPT must use the Atlassian/Jira connector and return exact issue context. Returned keys must match keys extracted from the PR. By default the review fails closed when a referenced Jira issue cannot be resolved.

## Spec memory / RAG

Attached PDF, DOCX, Markdown, text, JSON, YAML, CSV and source-text files are extracted and persisted as application-owned text chunks. Retrieval is local BM25-style lexical ranking with additional Jira-key relevance. No embedding/model API is required.

## UI

The primary UI follows the SourceNerve workspace pattern:

- sidebar CTA to add a repository;
- connected repository list with webhook health;
- selecting a repository shows its open PRs and auto-selects the first open non-draft PR;
- selecting a PR shows only that PR's review history;
- all external connection/configuration management lives inside the Settings modal;
- Cloudflare, GitHub, ChatGPT Web, review behavior, repositories, and spec memory are managed from Settings.

## Requirements

- Node.js 22.12+
- Git 2.41+
- bundled/pinned OpenCodeReview dependency installed by `npm install`
- `cloudflared` available on `PATH`
- a Cloudflare account with at least one active zone for automatic provisioning
- a one-time user-owned Cloudflare API token scoped to Cloudflare Tunnel Edit, DNS Edit, and Zone Read (or, in Advanced mode, an existing named-tunnel hostname + runtime token)
- authenticated GitHub CLI (`gh auth login`)
- GitHub permission to manage repository webhooks
- a ChatGPT Web account signed in inside the app review window
- Atlassian/Jira connector enabled in that ChatGPT session when Jira-backed review is required

## Run

```bash
npm install
npm test
npm run typecheck
npm run dev
```

Then:

1. Create a least-privilege Cloudflare API token in the user's own Cloudflare account.
2. In **Settings → Connections**, paste it once and select **Discover zones**. Choose a zone and optionally a hostname label, then select **Create tunnel + DNS + ingress**.
3. The app creates the named tunnel, ingress and DNS in that user's account, obtains/stores only the runtime tunnel token, discards the provisioning API token, starts `cloudflared`, and verifies the public route.
4. Open ChatGPT Web, sign in, and enable the Atlassian/Jira connector.
5. In **Settings → Repositories**, link one or more GitHub repositories. Their webhooks are created automatically against the verified personal endpoint, and the app creates/binds one ChatGPT Project for each repository.
6. Attach specification memory if needed.
7. The first review of each PR creates its own canonical conversation inside that repository Project; later reviews of that PR reuse it.
8. GitHub PR events trigger reviews directly through the signed webhook path, with up to three different PR reviews active concurrently.
9. Optionally enable posting completed reviews back to GitHub.

## Review state machine

```text
webhook/manual trigger
  -> queued
  -> collecting-pr
  -> resolving-jira
  -> retrieving-spec
  -> reviewing-diff (OCR managed agent + ChatGPT Web LLM gateway)
  -> OCR manifest / coverage / tool-call validation
  -> synthesizing (normalize OCR result only)
  -> posting-comment (optional)
  -> completed

Any review stage may -> blocked / failed
```
