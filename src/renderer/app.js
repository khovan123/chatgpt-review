const api = window.reviewApp;
let view = null;
let selectedRepository = null;
let selectedPrNumber = null;
let settingsSection = "connections";
let cloudflareSetup = null;
let sidebarCollapsed = loadUiFlag("sidebar-collapsed");
let prColumnCollapsed = loadUiFlag("pr-column-collapsed");
const reviewActivity = new Map();
const busy = new Set();
let noticeTimer = null;

const elements = {
  desktopShell: document.querySelector(".desktop-shell"),
  notice: document.getElementById("notice"),
  toggleSidebar: document.getElementById("toggleSidebar"),
  togglePrColumn: document.getElementById("togglePrColumn"),
  addRepository: document.getElementById("addRepository"),
  openSettings: document.getElementById("openSettings"),
  sidebarRepositories: document.getElementById("sidebarRepositories"),
  repoCount: document.getElementById("repoCount"),
  prCount: document.getElementById("prCount"),
  prs: document.getElementById("pullRequests"),
  prEmptyState: document.getElementById("prEmptyState"),
  prDetail: document.getElementById("prDetail"),
  selectedPrNumber: document.getElementById("selectedPrNumber"),
  selectedPrDraft: document.getElementById("selectedPrDraft"),
  selectedPrTitle: document.getElementById("selectedPrTitle"),
  selectedPrMeta: document.getElementById("selectedPrMeta"),
  openSelectedPr: document.getElementById("openSelectedPr"),
  reviewSelectedPr: document.getElementById("reviewSelectedPr"),
  historyCount: document.getElementById("historyCount"),
  reviews: document.getElementById("reviews"),
  settingsModal: document.getElementById("settingsModal"),
  closeSettings: document.getElementById("closeSettings"),
  settingsNavItems: [...document.querySelectorAll("[data-settings-section]")],
  settingsPanels: [...document.querySelectorAll("[data-settings-panel]")],
  connections: document.getElementById("connections"),
  cloudflareApiForm: document.getElementById("cloudflareApiForm"),
  cloudflareApiToken: document.getElementById("cloudflareApiToken"),
  cloudflareDiscoverZones: document.getElementById("cloudflareDiscoverZones"),
  cloudflareProvisionForm: document.getElementById("cloudflareProvisionForm"),
  cloudflareZone: document.getElementById("cloudflareZone"),
  cloudflareHostnameLabel: document.getElementById("cloudflareHostnameLabel"),
  cloudflareSetupStatus: document.getElementById("cloudflareSetupStatus"),
  cloudflareProvisionButton: document.getElementById("cloudflareProvisionButton"),
  cloudflareProvisioned: document.getElementById("cloudflareProvisioned"),
  cloudflareProvisionedDetails: document.getElementById("cloudflareProvisionedDetails"),
  cloudflareRemoveForm: document.getElementById("cloudflareRemoveForm"),
  cloudflareRemoveApiToken: document.getElementById("cloudflareRemoveApiToken"),
  removeCloudflareResources: document.getElementById("removeCloudflareResources"),
  manualCloudflareDetails: document.getElementById("manualCloudflareDetails"),
  cloudflareForm: document.getElementById("cloudflareForm"),
  cloudflareHostname: document.getElementById("cloudflareHostname"),
  cloudflareTunnelToken: document.getElementById("cloudflareTunnelToken"),
  cloudflareEndpoint: document.getElementById("cloudflareEndpoint"),
  restartCloudflare: document.getElementById("restartCloudflare"),
  disconnectCloudflare: document.getElementById("disconnectCloudflare"),
  connectionForm: document.getElementById("connectionForm"),
  webhookListenHost: document.getElementById("webhookListenHost"),
  webhookListenPort: document.getElementById("webhookListenPort"),
  chatgptSetup: document.getElementById("chatgptSetup"),
  repoLinkForm: document.getElementById("repoLinkForm"),
  repoInput: document.getElementById("repoInput"),
  repoConnectButton: document.getElementById("repoConnectButton"),
  settingsRepositories: document.getElementById("settingsRepositories"),
  reviewSettingsForm: document.getElementById("reviewSettingsForm"),
  autoReview: document.getElementById("autoReview"),
  postComment: document.getElementById("postComment"),
  reviewDrafts: document.getElementById("reviewDrafts"),
  requireJira: document.getElementById("requireJira"),
  attachSpec: document.getElementById("attachSpec"),
  specs: document.getElementById("specs"),
};

async function loadView() {
  try {
    view = await api.getView();
    normalizeSelection();
    render();
  } catch (error) {
    showNotice(message(error), true, false);
  }
}

function normalizeSelection() {
  if (!view) return;
  const repositories = view.repositories.filter((repository) => repository.enabled !== false);
  if (!repositories.some((repository) => repository.fullName === selectedRepository)) {
    selectedRepository = repositories[0]?.fullName ?? null;
    selectedPrNumber = null;
  }
  const repoPrs = selectedRepository ? pullRequestsForRepository(selectedRepository) : [];
  if (!repoPrs.some((pr) => pr.number === selectedPrNumber)) {
    selectedPrNumber = repoPrs[0]?.number ?? null;
  }
}

