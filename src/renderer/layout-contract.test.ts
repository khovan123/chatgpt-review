import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const rendererRoot = path.join(process.cwd(), "src", "renderer");

async function source(name: string): Promise<string> {
  return readFile(path.join(rendererRoot, name), "utf8");
}

describe("SourceNerve-style review workspace layout", () => {
  it("keeps repository navigation and the add CTA in the primary sidebar", async () => {
    const html = await source("index.html");
    const css = await source("styles.css");

    expect(html).toContain('class="app-sidebar"');
    expect(html).toContain('id="addRepository"');
    expect(html).toContain('id="sidebarRepositories"');
    expect(html).toContain('id="openSettings"');
    expect(css).toContain("grid-template-columns: 258px minmax(0, 1fr)");
    expect(css).toContain(".repository-nav-item.selected");
    expect(css).toContain(".repository-active-accent");
  });

  it("auto-selects an open PR for the selected repository and scopes history to that PR", async () => {
    const script = await source("app.js");

    expect(script).toContain("selectedPrNumber = repoPrs[0]?.number ?? null");
    expect(script).toContain("selectedPrNumber = pullRequestsForRepository(repository)[0]?.number ?? null");
    expect(script).toContain("review.repository === repository && review.prNumber === prNumber");
    expect(script).toContain("renderReviews(pr)");
  });

  it("keeps all connection and repository management inside the settings modal", async () => {
    const html = await source("index.html");
    const modalStart = html.indexOf('id="settingsModal"');
    expect(modalStart).toBeGreaterThan(0);
    const modal = html.slice(modalStart);

    expect(modal).toContain('data-settings-section="connections"');
    expect(modal).toContain('data-settings-section="repositories"');
    expect(modal).toContain('data-settings-section="review"');
    expect(modal).toContain('data-settings-section="memory"');
    expect(modal).toContain('id="chatgptSetup"');
    expect(modal).toContain('id="cloudflareApiForm"');
    expect(modal).toContain('id="cloudflareApiToken"');
    expect(modal).toContain('id="cloudflareProvisionForm"');
    expect(modal).toContain('id="cloudflareZone"');
    expect(modal).toContain('id="cloudflareRemoveForm"');
    expect(modal).toContain("Create tunnel + DNS + ingress");
    expect(modal).toContain("Account · Cloudflare Tunnel · Edit");
    expect(modal).toContain("Zone · DNS · Edit");
    expect(modal).toContain("Zone · Zone · Read");
    expect(modal).toContain('id="cloudflareForm"');
    expect(modal).toContain('id="cloudflareHostname"');
    expect(modal).toContain('id="cloudflareTunnelToken"');
    expect(modal).toContain('id="repoLinkForm"');
    expect(modal).toContain('id="attachSpec"');
    expect(modal).toContain("No shared server tunnel and no Quick Tunnel fallback");

    const outsideModal = html.slice(0, modalStart);
    expect(outsideModal).not.toContain('id="repoLinkForm"');
    expect(outsideModal).not.toContain('id="cloudflareApiToken"');
    expect(outsideModal).not.toContain('id="cloudflareForm"');
    expect(outsideModal).not.toContain('id="cloudflareTunnelToken"');
    expect(outsideModal).not.toContain('id="chatgptSetup"');
    expect(outsideModal).not.toContain('id="attachSpec"');
  });
  it("removes the repository header and supports independent sidebar and PR-list collapse modes", async () => {
    const html = await source("index.html");
    const script = await source("app.js");
    const css = await source("styles.css");

    expect(html).not.toContain('class="workspace-header"');
    expect(html).toContain('id="toggleSidebar"');
    expect(html).toContain('id="togglePrColumn"');
    expect(script).toContain('sidebarCollapsed = !sidebarCollapsed');
    expect(script).toContain('prColumnCollapsed = !prColumnCollapsed');
    expect(css).toContain('.desktop-shell.sidebar-collapsed');
    expect(css).toContain('.desktop-shell.pr-collapsed .review-workspace');
    expect(css).toContain('.desktop-shell.pr-collapsed .pr-nav-title');
  });

  it("routes review-scoped realtime events into the review card instead of toast notifications", async () => {
    const script = await source("app.js");
    const css = await source("styles.css");

    expect(script).toContain('const reviewScoped = Boolean(event.reviewId || event.taskId)');
    expect(script).toContain('appendReviewActivity(event)');
    expect(script).toContain('renderReviewActivity(activity, review.status)');
    expect(css).toContain('.review-activity-log');
    expect(css).toContain('.review-activity-message');
  });

});
