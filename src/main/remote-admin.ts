import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { AppView } from "./types";
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
  triggerBuild: () => Promise<RemoteAdminBuildResult>;
}

export function createRemoteAdminHandler(dependencies: RemoteAdminDependencies): ExtraHttpHandler {
  return async (request, response, requestUrl) => {
    if (!requestUrl.pathname.startsWith("/admin")) return false;
    try {
      if (request.method === "GET" && (requestUrl.pathname === "/admin" || requestUrl.pathname === "/admin/")) {
        writeHtml(response, renderAdminHtml());
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
        writeJson(response, 200, await dependencies.getView());
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

function renderAdminHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ChatGPT Review Remote Admin</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f0f0f; color: #f5f5f5; }
    body { margin: 0; padding: 24px; background: #0f0f0f; }
    h1, h2, h3 { margin: 0 0 12px; }
    button, input { font: inherit; }
    input { background: #171717; border: 1px solid #3a3a3a; color: #f5f5f5; border-radius: 10px; padding: 10px 12px; min-width: 220px; }
    button { border: 1px solid #444; background: #242424; color: #fff; border-radius: 10px; padding: 10px 12px; cursor: pointer; }
    button.primary { background: #2c7be5; border-color: #2c7be5; }
    button.danger { background: #5c1d1d; border-color: #8f3434; }
    button:disabled { opacity: 0.55; cursor: wait; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .card { background: #171717; border: 1px solid #2d2d2d; border-radius: 16px; padding: 16px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
    .muted { color: #aaa; }
    .ok { color: #65d67f; }
    .bad { color: #ff8d8d; }
    .pill { border: 1px solid #3a3a3a; border-radius: 999px; padding: 2px 8px; font-size: 12px; color: #ccc; }
    .list { display: grid; gap: 10px; }
    .item { border: 1px solid #2b2b2b; border-radius: 12px; padding: 12px; background: #121212; }
    pre { white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; background: #0b0b0b; border: 1px solid #333; border-radius: 12px; padding: 12px; }
    a { color: #8ab4ff; }
  </style>
</head>
<body>
  <h1>ChatGPT Review Remote Admin</h1>
  <p class="muted">Manage the VPS review worker from another machine. API calls require the remote admin token.</p>

  <section class="card" id="auth-card">
    <h2>Access</h2>
    <div class="row">
      <input id="token" type="password" placeholder="Remote admin token" />
      <button class="primary" id="save-token">Save token</button>
      <button id="reload">Reload</button>
    </div>
    <p id="auth-message" class="muted">On the VPS, read the token from <code>~/.config/ChatGPT Review/remote-admin-token</code> for the <code>chatgpt-review</code> user.</p>
  </section>

  <main class="grid">
    <section class="card">
      <h2>Status</h2>
      <div id="status" class="list"></div>
    </section>

    <section class="card">
      <h2>GitHub setup</h2>
      <p class="muted">Paste a GitHub token once. The app passes it to <code>gh auth login --with-token</code>; it is not stored by this web UI.</p>
      <div class="row">
        <input id="github-token" type="password" placeholder="GitHub token" />
        <button id="github-auth">Authenticate gh</button>
      </div>
    </section>

    <section class="card">
      <h2>ChatGPT setup</h2>
      <p class="muted">This opens the ChatGPT setup window on the VPS display/session. Use it when the worker needs login or connector setup.</p>
      <button id="chatgpt-setup">Open ChatGPT setup</button>
    </section>

    <section class="card">
      <h2>Repository</h2>
      <div class="row">
        <input id="repo" placeholder="owner/repo" />
        <button id="repo-link">Link</button>
        <button id="repo-sync">Sync webhook</button>
        <button id="repo-unlink" class="danger">Unlink</button>
      </div>
      <button id="refresh-prs">Refresh PRs</button>
    </section>

    <section class="card">
      <h2>Operations</h2>
      <div class="row">
        <button id="cloudflare-restart">Restart Cloudflare tunnel</button>
        <button id="build-app">Run npm build</button>
      </div>
      <pre id="operation-output" class="muted"></pre>
    </section>
  </main>

  <section class="card" style="margin-top:16px">
    <h2>Pull requests</h2>
    <div id="prs" class="list"></div>
  </section>

  <section class="card" style="margin-top:16px">
    <h2>Recent reviews</h2>
    <div id="reviews" class="list"></div>
  </section>

<script>
const state = { view: null, busy: false };
const tokenInput = document.getElementById('token');
const initialToken = new URLSearchParams(location.search).get('token') || localStorage.getItem('chatgpt-review-admin-token') || '';
tokenInput.value = initialToken;
if (initialToken) localStorage.setItem('chatgpt-review-admin-token', initialToken);

document.getElementById('save-token').onclick = async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setAuthMessage('Paste the remote admin token first.', false);
    return;
  }
  localStorage.setItem('chatgpt-review-admin-token', token);
  setAuthMessage('Token saved locally. Loading remote admin state...', true);
  await load();
};
document.getElementById('reload').onclick = () => load();
document.getElementById('github-auth').onclick = () => post('/admin/api/github/auth', { token: value('github-token') });
document.getElementById('chatgpt-setup').onclick = () => post('/admin/api/chatgpt/setup', {});
document.getElementById('repo-link').onclick = () => post('/admin/api/repositories/link', { repository: repoValue() });
document.getElementById('repo-sync').onclick = () => post('/admin/api/repositories/sync-webhook', { repository: repoValue() });
document.getElementById('repo-unlink').onclick = () => post('/admin/api/repositories/unlink', { repository: repoValue() });
document.getElementById('refresh-prs').onclick = () => post('/admin/api/prs/refresh', { repository: value('repo') || undefined });
document.getElementById('cloudflare-restart').onclick = () => post('/admin/api/cloudflare/restart', {});
document.getElementById('build-app').onclick = async () => { const res = await post('/admin/api/system/build', {}, false); document.getElementById('operation-output').textContent = res.output || JSON.stringify(res, null, 2); await load(); };

function value(id) { return document.getElementById(id).value.trim(); }
function repoValue() { const repo = value('repo'); if (!repo) throw new Error('Repository is required.'); return repo; }
function adminToken() { return (localStorage.getItem('chatgpt-review-admin-token') || tokenInput.value || '').trim(); }
function withToken(path) {
  const token = adminToken();
  if (!token) return path;
  const separator = path.includes('?') ? '&' : '?';
  return path + separator + 'token=' + encodeURIComponent(token);
}
function authHeaders() { return { 'authorization': 'Bearer ' + adminToken(), 'content-type': 'application/json' }; }
function setAuthMessage(message, ok) {
  document.getElementById('auth-message').innerHTML = '<span class="' + (ok ? 'ok' : 'bad') + '">' + escapeHtml(message) + '</span>';
}
async function api(path, options = {}) {
  const response = await fetch(withToken(path), { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.error || 'HTTP ' + response.status);
  return payload;
}
async function post(path, body, refresh = true) {
  try {
    setBusy(true);
    const payload = await api(path, { method: 'POST', body: JSON.stringify(body || {}) });
    if (refresh) await load();
    return payload;
  } catch (error) {
    alert(error.message || String(error));
    throw error;
  } finally {
    setBusy(false);
  }
}
async function load() {
  try {
    setBusy(true);
    if (!adminToken()) {
      setAuthMessage('Paste the remote admin token, then Save token.', false);
      document.getElementById('status').innerHTML = '<div class="muted">Waiting for remote admin token.</div>';
      return;
    }
    state.view = await api('/admin/api/view');
    setAuthMessage('Token accepted. Remote admin state loaded.', true);
    render();
  } catch (error) {
    const message = error.message || String(error);
    setAuthMessage(message, false);
    document.getElementById('status').innerHTML = '<div class="bad">' + escapeHtml(message) + '</div>';
  } finally {
    setBusy(false);
  }
}
function setBusy(value) { state.busy = value; document.querySelectorAll('button').forEach((button) => button.disabled = value); }
function render() {
  const view = state.view;
  const webhook = view.webhook || {};
  const tunnel = view.tunnel || {};
  document.getElementById('status').innerHTML = [
    row('GitHub CLI', view.provider?.ghAuthenticated ? 'Ready' : view.provider?.detail, view.provider?.ghAuthenticated),
    row('ChatGPT Web', view.chatgpt?.ready ? 'Ready' : 'Setup required', view.chatgpt?.ready),
    row('Local webhook', webhook.listening ? webhook.localUrl : webhook.lastError || 'Stopped', webhook.listening),
    row('Cloudflare tunnel', tunnel.running && tunnel.reachable ? tunnel.publicUrl : tunnel.lastError || 'Not ready', tunnel.running && tunnel.reachable),
  ].join('');
  const repos = view.repositories || [];
  if (repos[0] && !value('repo')) document.getElementById('repo').value = repos[0].fullName;
  document.getElementById('prs').innerHTML = (view.prs || []).map(renderPr).join('') || '<div class="muted">No open PRs loaded.</div>';
  document.getElementById('reviews').innerHTML = (view.reviews || []).slice(0, 20).map(renderReview).join('') || '<div class="muted">No reviews yet.</div>';
}
function row(label, detail, ok) { return '<div class="item"><strong>' + escapeHtml(label) + '</strong> <span class="pill ' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'ready' : 'attention') + '</span><div class="muted">' + escapeHtml(detail || '') + '</div></div>'; }
function renderPr(pr) {
  return '<div class="item"><strong>#' + pr.number + ' ' + escapeHtml(pr.title) + '</strong><div class="muted">' + escapeHtml(pr.repository + ' · ' + pr.headBranch + ' → ' + pr.baseBranch) + '</div><div class="row"><button onclick="runReview(\'' + escapeAttr(pr.repository) + '\',' + pr.number + ',false)">Review</button><button onclick="runReview(\'' + escapeAttr(pr.repository) + '\',' + pr.number + ',true)">Re-review head</button><a href="' + escapeAttr(pr.url) + '" target="_blank">Open PR</a></div></div>';
}
function renderReview(review) {
  const canCancel = review.status === 'running' || review.status === 'queued';
  return '<div class="item"><strong>' + escapeHtml(review.trigger || 'manual') + ' · ' + escapeHtml(review.phase) + '</strong> <span class="pill">' + escapeHtml(review.status) + '</span><div class="muted">' + escapeHtml(review.repository + ' PR #' + review.prNumber + ' · ' + review.headSha.slice(0, 10)) + '</div>' + (review.error ? '<div class="bad">' + escapeHtml(review.error) + '</div>' : '') + '<div class="row">' + (canCancel ? '<button class="danger" onclick="cancelReview(\'' + escapeAttr(review.id) + '\')">Cancel</button>' : '') + '</div></div>';
}
window.runReview = (repository, prNumber, force) => post('/admin/api/reviews/run', { repository, prNumber, force });
window.cancelReview = (reviewId) => post('/admin/api/reviews/cancel', { reviewId });
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch])); }
function escapeAttr(value) { return escapeHtml(value).replace(/\`/g, '&#096;'); }
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}