function render() {
  if (!view) return;
  renderCollapseState();
  renderSidebar();
  renderPrs();
  renderReviewDetail();
  renderSettings();
}

function renderSidebar() {
  clear(elements.sidebarRepositories);
  elements.repoCount.textContent = String(view.repositories.length);

  if (!view.repositories.length) {
    const state = el("div", "sidebar-empty");
    state.append(
      textEl("strong", "", "No repositories yet"),
      textEl("span", "", "Add a repository to start receiving PR review events."),
    );
    elements.sidebarRepositories.append(state);
    return;
  }

  for (const repository of view.repositories) {
    const selected = repository.fullName === selectedRepository;
    const prs = pullRequestsForRepository(repository.fullName);
    const item = button("", `repository-nav-item${selected ? " selected" : ""}`, () => selectRepository(repository.fullName));
    item.setAttribute("aria-pressed", selected ? "true" : "false");
    item.title = repository.fullName;

    const accent = el("span", "repository-active-accent");
    accent.setAttribute("aria-hidden", "true");
    const icon = textEl("span", "repository-icon", "▱");
    icon.setAttribute("aria-hidden", "true");
    const copy = el("span", "repository-nav-copy");
    copy.append(
      textEl("span", "repository-nav-name", sidebarCollapsed ? repository.fullName.split("/").pop() : repository.fullName),
      textEl("span", "repository-nav-meta", `${prs.length} open PR${prs.length === 1 ? "" : "s"}`),
    );
    const health = el("span", `repo-health ${toneForWebhook(repository.webhook.status)}`);
    health.title = `Webhook: ${repository.webhook.status}`;
    health.setAttribute("aria-label", `Webhook ${repository.webhook.status}`);

    item.append(accent, icon, copy, health);
    elements.sidebarRepositories.append(item);
  }
}

function renderCollapseState() {
  elements.desktopShell.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  elements.desktopShell.classList.toggle("pr-collapsed", prColumnCollapsed);

  elements.toggleSidebar.textContent = sidebarCollapsed ? "›" : "‹";
  elements.toggleSidebar.setAttribute("aria-label", sidebarCollapsed ? "Expand repository sidebar" : "Collapse repository sidebar");
  elements.toggleSidebar.title = sidebarCollapsed ? "Expand repository sidebar" : "Collapse repository sidebar";

  elements.togglePrColumn.textContent = prColumnCollapsed ? "›" : "‹";
  elements.togglePrColumn.setAttribute("aria-label", prColumnCollapsed ? "Expand pull request list" : "Collapse pull request list");
  elements.togglePrColumn.title = prColumnCollapsed ? "Expand pull request list" : "Collapse pull request list";
}

function renderPrs() {
  clear(elements.prs);
  const repository = currentRepository();
  const prs = repository ? pullRequestsForRepository(repository.fullName) : [];
  elements.prCount.textContent = String(prs.length);

  if (!repository) {
    elements.prs.append(empty("Connect a repository to browse pull requests."));
    return;
  }
  if (!prs.length) {
    elements.prs.append(empty("No open pull requests in this repository."));
    return;
  }

  for (const pr of prs) {
    const selected = pr.number === selectedPrNumber;
    const latest = latestReview(pr.repository, pr.number);
    const item = button("", `pr-nav-item${selected ? " selected" : ""}`, () => selectPullRequest(pr.number));
    item.setAttribute("aria-pressed", selected ? "true" : "false");

    const top = el("span", "pr-nav-top");
    top.append(
      textEl("span", "pr-number", `#${pr.number}`),
      latest ? badge(latest.result?.verdict || latest.status, latest.result?.verdict === "PASS" ? "success" : toneForStatus(latest.status)) : textEl("span", "pr-unreviewed", "unreviewed"),
    );
    item.append(
      top,
      textEl("span", "pr-nav-title", pr.title),
      textEl("span", "pr-nav-meta", `${pr.headBranch} → ${pr.baseBranch} · ${pr.headSha.slice(0, 8)}${pr.isDraft ? " · draft" : ""}`),
    );
    elements.prs.append(item);
  }
}

function isActiveReview(review) {
  return review?.status === "running" || review?.status === "queued";
}

function isTerminalReview(review) {
  return review?.status === "completed" || review?.status === "blocked" || review?.status === "failed" || review?.status === "cancelled";
}

