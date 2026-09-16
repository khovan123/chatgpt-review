import { describe, expect, it } from "vitest";

import { CloudflareApiProvisioner, normalizeHostnameLabel } from "./cloudflare-api";

const API_TOKEN = "cf-api-token-abcdefghijklmnopqrstuvwxyz0123456789";
const RUNTIME_TOKEN = "eyJ-runtime-tunnel-token-abcdefghijklmnopqrstuvwxyz0123456789";
const ACCOUNT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ZONE_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TUNNEL_ID = "12345678-1234-1234-1234-123456789abc";
const DNS_ID = "cccccccccccccccccccccccccccccccc";

function json(result: unknown, status = 200, success = status >= 200 && status < 300, errors: unknown[] = []): Response {
  return new Response(JSON.stringify({ success, result, errors, result_info: { page: 1, total_pages: 1 } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CloudflareApiProvisioner", () => {
  it("keeps the API token out of the setup response and provisions tunnel, ingress and DNS", async () => {
    const calls: Array<{ url: string; method: string; authorization: string; body: unknown }> = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, authorization: headers.get("authorization") ?? "", body });

      if (url.includes("/zones?") && method === "GET") {
        return json([{ id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID, name: "Personal account" } }]);
      }
      if (url.includes(`/zones/${ZONE_ID}/dns_records?`) && method === "GET") return json([]);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/cfd_tunnel`) && method === "POST") {
        return json({ id: TUNNEL_ID, name: "chatgpt-review-test", token: RUNTIME_TOKEN });
      }
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations`) && method === "PUT") return json({});
      if (url.endsWith(`/zones/${ZONE_ID}/dns_records`) && method === "POST") {
        return json({ id: DNS_ID, name: "review.example.com", type: "CNAME", content: `${TUNNEL_ID}.cfargotunnel.com` });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }) as typeof fetch;

    const provisioner = new CloudflareApiProvisioner(mockFetch);
    const setup = await provisioner.beginSetup(API_TOKEN);
    expect(setup.zones).toEqual([{ zoneId: ZONE_ID, zoneName: "example.com", accountId: ACCOUNT_ID, accountName: "Personal account" }]);
    expect(JSON.stringify(setup)).not.toContain(API_TOKEN);

    const result = await provisioner.provision({
      setupId: setup.id,
      zoneId: ZONE_ID,
      originUrl: "http://127.0.0.1:8787",
      hostnameLabel: "review",
    });

    expect(result.record.hostname).toBe("review.example.com");
    expect(result.record.tunnelId).toBe(TUNNEL_ID);
    expect(result.record.dnsRecordId).toBe(DNS_ID);
    expect(result.runtimeToken).toBe(RUNTIME_TOKEN);
    expect(calls.every((call) => call.authorization === `Bearer ${API_TOKEN}`)).toBe(true);

    const configCall = calls.find((call) => call.url.endsWith(`/cfd_tunnel/${TUNNEL_ID}/configurations`));
    expect(configCall?.body).toEqual({
      config: {
        ingress: [
          { hostname: "review.example.com", service: "http://127.0.0.1:8787", originRequest: {} },
          { service: "http_status:404" },
        ],
      },
    });
    const dnsCall = calls.find((call) => call.url.endsWith(`/zones/${ZONE_ID}/dns_records`) && call.method === "POST");
    expect(dnsCall?.body).toMatchObject({
      type: "CNAME",
      name: "review.example.com",
      content: `${TUNNEL_ID}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    });
  });

  it("rolls back the created tunnel when DNS provisioning fails", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/zones?") && method === "GET") {
        return json([{ id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID, name: "Personal account" } }]);
      }
      if (url.includes(`/zones/${ZONE_ID}/dns_records?`) && method === "GET") return json([]);
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/cfd_tunnel`) && method === "POST") return json({ id: TUNNEL_ID });
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations`) && method === "PUT") return json({});
      if (url.endsWith(`/zones/${ZONE_ID}/dns_records`) && method === "POST") {
        return json(null, 403, false, [{ code: 9109, message: "DNS edit denied" }]);
      }
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}`) && method === "DELETE") return json({ id: TUNNEL_ID });
      throw new Error(`unexpected request ${method} ${url}`);
    }) as typeof fetch;

    const provisioner = new CloudflareApiProvisioner(mockFetch);
    const setup = await provisioner.beginSetup(API_TOKEN);
    await expect(provisioner.provision({
      setupId: setup.id,
      zoneId: ZONE_ID,
      originUrl: "http://127.0.0.1:8787",
      hostnameLabel: "review",
    })).rejects.toThrow(/DNS edit denied/i);
    expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith(`/cfd_tunnel/${TUNNEL_ID}`))).toBe(true);
  });

  it("deprovisions the exact managed DNS record, connector connections and tunnel", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "DELETE") return json({});
      throw new Error(`unexpected request ${method} ${url}`);
    }) as typeof fetch;

    const provisioner = new CloudflareApiProvisioner(mockFetch);
    await expect(provisioner.deprovision(API_TOKEN, {
      mode: "api",
      accountId: ACCOUNT_ID,
      accountName: "Personal account",
      zoneId: ZONE_ID,
      zoneName: "example.com",
      tunnelId: TUNNEL_ID,
      tunnelName: "chatgpt-review-test",
      dnsRecordId: DNS_ID,
      hostname: "review.example.com",
      provisionedAt: "2026-09-16T00:00:00.000Z",
    })).resolves.toBeUndefined();

    expect(calls).toEqual([
      { method: "DELETE", url: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${DNS_ID}` },
      { method: "DELETE", url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/connections` },
      { method: "DELETE", url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}` },
    ]);
  });

  it("requires a safe single-label hostname prefix", () => {
    expect(normalizeHostnameLabel("Review-App")).toBe("review-app");
    expect(() => normalizeHostnameLabel("bad.label")).toThrow(/hostname label/i);
    expect(() => normalizeHostnameLabel("-bad")).toThrow(/hostname label/i);
  });
});
