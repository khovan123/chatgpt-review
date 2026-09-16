import { describe, expect, it } from "vitest";

import { cloudflaredRunArgs, cloudflareOriginUrl, cloudflareWebhookUrl, normalizeCloudflareHostname } from "./cloudflare-tunnel";

describe("personal Cloudflare named tunnel", () => {
  it("normalizes a user-owned hostname and derives the GitHub webhook endpoint", () => {
    expect(normalizeCloudflareHostname("Review.Example.COM.")).toBe("review.example.com");
    expect(cloudflareOriginUrl("review.example.com")).toBe("https://review.example.com");
    expect(cloudflareWebhookUrl("review.example.com")).toBe("https://review.example.com/webhooks/v1/github");
  });

  it("rejects Quick Tunnel and URL-shaped values", () => {
    expect(() => normalizeCloudflareHostname("random.trycloudflare.com")).toThrow(/Quick Tunnel/i);
    expect(() => normalizeCloudflareHostname("https://review.example.com/webhooks/v1/github")).toThrow(/hostname only/i);
  });

  it("runs remotely-managed tunnels without a local --config override", () => {
    const tokenPath = process.platform === "win32" ? "C:\\app\\named-tunnel-token" : "/app/named-tunnel-token";
    const args = cloudflaredRunArgs(tokenPath);

    expect(args).toContain("--token-file");
    expect(args).toContain(tokenPath);
    expect(args).not.toContain("--config");
  });
});