function renderReviewDetail() {
  const pr = currentPullRequest();
  if (!pr) {
    elements.prEmptyState.classList.remove("hidden");
    elements.prDetail.classList.add("hidden");
    return;
  }

  elements.prEmptyState.classList.add("hidden");
  elements.prDetail.classList.remove("hidden");
  elements.selectedPrNumber.textContent = `PR #${pr.number}`;
  elements.selectedPrDraft.classList.toggle("hidden", !pr.isDraft);
  elements.selectedPrTitle.textContent = pr.title;
  elements.selectedPrMeta.textContent = `${pr.author} · ${pr.headBranch} → ${pr.baseBranch} · ${pr.headSha.slice(0, 12)} · ${pr.changedFiles} changed file${pr.changedFiles === 1 ? "" : "s"}`;

  const latest = latestReview(pr.repository, pr.number);
  elements.reviewSelectedPr.textContent = latest?.headSha === pr.headSha ? "Review again" : "Review now";
  elements.reviewSelectedPr.disabled = isActiveReview(latest);
  renderReviews(pr);
}

function renderReviews(pr) {
  clear(elements.reviews);
  const reviews = reviewsForPr(pr.repository, pr.number);
  elements.historyCount.textContent = String(reviews.length);

  if (!reviews.length) {
    const state = el("div", "review-empty");
    state.append(
      textEl("h3", "", "No reviews yet"),
      textEl("p", "", "Webhook-triggered and manual review runs for this PR will appear here."),
      button("Review now", "button", () => runReview(pr.repository, pr.number, false)),
    );
    elements.reviews.append(state);
    return;
  }

  for (const review of reviews) {
    const card = el("article", "review-item");
    const head = el("div", "review-head");
    const main = el("div", "review-main");
    main.append(
      textEl("div", "review-title", `${review.trigger || "manual"} · ${review.phase}`),
      textEl("div", "review-meta", `${review.headSha.slice(0, 10)} · ${formatDate(review.updatedAt)}`),
    );
    head.append(main, badge(review.result?.verdict || review.status, review.result?.verdict === "PASS" ? "success" : toneForStatus(review.status)));
    card.append(head);

    const body = el("div", "review-body");
    body.append(textEl("div", "review-meta", review.jiraKeys?.length
      ? `Jira ${review.jiraKeys.join(", ")} · ${review.jira?.status || "pending"}`
      : "No Jira issue key detected"));

    const activity = activityForReview(review);
    if (activity.length) body.append(renderReviewActivity(activity, review.status));

    if (review.result) {
      body.append(textEl("div", "review-summary", review.result.summary || "No summary returned."));
      const evidence = el("div", "evidence-grid");
      evidence.append(
        evidenceItem("Jira", review.result.jiraAlignment || "—"),
        evidenceItem("Spec", review.result.specAlignment || "—"),
        evidenceItem("Tests", review.result.testAssessment || "—"),
      );
      body.append(evidence);

      if (review.result.findings?.length) {
        const findings = el("div", "findings");
        for (const finding of review.result.findings) {
          const findingCard = el("div", `finding ${String(finding.severity || "").toLowerCase()}`);
          const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
          findingCard.append(
            textEl("div", "finding-title", `${finding.severity} · ${finding.title}`),
            location ? textEl("div", "finding-location", location) : document.createDocumentFragment(),
            textEl("div", "finding-text", [
              finding.checkpoint ? `Checkpoint: ${finding.checkpoint}` : "",
              finding.rootCause ? `Root cause: ${finding.rootCause}` : finding.explanation,
              finding.evidence ? `Evidence: ${finding.evidence}` : "",
              finding.impact ? `Impact: ${finding.impact}` : "",
              finding.jiraRef ? `Jira: ${finding.jiraRef}` : "",
              finding.specRef ? `Spec: ${finding.specRef}` : "",
              finding.suggestion ? `Suggested change: ${finding.suggestion}` : "",
              finding.reproduction ? `Verification: ${finding.reproduction}` : "",
              finding.regressionTests ? `Regression tests: ${finding.regressionTests}` : "",
            ].filter(Boolean).join("\n")),
          );
          findings.append(findingCard);
        }
        body.append(findings);
      }
    } else if (review.error) {
      body.append(textEl("div", "review-summary error-text", review.error));
    } else {
      body.append(textEl("div", "review-summary", "Review is in progress. State updates will appear here automatically."));
    }

    const actions = el("div", "button-row");
    const active = isActiveReview(review);
    const terminal = isTerminalReview(review);
    if (active) {
      const cancel = button("Cancel review", "button danger small", () => cancelReview(review.id));
      cancel.disabled = busy.has(`cancel:${review.id}`);
      actions.append(cancel);
    }
    if (review.conversationUrl && terminal) actions.append(button("Open Chat", "button secondary small", () => api.openReviewChat(review.id)));
    if (terminal) {
      actions.append(button("Re-review head", "button secondary small", () => runReview(review.repository, review.prNumber, true)));
    }
    if (actions.childNodes.length) body.append(actions);
    card.append(body);
    elements.reviews.append(card);
  }
}

function renderSettings() {
  renderSettingsSection();
  renderConnections();
  renderConnectionConfig();
  renderSettingsRepositories();
  renderReviewSettings();
  renderSpecs();
}

