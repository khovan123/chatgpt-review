import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import type { CloudflareTunnelRuntimeStatus } from "./types";

const execFileAsync = promisify(execFile);
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 30_000;
const MAX_LOG_CHARS = 24_000;
const TOKEN_MAX_BYTES = 32 * 1024;

type ManagedCloudflaredProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface NamedTunnelConfig {
  hostname: string;
  originUrl: string;
}

export class CloudflareNamedTunnelManager {
  private child: ManagedCloudflaredProcess | null = null;
  private desired: NamedTunnelConfig | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private generation = 0;
  private runtime: CloudflareTunnelRuntimeStatus = {
    installed: false,
    configured: false,
    running: false,
    reachable: false,
    mode: "named-token",
    originUrl: "",
    hostname: "",
    publicUrl: "",
    restartCount: 0,
  };

  private readonly credentialDirectory: string;
  private readonly isolatedHome: string;
  private readonly tokenPath: string;
  private readonly legacyConfigPath: string;

  constructor(private readonly options: {
    storageDirectory: string;
    onStatus?: (status: CloudflareTunnelRuntimeStatus) => void;
    onLog?: (message: string) => void;
  }) {
    this.credentialDirectory = path.join(options.storageDirectory, "cloudflare");
    this.isolatedHome = path.join(this.credentialDirectory, "home");
    this.tokenPath = path.join(this.credentialDirectory, "named-tunnel-token");
    this.legacyConfigPath = path.join(this.credentialDirectory, "cloudflared.yml");
  }

  status(): CloudflareTunnelRuntimeStatus {
    return { ...this.runtime };
  }

  setRouteValidation(reachable: boolean, error?: string): CloudflareTunnelRuntimeStatus {
    this.runtime = {
      ...this.runtime,
      reachable,
      ...(reachable ? { lastError: undefined } : error ? { lastError: error.slice(0, 1000) } : {}),
    };
    this.emitStatus();
    return this.status();
  }

