import { randomBytes } from "node:crypto";

import type { CloudflareProvisioningRecord, CloudflareSetupSessionView, CloudflareZoneOption } from "./types";
import { normalizeCloudflareHostname } from "./cloudflare-tunnel";

const API_BASE = "https://api.cloudflare.com/client/v4";
const SESSION_TTL_MS = 10 * 60_000;
const MAX_SETUP_SESSIONS = 4;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ZONE_PAGES = 10;
const TOKEN_MAX_BYTES = 8 * 1024;

interface SetupSessionInternal {
  id: string;
  token: string;
  zones: CloudflareZoneOption[];
  expiresAtMs: number;
  expiryTimer: NodeJS.Timeout;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    total_count?: number;
  };
}

interface CloudflareZoneResponse {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  account?: {
    id?: unknown;
    name?: unknown;
  };
}

interface CloudflareTunnelResponse {
  id?: unknown;
  name?: unknown;
  token?: unknown;
}

interface CloudflareDnsResponse {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  content?: unknown;
}

export interface CloudflareProvisionResult {
  record: CloudflareProvisioningRecord;
  runtimeToken: string;
}

export class CloudflareApiProvisioner {
  private readonly sessions = new Map<string, SetupSessionInternal>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async beginSetup(apiToken: string): Promise<CloudflareSetupSessionView> {
    const token = validateApiToken(apiToken);
    this.pruneSessions();
    const zones = await this.listZones(token);
    if (zones.length === 0) {
      throw new Error("Cloudflare API token returned no active zones. Grant Zone > Zone > Read and scope the token to at least one active zone.");
    }

    while (this.sessions.size >= MAX_SETUP_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.deleteSession(oldest);
    }

    const id = `cfsetup_${randomBytes(12).toString("hex")}`;
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    const expiryTimer = setTimeout(() => this.deleteSession(id), SESSION_TTL_MS);
    expiryTimer.unref();
    this.sessions.set(id, { id, token, zones, expiresAtMs, expiryTimer });
    return {
      id,
      zones: zones.map((zone) => ({ ...zone })),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async provision(input: {
    setupId: string;
    zoneId: string;
    originUrl: string;
    hostnameLabel?: string;
  }): Promise<CloudflareProvisionResult> {
    assertLocalHttpOrigin(input.originUrl);
    const session = this.consumeSession(input.setupId);
    const zone = session.zones.find((item) => item.zoneId === input.zoneId);
    if (!zone) throw new Error("Selected Cloudflare zone is not part of this setup session.");

    const label = normalizeHostnameLabel(input.hostnameLabel);
    const hostname = normalizeCloudflareHostname(`${label}.${zone.zoneName}`);
    const tunnelName = `chatgpt-review-${randomBytes(6).toString("hex")}`;
    let tunnelId = "";
    let dnsRecordId = "";

    try {
      const existingRecords = await this.listDnsRecords(session.token, zone.zoneId, hostname);
      if (existingRecords.length > 0) {
        throw new Error(`DNS name ${hostname} already exists in Cloudflare. Choose another hostname label.`);
      }

      const tunnel = await this.request<CloudflareTunnelResponse>(session.token, `/accounts/${encodeURIComponent(zone.accountId)}/cfd_tunnel`, {
        method: "POST",
        body: {
          name: tunnelName,
          config_src: "cloudflare",
        },
      });
      tunnelId = requiredId(tunnel.id, "Cloudflare tunnel id");

      await this.request(session.token, `/accounts/${encodeURIComponent(zone.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, {
        method: "PUT",
        body: {
          config: {
            ingress: [
              {
                hostname,
                service: input.originUrl,
                originRequest: {},
              },
              {
                service: "http_status:404",
              },
            ],
          },
        },
      });

      const dnsRecord = await this.request<CloudflareDnsResponse>(session.token, `/zones/${encodeURIComponent(zone.zoneId)}/dns_records`, {
        method: "POST",
        body: {
          type: "CNAME",
          name: hostname,
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true,
          ttl: 1,
          comment: "Managed by ChatGPT Review",
        },
      });
      dnsRecordId = requiredId(dnsRecord.id, "Cloudflare DNS record id");

      const createToken = typeof tunnel.token === "string" ? tunnel.token.trim() : "";
      const runtimeToken = validTunnelToken(createToken)
        ? createToken
        : await this.getTunnelToken(session.token, zone.accountId, tunnelId);

      const record: CloudflareProvisioningRecord = {
        mode: "api",
        accountId: zone.accountId,
        accountName: zone.accountName,
        zoneId: zone.zoneId,
        zoneName: zone.zoneName,
        tunnelId,
        tunnelName,
        dnsRecordId,
        hostname,
        provisionedAt: new Date().toISOString(),
      };
      return { record, runtimeToken };
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (dnsRecordId) {
        await this.deleteResource(session.token, `/zones/${encodeURIComponent(zone.zoneId)}/dns_records/${encodeURIComponent(dnsRecordId)}`)
          .catch((rollbackError) => rollbackErrors.push(`DNS rollback: ${safeError(rollbackError)}`));
      }
      if (tunnelId) {
        await this.deleteResource(session.token, `/accounts/${encodeURIComponent(zone.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`)
          .catch((rollbackError) => rollbackErrors.push(`tunnel rollback: ${safeError(rollbackError)}`));
      }
      const suffix = rollbackErrors.length ? ` Rollback also reported: ${rollbackErrors.join("; ")}` : "";
      throw new Error(`${safeError(error)}${suffix}`);
    }
  }

  async deprovision(apiToken: string, record: CloudflareProvisioningRecord): Promise<void> {
    const token = validateApiToken(apiToken);
    validateProvisioningRecord(record);

    await this.deleteResource(token, `/zones/${encodeURIComponent(record.zoneId)}/dns_records/${encodeURIComponent(record.dnsRecordId)}`);
    await this.deleteResource(token, `/accounts/${encodeURIComponent(record.accountId)}/cfd_tunnel/${encodeURIComponent(record.tunnelId)}/connections`);
    await this.deleteResource(token, `/accounts/${encodeURIComponent(record.accountId)}/cfd_tunnel/${encodeURIComponent(record.tunnelId)}`);
  }

  clearSessions(): void {
    for (const id of [...this.sessions.keys()]) this.deleteSession(id);
  }

  private consumeSession(setupId: string): SetupSessionInternal {
    this.pruneSessions();
    if (!/^cfsetup_[a-f0-9]{24}$/.test(setupId)) throw new Error("Cloudflare setup session is invalid.");
    const session = this.sessions.get(setupId);
    if (!session) throw new Error("Cloudflare setup session expired. Enter the API token again.");
    this.deleteSession(setupId);
    if (session.expiresAtMs <= Date.now()) throw new Error("Cloudflare setup session expired. Enter the API token again.");
    return session;
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAtMs <= now) this.deleteSession(id);
    }
  }

  private deleteSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.expiryTimer);
    this.sessions.delete(id);
  }

  private async listZones(token: string): Promise<CloudflareZoneOption[]> {
    const zones: CloudflareZoneOption[] = [];
    for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
      const query = new URLSearchParams({
        status: "active",
        page: String(page),
        per_page: "50",
        order: "name",
        direction: "asc",
      });
      const envelope = await this.requestEnvelope<CloudflareZoneResponse[]>(token, `/zones?${query.toString()}`, { method: "GET" });
      const rows = Array.isArray(envelope.result) ? envelope.result : [];
      for (const row of rows) {
        const zoneId = optionalId(row.id);
        const zoneName = typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
        const accountId = optionalId(row.account?.id);
        const accountName = typeof row.account?.name === "string" ? row.account.name.trim().slice(0, 256) : "";
        if (!zoneId || !accountId || !zoneName || row.status !== "active") continue;
        try {
          normalizeCloudflareHostname(zoneName);
        } catch {
          continue;
        }
        zones.push({ zoneId, zoneName, accountId, accountName: accountName || accountId });
      }
      const totalPages = Number(envelope.result_info?.total_pages ?? 1);
      if (!Number.isFinite(totalPages) || page >= totalPages) break;
    }
    return dedupeZones(zones);
  }

  private async listDnsRecords(token: string, zoneId: string, hostname: string): Promise<CloudflareDnsResponse[]> {
    const query = new URLSearchParams({
      "name.exact": hostname,
      match: "all",
      per_page: "100",
    });
    const result = await this.request<CloudflareDnsResponse[]>(token, `/zones/${encodeURIComponent(zoneId)}/dns_records?${query.toString()}`, { method: "GET" });
    return Array.isArray(result) ? result : [];
  }

  private async getTunnelToken(token: string, accountId: string, tunnelId: string): Promise<string> {
    const result = await this.request<string>(token, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`, { method: "GET" });
    if (typeof result !== "string" || !validTunnelToken(result.trim())) {
      throw new Error("Cloudflare returned an invalid runtime tunnel token.");
    }
    return result.trim();
  }

  private async deleteResource(token: string, path: string): Promise<void> {
    await this.request(token, path, { method: "DELETE", allowNotFound: true });
  }

  private async request<T>(
    token: string,
    apiPath: string,
    options: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; allowNotFound?: boolean },
  ): Promise<T> {
    const envelope = await this.requestEnvelope<T>(token, apiPath, options);
    return envelope.result as T;
  }

  private async requestEnvelope<T>(
    token: string,
    apiPath: string,
    options: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; allowNotFound?: boolean },
  ): Promise<CloudflareEnvelope<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${API_BASE}${apiPath}`, {
        method: options.method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (options.allowNotFound && response.status === 404) return { success: true, result: undefined as T };

      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Cloudflare API response exceeded the 2 MiB safety limit.");
      let envelope: CloudflareEnvelope<T>;
      try {
        envelope = text ? JSON.parse(text) as CloudflareEnvelope<T> : { success: response.ok, result: undefined as T };
      } catch {
        throw new Error(`Cloudflare API returned invalid JSON (HTTP ${response.status}).`);
      }

      if (!response.ok || envelope.success === false) {
        const detail = apiErrors(envelope.errors);
        throw new Error(`Cloudflare API request failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
      }
      return envelope;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Cloudflare API request timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function normalizeHostnameLabel(value?: string): string {
  const input = (value ?? "").trim().toLowerCase();
  if (!input) return `chatgpt-review-${randomBytes(4).toString("hex")}`;
  if (input.length > 63 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input)) {
    throw new Error("Cloudflare hostname label must be 1-63 lowercase letters, numbers, or hyphens.");
  }
  return input;
}

function validateApiToken(value: string): string {
  const token = value.trim();
  const bytes = Buffer.byteLength(token, "utf8");
  if (bytes < 20 || bytes > TOKEN_MAX_BYTES || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("Cloudflare API token is invalid.");
  }
  return token;
}

function validTunnelToken(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= 20 && bytes <= 32 * 1024 && /^[\x21-\x7e]+$/.test(value);
}

function requiredId(value: unknown, label: string): string {
  const id = optionalId(value);
  if (!id) throw new Error(`${label} is missing or invalid.`);
  return id;
}

function optionalId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : "";
}

function dedupeZones(zones: CloudflareZoneOption[]): CloudflareZoneOption[] {
  const seen = new Set<string>();
  return zones.filter((zone) => {
    if (seen.has(zone.zoneId)) return false;
    seen.add(zone.zoneId);
    return true;
  });
}

function validateProvisioningRecord(record: CloudflareProvisioningRecord): void {
  requiredId(record.accountId, "Cloudflare account id");
  requiredId(record.zoneId, "Cloudflare zone id");
  requiredId(record.tunnelId, "Cloudflare tunnel id");
  requiredId(record.dnsRecordId, "Cloudflare DNS record id");
  normalizeCloudflareHostname(record.hostname);
}

function assertLocalHttpOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloudflare tunnel origin URL is invalid.");
  }
  const host = url.hostname.toLowerCase();
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (url.protocol !== "http:" || !local || url.username || url.password) {
    throw new Error("Cloudflare named tunnel origin must be an unauthenticated localhost HTTP URL.");
  }
}

function apiErrors(errors: CloudflareEnvelope<unknown>["errors"]): string {
  if (!Array.isArray(errors)) return "";
  return errors
    .slice(0, 5)
    .map((item) => {
      const code = Number.isFinite(item?.code) ? `CF${item?.code}` : "Cloudflare";
      const message = typeof item?.message === "string" ? item.message.replace(/[\r\n]+/g, " ").slice(0, 500) : "request rejected";
      return `${code}: ${message}`;
    })
    .join("; ");
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1500)
    : "unknown Cloudflare API error";
}