function renderSettingsSection() {
  for (const item of elements.settingsNavItems) {
    const selected = item.dataset.settingsSection === settingsSection;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-pressed", selected ? "true" : "false");
  }
  for (const panel of elements.settingsPanels) {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== settingsSection);
  }
}

function renderConnections() {
  clear(elements.connections);
  const tunnelReady = Boolean(view.tunnel?.running && view.tunnel?.reachable);
  const tunnelStatus = !view.tunnel?.installed
    ? "Missing cloudflared"
    : tunnelReady
      ? "Ready"
      : view.tunnel?.running
        ? "Route not verified"
        : view.tunnel?.configured
          ? "Stopped"
          : "Not connected";
  const managed = view.cloudflareProvisioning;
  const cloudflareDetail = view.tunnel?.lastError
    || (managed
      ? `${managed.hostname} · app-managed named tunnel · ${managed.zoneName} · ${view.tunnel?.version || "cloudflared"}`
      : view.tunnel?.hostname
        ? `${view.tunnel.hostname} · existing named tunnel · ${view.tunnel.version || "cloudflared"}`
        : "Provision a named tunnel inside your own Cloudflare account. Quick Tunnel and shared server tunnels are disabled.");

  elements.connections.append(
    connectionItem(
      "GitHub CLI",
      view.provider.ghAuthenticated ? "Ready" : view.provider.ghInstalled ? "Sign in required" : "Missing",
      view.provider.detail,
      view.provider.ghAuthenticated ? "success" : "warning",
    ),
    connectionItem(
      "ChatGPT Web",
      view.chatgpt.ready ? "Ready" : "Setup required",
      view.chatgpt.ready ? "Signed-in ChatGPT composer detected." : "Sign in to ChatGPT Web and enable the Atlassian/Jira connector.",
      view.chatgpt.ready ? "success" : "warning",
    ),
    connectionItem(
      "OpenCodeReview",
      view.ocr?.installed ? `v${view.ocr.version || "unknown"}` : "Missing",
      view.ocr?.detail || "OpenCodeReview managed-agent engine is not available.",
      view.ocr?.installed ? "success" : "danger",
    ),
    connectionItem(
      "Personal Cloudflare",
      tunnelStatus,
      cloudflareDetail,
      tunnelReady ? "success" : view.tunnel?.lastError ? "danger" : "warning",
    ),
    connectionItem(
      "Local webhook ingress",
      view.webhook.listening ? "Listening" : "Stopped",
      view.webhook.listening ? view.webhook.localUrl : (view.webhook.lastError || "The local webhook listener is not running."),
      view.webhook.listening ? "success" : "danger",
    ),
  );
}

function renderConnectionConfig() {
  const active = document.activeElement;
  const connected = Boolean(view.config.cloudflareHostname);
  const managed = view.cloudflareProvisioning;

  if (active !== elements.cloudflareHostname) elements.cloudflareHostname.value = managed ? "" : (view.config.cloudflareHostname || "");
  if (active !== elements.webhookListenHost) elements.webhookListenHost.value = view.config.webhookListenHost || "127.0.0.1";
  if (active !== elements.webhookListenPort) elements.webhookListenPort.value = String(view.config.webhookListenPort ?? 8787);
  elements.cloudflareEndpoint.textContent = view.config.webhookPublicUrl || "Not connected";
  elements.restartCloudflare.disabled = !view.config.cloudflareHostname;
  elements.disconnectCloudflare.disabled = !view.tunnel?.configured || view.repositories.length > 0 || Boolean(managed);
  elements.repoConnectButton.disabled = !(view.tunnel?.running && view.tunnel?.reachable);
  elements.webhookListenHost.disabled = connected;
  elements.webhookListenPort.disabled = connected;

  elements.cloudflareApiForm.classList.toggle("hidden", connected);
  elements.manualCloudflareDetails.classList.toggle("hidden", connected || Boolean(managed));

  if (cloudflareSetup && !connected) {
    elements.cloudflareProvisionForm.classList.remove("hidden");
    const previous = elements.cloudflareZone.value;
    clear(elements.cloudflareZone);
    for (const zone of cloudflareSetup.zones || []) {
      const option = document.createElement("option");
      option.value = zone.zoneId;
      option.textContent = `${zone.zoneName} · ${zone.accountName}`;
      elements.cloudflareZone.append(option);
    }
    if ([...elements.cloudflareZone.options].some((option) => option.value === previous)) elements.cloudflareZone.value = previous;
    elements.cloudflareSetupStatus.textContent = `API token validated. ${cloudflareSetup.zones.length} active zone${cloudflareSetup.zones.length === 1 ? "" : "s"} available. Setup session expires ${formatDate(cloudflareSetup.expiresAt)}. The API token itself is no longer in the renderer.`;
  } else {
    elements.cloudflareProvisionForm.classList.add("hidden");
    elements.cloudflareSetupStatus.textContent = "";
  }

  elements.cloudflareProvisioned.classList.toggle("hidden", !managed);
  clear(elements.cloudflareProvisionedDetails);
  if (managed) {
    elements.cloudflareProvisionedDetails.append(
      detailRow("Hostname", managed.hostname),
      detailRow("Zone", managed.zoneName),
      detailRow("Account", managed.accountName || managed.accountId),
      detailRow("Tunnel", `${managed.tunnelName} · ${managed.tunnelId}`),
      detailRow("DNS record", managed.dnsRecordId),
      detailRow("Provisioned", formatDate(managed.provisionedAt)),
    );
    elements.removeCloudflareResources.disabled = view.repositories.length > 0;
  }
}