  async detect(): Promise<CloudflareTunnelRuntimeStatus> {
    try {
      const result = await execFileAsync("cloudflared", ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        env: cliEnvironment(this.isolatedHome),
      });
      this.runtime = {
        ...this.runtime,
        installed: true,
        version: singleLine(result.stdout || result.stderr).slice(0, 256),
      };
    } catch {
      this.runtime = {
        ...this.runtime,
        installed: false,
        running: false,
        reachable: false,
        version: undefined,
        lastError: "cloudflared is not installed or is not available on PATH.",
      };
    }
    this.emitStatus();
    return this.status();
  }

  async hasCredential(): Promise<boolean> {
    try {
      const token = (await readFile(this.tokenPath, "utf8")).trim();
      return validTunnelToken(token);
    } catch {
      return false;
    }
  }

  async connect(input: NamedTunnelConfig & { tunnelToken: string }): Promise<CloudflareTunnelRuntimeStatus> {
    const hostname = normalizeCloudflareHostname(input.hostname);
    assertLocalHttpOrigin(input.originUrl);
    const token = input.tunnelToken.trim();
    if (!validTunnelToken(token)) throw new Error("Cloudflare named tunnel token is invalid.");

    await this.prepareCredentialStorage();
    const temporary = `${this.tokenPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.tokenPath);
    await chmod(this.tokenPath, 0o600).catch(() => undefined);

    return this.start({ hostname, originUrl: input.originUrl }, true);
  }

  async restore(config: NamedTunnelConfig): Promise<CloudflareTunnelRuntimeStatus> {
    const hostname = normalizeCloudflareHostname(config.hostname);
    assertLocalHttpOrigin(config.originUrl);
    if (!await this.hasCredential()) {
      this.runtime = {
        ...this.runtime,
        configured: false,
        running: false,
        reachable: false,
        hostname,
        publicUrl: cloudflareOriginUrl(hostname),
        originUrl: config.originUrl,
        lastError: "Cloudflare tunnel token is missing. Connect your named tunnel in Settings.",
      };
      this.emitStatus();
      return this.status();
    }
    return this.start({ hostname, originUrl: config.originUrl }, true);
  }

  async restart(): Promise<CloudflareTunnelRuntimeStatus> {
    if (!this.desired) throw new Error("Cloudflare named tunnel is not configured.");
    this.runtime = { ...this.runtime, restartCount: this.runtime.restartCount + 1, reachable: false };
    return this.start(this.desired, true);
  }

  async stop(): Promise<void> {
    this.desired = null;
    await this.stopProcess(true);
  }

  async disconnect(): Promise<void> {
    await this.stop();
    await rm(this.tokenPath, { force: true });
    this.runtime = {
      ...this.runtime,
      configured: false,
      running: false,
      reachable: false,
      hostname: "",
      publicUrl: "",
      originUrl: "",
      lastError: undefined,
    };
    this.emitStatus();
  }

  private async start(config: NamedTunnelConfig, forceRestart: boolean): Promise<CloudflareTunnelRuntimeStatus> {
    const hostname = normalizeCloudflareHostname(config.hostname);
    assertLocalHttpOrigin(config.originUrl);
    this.desired = { hostname, originUrl: config.originUrl };

    if (
      !forceRestart
      && this.child
      && !this.child.killed
      && this.runtime.running
      && this.runtime.hostname === hostname
      && this.runtime.originUrl === config.originUrl
    ) {
      return this.status();
    }

    if (!await this.hasCredential()) throw new Error("Cloudflare named tunnel token is missing.");
    const detected = await this.detect();
    if (!detected.installed) throw new Error(detected.lastError || "cloudflared is unavailable.");

    await this.prepareCredentialStorage();
    await this.stopProcess(false);
    this.stopping = false;
    const generation = ++this.generation;
    this.runtime = {
      ...this.runtime,
      configured: true,
      running: false,
      reachable: false,
      originUrl: config.originUrl,
      hostname,
      publicUrl: cloudflareOriginUrl(hostname),
      lastError: undefined,
    };
    this.emitStatus();

    const child = spawn(
      "cloudflared",
      cloudflaredRunArgs(this.tokenPath),
      {
        env: cliEnvironment(this.isolatedHome),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    ) as ManagedCloudflaredProcess;
    this.child = child;

    return new Promise<CloudflareTunnelRuntimeStatus>((resolve, reject) => {
      let settled = false;
      let output = "";
      const timer = setTimeout(() => {
        if (settled || generation !== this.generation) return;
        settled = true;
        this.runtime = {
          ...this.runtime,
          running: false,
          reachable: false,
          lastError: "cloudflared named tunnel startup timed out.",
        };
        this.emitStatus();
        child.kill("SIGTERM");
        reject(new Error(this.runtime.lastError));
      }, START_TIMEOUT_MS);

      const consume = (chunk: Buffer | string) => {
        if (generation !== this.generation) return;
        output = `${output}${String(chunk)}`.slice(-MAX_LOG_CHARS);
        for (const line of String(chunk).split(/\r?\n/)) {
          const sanitized = sanitizeCloudflaredLog(line);
          if (sanitized) this.options.onLog?.(sanitized);
        }
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);

      child.once("spawn", () => {
        if (settled || generation !== this.generation) return;
        settled = true;
        clearTimeout(timer);
        this.runtime = {
          ...this.runtime,
          configured: true,
          running: true,
          reachable: false,
          lastError: undefined,
        };
        this.emitStatus();
        resolve(this.status());
      });

      child.once("error", (error) => {
        if (generation !== this.generation) return;
        clearTimeout(timer);
        this.child = null;
        this.runtime = {
          ...this.runtime,
          running: false,
          reachable: false,
          lastError: `cloudflared failed to start: ${safeError(error)}`,
        };
        this.emitStatus();
        if (!settled) {
          settled = true;
          reject(new Error(this.runtime.lastError));
        }
        this.scheduleRestart(generation);
      });

      child.once("exit", (code, signal) => {
        if (generation !== this.generation) return;
        clearTimeout(timer);
        this.child = null;
        const intentional = this.stopping || this.desired === null;
        const detail = singleLine(output).slice(-500);
        const exitValue = signal ?? (code === null ? "unknown" : String(code));
        this.runtime = {
          ...this.runtime,
          running: false,
          reachable: false,
          ...(!intentional
            ? { lastError: `cloudflared exited (${exitValue})${detail ? `: ${detail}` : ""}` }
            : {}),
        };
        this.emitStatus();
        if (!settled && !intentional) {
          settled = true;
          reject(new Error(this.runtime.lastError || "cloudflared exited before startup completed."));
        }
        if (!intentional) this.scheduleRestart(generation);
      });
    });
  }

  private async prepareCredentialStorage(): Promise<void> {
    await mkdir(this.credentialDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.isolatedHome, { recursive: true, mode: 0o700 });
    // Older builds wrote an empty local config and passed --config while running a
    // remotely-managed tunnel. That forces local ingress evaluation and can make
    // cloudflared return 503 instead of consuming the remotely-managed ingress.
    await rm(this.legacyConfigPath, { force: true });
  }

  private async stopProcess(clearDesired: boolean): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (clearDesired) this.desired = null;
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;
    ++this.generation;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timeout = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        finish();
      }, STOP_TIMEOUT_MS);
      timeout.unref();
      child.once("exit", () => {
        clearTimeout(timeout);
        finish();
      });
      child.kill("SIGTERM");
    });
    this.stopping = false;
    this.runtime = { ...this.runtime, running: false, reachable: false };
    this.emitStatus();
  }

  private scheduleRestart(generation: number): void {
    if (this.stopping || !this.desired || this.restartTimer || generation !== this.generation) return;
    const attempts = this.runtime.restartCount + 1;
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(attempts - 1, 4));
    this.runtime = { ...this.runtime, restartCount: attempts, reachable: false };
    this.emitStatus();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const desired = this.desired;
      if (!desired) return;
      void this.start(desired, true).catch(() => undefined);
    }, delay);
    this.restartTimer.unref();
  }

  private emitStatus(): void {
    this.options.onStatus?.(this.status());
  }
}

export function cloudflaredRunArgs(tokenPath: string): string[] {
  if (!path.isAbsolute(tokenPath)) throw new Error("Cloudflare tunnel token path must be absolute.");
  return [
    "tunnel",
    "--no-autoupdate",
    "--loglevel", "warn",
    "run",
    "--token-file", tokenPath,
  ];
}

export function normalizeCloudflareHostname(value: string): string {
  const input = value.trim().toLowerCase().replace(/\.$/, "");
  if (input.includes("://") || input.includes("/") || input.includes("@")) {
    throw new Error("Cloudflare public hostname must be a hostname only, without scheme, path, or credentials.");
  }
  if (input.length < 3 || input.length > 253 || !input.includes(".")) {
    throw new Error("Cloudflare public hostname is invalid.");
  }
  const labels = input.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Cloudflare public hostname is invalid.");
  }
  if (input.endsWith(".trycloudflare.com")) {
    throw new Error("Quick Tunnel hostnames are not allowed. Use your own named Cloudflare Tunnel hostname.");
  }
  return input;
}

export function cloudflareOriginUrl(hostname: string): string {
  return `https://${normalizeCloudflareHostname(hostname)}`;
}

export function cloudflareWebhookUrl(hostname: string): string {
  return `${cloudflareOriginUrl(hostname)}/webhooks/v1/github`;
}

function validTunnelToken(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= 20 && bytes <= TOKEN_MAX_BYTES && /^[\x21-\x7e]+$/.test(value);
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

function cliEnvironment(isolatedHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    NO_AUTOUPDATE: "true",
  };
  for (const name of ["SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function sanitizeCloudflaredLog(value: string): string {
  return stripAnsi(value)
    .replace(/[\r\0]/g, " ")
    .replace(/(token|credential|secret)=([^\s]+)/gi, "$1=[REDACTED]")
    .replace(/eyJ[A-Za-z0-9._~-]{20,}/g, "[REDACTED]")
    .trim()
    .slice(0, 4096);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function singleLine(value: string): string {
  return sanitizeCloudflaredLog(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? singleLine(error.message).slice(0, 1000) : "unknown Cloudflare tunnel error";
}