function renderReviewSettings() {
  elements.autoReview.checked = Boolean(view.config.autoReview);
  elements.postComment.checked = Boolean(view.config.postComment);
  elements.reviewDrafts.checked = Boolean(view.config.reviewDrafts);
  elements.requireJira.checked = Boolean(view.config.requireJiraWhenKeyPresent);
}

function renderSettingsRepositories() {
  clear(elements.settingsRepositories);
  if (!view.repositories.length) {
    elements.settingsRepositories.append(empty("No repositories connected yet."));
    return;
  }

  for (const repository of view.repositories) {
    const card = el("article", "settings-repository-item");
    const head = el("div", "settings-repository-head");
    const copy = el("div", "settings-repository-copy");
    copy.append(
      textEl("strong", "", repository.fullName),
      textEl("span", "", `${pullRequestsForRepository(repository.fullName).length} open PR${pullRequestsForRepository(repository.fullName).length === 1 ? "" : "s"}`),
    );
    head.append(copy, badge(repository.webhook.status, toneForWebhook(repository.webhook.status)));

    const details = el("div", "repository-settings-details");
    details.append(
      detailRow("ChatGPT Project", repository.chatgptProjectUrl ? "Bound · Repository review context" : "Pending creation"),
      detailRow("PR conversations", String(repository.chatgptPrConversations?.length ?? 0)),
      detailRow("Webhook ID", repository.webhook.hookId ? String(repository.webhook.hookId) : "Not created"),
      detailRow("Target", repository.webhook.targetUrl || view.config.webhookPublicUrl || "Not configured"),
      detailRow("Last event", repository.webhook.lastEvent || "Waiting for delivery"),
      detailRow("Last delivery", repository.webhook.lastDeliveryAt ? formatDate(repository.webhook.lastDeliveryAt) : "—"),
    );
    if (repository.webhook.lastError) details.append(textEl("div", "repository-settings-error", repository.webhook.lastError));

    const actions = el("div", "button-row");
    actions.append(
      button("Open GitHub", "button secondary small", () => api.openExternal(`https://github.com/${repository.fullName}`)),
      button("Sync webhook", "button secondary small", () => syncWebhook(repository.fullName)),
      button("Disconnect", "button danger small", () => unlinkRepository(repository.fullName)),
    );
    card.append(head, details, actions);
    elements.settingsRepositories.append(card);
  }
}

function renderSpecs() {
  clear(elements.specs);
  if (!view.specs.length) {
    elements.specs.append(empty("No spec memory attached. Reviews will use PR and Jira evidence only."));
    return;
  }
  for (const spec of view.specs) {
    const item = el("div", "spec-item");
    const copy = el("div", "spec-copy");
    copy.append(
      textEl("strong", "", spec.name),
      textEl("span", "", `${formatBytes(spec.bytes)} · ${spec.chunkCount} chunks`),
    );
    item.append(copy, button("Remove", "button danger small", () => removeSpec(spec)));
    elements.specs.append(item);
  }
}

function selectRepository(repository) {
  selectedRepository = repository;
  selectedPrNumber = pullRequestsForRepository(repository)[0]?.number ?? null;
  render();
  void refreshRepository(repository, true);
}

function selectPullRequest(prNumber) {
  selectedPrNumber = prNumber;
  renderPrs();
  renderReviewDetail();
}

function openSettings(section = "connections") {
  settingsSection = section;
  elements.settingsModal.classList.remove("hidden");
  renderSettings();
  if (section === "repositories") requestAnimationFrame(() => elements.repoInput.focus());
}

function closeSettings() {
  elements.settingsModal.classList.add("hidden");
}

async function runReview(repository, prNumber, force) {
  const key = `review:${repository}:${prNumber}`;
  if (busy.has(key)) return;
  busy.add(key);
  try {
    await api.runReview(repository, prNumber, Boolean(force));
    await loadView();
  } catch (error) {
    await loadView().catch(() => undefined);
    const latest = latestReview(repository, prNumber);
    // ReviewEngine persists runtime failures before the IPC promise rejects. Keep
    // those errors in the review card instead of duplicating them as a global toast.
    const persistedFailure = latest && (latest.status === "failed" || latest.status === "blocked");
    if (!persistedFailure) showNotice(message(error), true, false);
  } finally {
    busy.delete(key);
  }
}

async function cancelReview(reviewId) {
  await withBusy(`cancel:${reviewId}`, async () => {
    view = await api.cancelReview(reviewId);
    normalizeSelection();
    render();
    showNotice("Review cancelled.");
  });
}

async function refreshRepository(repository, silent = false) {
  await withBusy(`refresh:${repository}`, async () => {
    view = await api.refreshPullRequests(repository);
    normalizeSelection();
    render();
    if (!silent) showNotice(`Refreshed open PRs for ${repository}.`);
  }, silent);
}

async function syncWebhook(repository) {
  await withBusy(`hook:${repository}`, async () => {
    view = await api.syncRepositoryWebhook(repository);
    render();
    showNotice(`Webhook synced for ${repository}; waiting for GitHub ping/delivery.`);
  });
}

async function unlinkRepository(repository) {
  await withBusy(`unlink:${repository}`, async () => {
    view = await api.unlinkRepository(repository);
    if (selectedRepository === repository) {
      selectedRepository = null;
      selectedPrNumber = null;
    }
    normalizeSelection();
    render();
    showNotice(`Disconnected ${repository}.`);
  });
}

async function removeSpec(spec) {
  await withBusy(`spec:${spec.id}`, async () => {
    view = await api.removeSpec(spec.id);
    render();
    showNotice(`Removed ${spec.name} from spec memory.`);
  });
}

elements.addRepository.addEventListener("click", () => openSettings("repositories"));
elements.openSettings.addEventListener("click", () => openSettings("connections"));
elements.toggleSidebar.addEventListener("click", () => {
  sidebarCollapsed = !sidebarCollapsed;
  saveUiFlag("sidebar-collapsed", sidebarCollapsed);
  render();
});
elements.togglePrColumn.addEventListener("click", () => {
  prColumnCollapsed = !prColumnCollapsed;
  saveUiFlag("pr-column-collapsed", prColumnCollapsed);
  render();
});
elements.closeSettings.addEventListener("click", closeSettings);
elements.settingsModal.addEventListener("mousedown", (event) => {
  if (event.target === elements.settingsModal) closeSettings();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.settingsModal.classList.contains("hidden")) closeSettings();
});

for (const item of elements.settingsNavItems) {
  item.addEventListener("click", () => {
    settingsSection = item.dataset.settingsSection || "connections";
    renderSettingsSection();
  });
}

elements.openSelectedPr.addEventListener("click", () => {
  const pr = currentPullRequest();
  if (pr) void api.openExternal(pr.url);
});
elements.reviewSelectedPr.addEventListener("click", () => {
  const pr = currentPullRequest();
  if (!pr) return;
  const latest = latestReview(pr.repository, pr.number);
  void runReview(pr.repository, pr.number, latest?.headSha === pr.headSha);
});

elements.cloudflareApiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiToken = elements.cloudflareApiToken.value.trim();
  if (!apiToken) {
    showNotice("Cloudflare API token is required for automatic provisioning.", true, false);
    return;
  }
  elements.cloudflareApiToken.value = "";
  await withBusy("cloudflare-discover", async () => {
    showNotice("Validating the one-time Cloudflare token and discovering active zones…", false, false);
    cloudflareSetup = await api.beginCloudflareSetup(apiToken);
    renderConnectionConfig();
    showNotice(`Cloudflare token validated. Found ${cloudflareSetup.zones.length} active zone${cloudflareSetup.zones.length === 1 ? "" : "s"}.`);
  });
});

elements.cloudflareProvisionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!cloudflareSetup) {
    showNotice("Cloudflare setup session expired. Enter the API token again.", true, false);
    return;
  }
  const setupId = cloudflareSetup.id;
  const zoneId = elements.cloudflareZone.value;
  const hostnameLabel = elements.cloudflareHostnameLabel.value.trim();
  cloudflareSetup = null;
  await withBusy("cloudflare-provision", async () => {
    showNotice("Creating your named tunnel, remote ingress and proxied DNS record in Cloudflare…", false, false);
    view = await api.provisionCloudflare(setupId, zoneId, hostnameLabel || undefined);
    elements.cloudflareHostnameLabel.value = "";
    render();
    showNotice(`Personal Cloudflare endpoint is ready: ${view.config.webhookPublicUrl}`);
  });
});

elements.cloudflareRemoveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiToken = elements.cloudflareRemoveApiToken.value.trim();
  if (!apiToken) {
    showNotice("Re-enter a Cloudflare API token to remove the managed tunnel and DNS record.", true, false);
    return;
  }
  elements.cloudflareRemoveApiToken.value = "";
  await withBusy("cloudflare-deprovision", async () => {
    showNotice("Deleting the app-managed Cloudflare DNS record and named tunnel…", false, false);
    view = await api.deprovisionCloudflare(apiToken);
    render();
    showNotice("Managed Cloudflare resources and the local runtime tunnel token were removed.");
  });
});

elements.cloudflareForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const hostname = elements.cloudflareHostname.value.trim();
  const tunnelToken = elements.cloudflareTunnelToken.value.trim();
  if (!hostname || !tunnelToken) {
    showNotice("Public hostname and named tunnel token are required.", true, false);
    return;
  }
  elements.cloudflareTunnelToken.value = "";
  await withBusy("cloudflare-connect", async () => {
    showNotice("Connecting the existing personal Cloudflare named tunnel and verifying the public route…", false, false);
    view = await api.connectCloudflare(hostname, tunnelToken);
    render();
    showNotice(`Cloudflare named tunnel ready at ${view.config.webhookPublicUrl}.`);
  });
});

elements.restartCloudflare.addEventListener("click", () => withBusy("cloudflare-restart", async () => {
  view = await api.restartCloudflare();
  render();
  showNotice("Personal Cloudflare named tunnel restarted and GitHub webhooks re-synced.");
}));

elements.disconnectCloudflare.addEventListener("click", () => withBusy("cloudflare-disconnect", async () => {
  view = await api.disconnectCloudflare();
  elements.cloudflareTunnelToken.value = "";
  render();
  showNotice("Personal Cloudflare tunnel credential removed from this installation.");
}));

elements.connectionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await withBusy("connections", async () => {
    view = await api.updateConfig({
      webhookListenHost: elements.webhookListenHost.value,
      webhookListenPort: Number(elements.webhookListenPort.value),
    });
    render();
    showNotice("Local webhook ingress settings saved.");
  });
});

elements.reviewSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await withBusy("review-settings", async () => {
    view = await api.updateConfig({
      autoReview: elements.autoReview.checked,
      postComment: elements.postComment.checked,
      reviewDrafts: elements.reviewDrafts.checked,
      requireJiraWhenKeyPresent: elements.requireJira.checked,
    });
    render();
    showNotice("Review settings saved.");
  });
});

elements.repoLinkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const repository = elements.repoInput.value.trim();
  if (!repository) return;
  await withBusy(`link:${repository}`, async () => {
    showNotice(`Connecting ${repository} and configuring its GitHub webhook…`, false, false);
    view = await api.linkRepository(repository);
    elements.repoInput.value = "";
    const linked = view.repositories.find((item) => item.fullName.toLowerCase() === repository.toLowerCase())
      ?? view.repositories[0];
    selectedRepository = linked?.fullName ?? selectedRepository;
    selectedPrNumber = selectedRepository ? pullRequestsForRepository(selectedRepository)[0]?.number ?? null : null;
    render();
    if (linked?.webhook.status === "error") {
      showNotice(`Repository connected, but webhook setup needs attention: ${linked.webhook.lastError || "unknown error"}`, true, false);
      return;
    }
    closeSettings();
    showNotice(`${linked?.fullName || repository} connected. Open PRs are selected automatically.`);
  });
});

elements.attachSpec.addEventListener("click", () => withBusy("attach-spec", async () => {
  view = await api.attachSpecs();
  render();
  showNotice("Spec memory updated.");
}));

elements.chatgptSetup.addEventListener("click", () => withBusy("chatgpt", async () => {
  await api.openChatGptSetup();
  showNotice("ChatGPT Web opened. Sign in and enable the Atlassian/Jira connector if needed.", false, false);
}));

api.onReviewEvent((event) => {
  if (!event || typeof event !== "object") return;
  const reviewScoped = Boolean(event.reviewId || event.taskId);
  if (reviewScoped) {
    appendReviewActivity(event);
    const associatedReview = reviewForEvent(event);
    if (event.type === "state") {
      void loadView();
    } else if (associatedReview?.repository === selectedRepository && associatedReview.prNumber === selectedPrNumber) {
      renderReviewDetail();
    }
    return;
  }

  const text = typeof event.message === "string" ? event.message : "Application state changed.";
  showNotice(text, false, false);
  if (event.type === "state") void loadView();
});

function reviewForEvent(event) {
  if (!view?.reviews) return null;
  if (typeof event.reviewId === "string" && event.reviewId) {
    const byId = view.reviews.find((review) => review.id === event.reviewId);
    if (byId) return byId;
  }
  if (typeof event.taskId === "string" && event.taskId) {
    return view.reviews.find((review) => review.taskId === event.taskId) ?? null;
  }
  return null;
}

function appendReviewActivity(event) {
  const key = typeof event.taskId === "string" && event.taskId
    ? event.taskId
    : typeof event.reviewId === "string" && event.reviewId
      ? event.reviewId
      : null;
  if (!key) return;
  const rawText = typeof event.message === "string" ? event.message.trim() : "";
  const type = event.type === "state" ? "state" : "progress";
  const text = type === "progress" ? compactReviewProgress(rawText) : rawText;
  if (!text) return;

  const entries = reviewActivity.get(key) || [];
  const last = entries[entries.length - 1];
  if (last?.message === text && last?.phase === event.phase) return;
  const nextEntry = {
    message: text.slice(0, 8000),
    phase: typeof event.phase === "string" ? event.phase : "",
    type,
    timestamp: Date.now(),
  };
  // ChatGPT DOM snapshots are cumulative while a response streams. Keep one
  // mutable progress row instead of appending every larger snapshot as a new log.
  if (type === "progress" && last?.type === "progress") entries[entries.length - 1] = nextEntry;
  else entries.push(nextEntry);
  if (entries.length > 80) entries.splice(0, entries.length - 80);
  reviewActivity.set(key, entries);
}

function compactReviewProgress(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (/^thinking\b/i.test(cleaned)) return "ChatGPT is processing the current review step…";
  if (cleaned.includes("[JIRA_CONTEXT]")) return "ChatGPT is resolving Jira evidence…";
  if (cleaned.includes("[CHUNK_REVIEW]")) return "ChatGPT is producing the current diff-chunk review…";
  if (cleaned.includes("[PR_REVIEW]")) return "ChatGPT is synthesizing the final review…";
  return cleaned.length > 180 ? `${cleaned.slice(0, 179)}…` : cleaned;
}

function activityForReview(review) {
  return reviewActivity.get(review.taskId) || reviewActivity.get(review.id) || [];
}

function renderReviewActivity(entries, status) {
  const activity = el("div", "review-activity");
  const head = el("div", "review-activity-head");
  head.append(
    textEl("span", "review-activity-title", "Activity"),
    textEl("span", `review-activity-state ${status === "running" || status === "queued" ? "live" : ""}`, status === "running" || status === "queued" ? "live" : "log"),
  );
  const log = el("div", "review-activity-log");
  for (const entry of entries) {
    const row = el("div", `review-activity-row ${entry.type}`);
    row.append(
      textEl("span", "review-activity-dot", ""),
      textEl("span", "review-activity-message", entry.message),
    );
    log.append(row);
  }
  activity.append(head, log);
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  return activity;
}

function currentRepository() {
  return view?.repositories.find((repository) => repository.fullName === selectedRepository) ?? null;
}

function currentPullRequest() {
  if (!selectedRepository || !selectedPrNumber) return null;
  return view?.prs.find((pr) => pr.repository === selectedRepository && pr.number === selectedPrNumber) ?? null;
}

function pullRequestsForRepository(repository) {
  return (view?.prs ?? [])
    .filter((pr) => pr.repository === repository)
    .sort((a, b) => Number(a.isDraft) - Number(b.isDraft) || b.number - a.number);
}

function reviewsForPr(repository, prNumber) {
  return (view?.reviews ?? [])
    .filter((review) => review.repository === repository && review.prNumber === prNumber)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function latestReview(repository, prNumber) {
  return reviewsForPr(repository, prNumber)[0] ?? null;
}

async function withBusy(key, action, quiet = false) {
  if (busy.has(key)) return;
  busy.add(key);
  try {
    await action();
  } catch (error) {
    if (!quiet) showNotice(message(error), true, false);
    await loadView().catch(() => undefined);
  } finally {
    busy.delete(key);
  }
}

function showNotice(text, error = false, autoHide = true) {
  if (noticeTimer) clearTimeout(noticeTimer);
  elements.notice.textContent = text;
  elements.notice.classList.remove("hidden", "error");
  if (error) elements.notice.classList.add("error");
  if (autoHide) noticeTimer = setTimeout(() => elements.notice.classList.add("hidden"), 5000);
}

function connectionItem(title, status, detail, tone) {
  const item = el("div", "connection-item");
  const copy = el("div", "connection-copy");
  copy.append(textEl("strong", "", title), textEl("span", "", detail));
  item.append(copy, badge(status, tone));
  return item;
}

function detailRow(label, value) {
  const row = el("div", "detail-row");
  row.append(textEl("span", "detail-label", label), textEl("span", "detail-value", value));
  return row;
}

function evidenceItem(label, value) {
  const item = el("div", "evidence-item");
  item.append(textEl("span", "evidence-label", label), textEl("p", "", value));
  return item;
}

function badge(text, tone = "info") {
  return textEl("span", `badge ${tone}`, text);
}

function toneForWebhook(status) {
  if (status === "healthy") return "success";
  if (status === "error") return "danger";
  if (status === "disabled") return "muted-badge";
  return "warning";
}

function toneForStatus(status) {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "blocked") return "warning";
  if (status === "cancelled") return "muted-badge";
  return "info";
}

function button(label, className, handler) {
  const item = textEl("button", className, label);
  item.type = "button";
  item.addEventListener("click", () => Promise.resolve(handler()).catch((error) => showNotice(message(error), true, false)));
  return item;
}

function empty(text) {
  return textEl("div", "empty", text);
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textEl(tag, className, text) {
  const node = el(tag, className);
  node.textContent = String(text ?? "");
  return node;
}

function message(error) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error.";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function loadUiFlag(key) {
  try { return localStorage.getItem(`chatgpt-review:${key}`) === "1"; } catch { return false; }
}

function saveUiFlag(key, value) {
  try { localStorage.setItem(`chatgpt-review:${key}`, value ? "1" : "0"); } catch {}
}

void loadView();
