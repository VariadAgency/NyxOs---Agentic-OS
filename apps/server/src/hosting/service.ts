// Settings → „Betrieb & Zugriff“: state („So läuft NyxOS gerade“), stored profile (way + form values), checks and
// the secrets for it (only through the secret store, never returned in plain text).
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import {
  checkUrlOf,
  hostingSecretName,
  HOSTING_SECRET_IDS,
  normalizeHostingProfile,
  phoneUrlOf,
  type HostingCheckResult,
  type HostingCheckTarget,
  type HostingMode,
  type HostingProfileInput,
  type HostingProfileView,
  type HostingRemoteSeen,
  type HostingSecretId,
  type HostingSecretView,
  type HostingStatus,
  type PhoneReachState,
} from "@nyxos/shared";
import { eq, sql } from "drizzle-orm";
import type { BridgePresence } from "../bridge/presence.js";
import { checkHealth } from "../health.js";
import type { Db } from "../db/client.js";
import { hostingProfile, machines } from "../db/schema.js";
import type { UrlPolicy } from "../net/safeFetch.js";
import type { SecretStore } from "../secrets/store.js";
import { checkHealthUrl, outcome, parseCheckUrl, stamp } from "./check.js";

const LOOPBACK_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const MOBILE_UA_RE = /iPhone|iPad|iPod|Android|Mobile/i;
/** An outside access is written to the database at most this often (per address). */
const REMOTE_WRITE_EVERY_MS = 5 * 60_000;
/** Phone targets (for them it counts whether NyxOS accepts the host). */
const PHONE_TARGETS = new Set<HostingCheckTarget>(["tailscale", "cloudflare", "domain"]);

export interface HostingDeps {
  db: Db;
  mode: HostingMode;
  allowedHosts: Set<string>;
  authReads: boolean;
  presence: BridgePresence;
  secrets: SecretStore;
  archiveDir: string;
  /** Port shown in the commands (local: the local server's port; server: the published port, NYXOS_PORT). */
  port: number;
  /** File with the host's name (server mode: the host's /etc/hostname, mounted; NYXOS_HOST_HOSTNAME). */
  hostnameFile?: string | null;
  /** Tests: fixed computer name. */
  hostName?: string | null;
  fetchImpl?: typeof fetch;
  policy?: UrlPolicy;
  checkTimeoutMs?: number;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class SecretsNotReadyError extends Error {}

export class HostingService {
  private readonly now: () => number;
  private remote: HostingRemoteSeen | null = null;
  private remoteLoaded = false;
  private readonly lastRemoteWrite = new Map<string, number>();

  constructor(private readonly d: HostingDeps) {
    this.now = d.now ?? Date.now;
  }

  get mode(): HostingMode {
    return this.d.mode;
  }

  /** Computer/server name – honest: unknown in a container without a mounted /etc/hostname (not the container id). */
  hostName(): string | null {
    if (this.d.hostName !== undefined) return this.d.hostName;
    if (this.d.hostnameFile) {
      try {
        return readFileSync(this.d.hostnameFile, "utf8").trim() || null;
      } catch {
        return null;
      }
    }
    return this.d.mode === "server" ? null : osHostname() || null;
  }

  /**
   * Called from the host guard (app.ts) AFTER the host was allowed: did the request come through an outside address
   * (not 127.0.0.1/localhost)? That is the real proof „reachable from the phone“. Never blocking.
   */
  observe(host: string | undefined, userAgent: string | undefined): void {
    if (!host || LOOPBACK_RE.test(host.trim())) return;
    const h = host.trim().toLowerCase();
    const at = this.now();
    const mobile = MOBILE_UA_RE.test(userAgent ?? "");
    // A phone access is not replaced by a desktop access through the same address shortly after.
    if (this.remote && this.remote.host === h && this.remote.mobile && !mobile && at - Date.parse(this.remote.at) < REMOTE_WRITE_EVERY_MS) return;
    this.remote = { host: h, at: new Date(at).toISOString(), mobile };
    this.remoteLoaded = true;
    const key = `${h}|${mobile ? 1 : 0}`;
    if (at - (this.lastRemoteWrite.get(key) ?? 0) < REMOTE_WRITE_EVERY_MS) return;
    this.lastRemoteWrite.set(key, at);
    const seen = this.remote;
    void this.d.db
      .insert(hostingProfile)
      .values({ id: 1, remoteSeen: seen as unknown as Record<string, unknown> })
      .onConflictDoUpdate({ target: hostingProfile.id, set: { remoteSeen: seen as unknown as Record<string, unknown> } })
      .catch((e: unknown) => this.d.log?.("hosting-remote-fehler", { error: String(e) }));
  }

  private async row() {
    const [row] = await this.d.db.select().from(hostingProfile).where(eq(hostingProfile.id, 1)).limit(1);
    return row ?? null;
  }

  private async lastRemote(row: Awaited<ReturnType<HostingService["row"]>>): Promise<HostingRemoteSeen | null> {
    if (!this.remoteLoaded) {
      const r = row?.remoteSeen as Partial<HostingRemoteSeen> | null | undefined;
      if (r && typeof r.host === "string" && typeof r.at === "string") this.remote = { host: r.host, at: r.at, mobile: r.mobile === true };
      this.remoteLoaded = true;
    }
    return this.remote;
  }

  private static checksOf(row: { checks: Record<string, unknown> } | null): Partial<Record<HostingCheckTarget, HostingCheckResult>> {
    return (row?.checks ?? {}) as Partial<Record<HostingCheckTarget, HostingCheckResult>>;
  }

  async loadProfile(): Promise<HostingProfileInput> {
    return normalizeHostingProfile((await this.row())?.profile);
  }

  async secretViews(): Promise<HostingSecretView[]> {
    return Promise.all(
      HOSTING_SECRET_IDS.map(async (id) => {
        const info = await this.d.secrets.info(hostingSecretName(id));
        return { id, set: info.set, last4: info.last4, updatedAt: info.updatedAt };
      }),
    );
  }

  async profileView(): Promise<HostingProfileView> {
    const row = await this.row();
    return {
      ...normalizeHostingProfile(row?.profile),
      checks: HostingService.checksOf(row),
      secrets: await this.secretViews(),
      secretsReady: this.d.secrets.keyState === "ok",
      updatedAt: row?.updatedAt ?? null,
    };
  }

  async saveProfile(input: HostingProfileInput): Promise<HostingProfileView> {
    const profile = normalizeHostingProfile(input) as unknown as Record<string, unknown>;
    await this.d.db
      .insert(hostingProfile)
      .values({ id: 1, profile })
      .onConflictDoUpdate({ target: hostingProfile.id, set: { profile, updatedAt: sql`now()` } });
    return this.profileView();
  }

  async setSecret(id: HostingSecretId, value: string): Promise<HostingSecretView> {
    if (this.d.secrets.keyState !== "ok") throw new SecretsNotReadyError();
    const info = await this.d.secrets.setSecret(hostingSecretName(id), value);
    return { id, set: info.set, last4: info.last4, updatedAt: info.updatedAt };
  }

  async deleteSecret(id: HostingSecretId): Promise<boolean> {
    return this.d.secrets.deleteSecret(hostingSecretName(id));
  }

  /** Checks a target and remembers the result (with time). Without `url` → from the stored profile. */
  async check(target: HostingCheckTarget, rawUrl?: string): Promise<HostingCheckResult | { error: "no_url" }> {
    const at = new Date(this.now());
    let result: HostingCheckResult;
    if (target === "local") {
      if (this.d.mode === "server") {
        result = stamp(target, outcome("self_elsewhere"), at);
      } else {
        const t0 = performance.now();
        const health = await checkHealth(this.d.db, this.d.archiveDir);
        const failing = Object.entries(health.checks).flatMap(([k, v]) => (v.ok ? [] : [k]));
        const o = outcome(health.ok ? "self_ok" : "nyx_unhealthy", { reachable: true, isNyx: true, ms: Math.round(performance.now() - t0), detail: failing.join(", ") || null });
        result = stamp(target, o, at);
      }
    } else {
      const url = rawUrl?.trim() || checkUrlOf(target, (await this.loadProfile()).forms);
      if (!url) return { error: "no_url" };
      const o = await checkHealthUrl(url, { fetchImpl: this.d.fetchImpl, policy: this.d.policy, timeoutMs: this.d.checkTimeoutMs, allowedHosts: this.d.allowedHosts }, { hostMatters: PHONE_TARGETS.has(target) });
      result = stamp(target, o, at);
    }
    await this.storeCheck(result);
    return result;
  }

  private async storeCheck(result: HostingCheckResult): Promise<void> {
    const patch = { [result.target]: result };
    await this.d.db
      .insert(hostingProfile)
      .values({ id: 1, checks: patch })
      .onConflictDoUpdate({ target: hostingProfile.id, set: { checks: sql`${hostingProfile.checks} || ${JSON.stringify(patch)}::jsonb` } });
  }

  async status(request: { host: string | null; https: boolean }): Promise<HostingStatus> {
    const row = await this.row();
    const profile = normalizeHostingProfile(row?.profile);
    const checks = HostingService.checksOf(row);
    const lastRemote = await this.lastRemote(row);

    const v = this.d.presence.view();
    let machine: string | null = null;
    const id = this.d.presence.currentMachineId;
    if (id) {
      const [m] = await this.d.db.select({ name: machines.name }).from(machines).where(eq(machines.id, id)).limit(1);
      machine = m?.name ?? null;
    }

    const url = phoneUrlOf(profile);
    const urlHost = url ? (parseCheckUrl(url)?.host ?? null) : null;
    const way = profile.phoneWay;
    const rawCheck = way ? (checks[way] ?? null) : null;
    // An old check of another address does not count (the form changed since).
    const check = rawCheck && url && rawCheck.url === parseCheckUrl(url)?.origin ? rawCheck : null;
    const seenMatches = !!lastRemote && (!urlHost || lastRemote.host === urlHost);
    let state: PhoneReachState;
    if (check?.verdict === "ok" || seenMatches) state = "reachable";
    // „Name not found“ only means the SERVER does not know the name (Tailscale names are often only known inside the
    // tailnet) – the phone may still get there. So do not claim „unreachable“, only „not confirmed yet“.
    else if (check && check.code !== "dns") state = "unreachable";
    else if (url) state = "not_checked";
    else state = "not_setup";

    const host = request.host?.trim() || null;
    return {
      mode: this.d.mode,
      hostName: this.hostName(),
      allowedHosts: [...this.d.allowedHosts],
      authReads: this.d.authReads,
      request: { host, https: request.https, remote: !!host && !LOOPBACK_RE.test(host) },
      bridge: { state: v.state, machine, since: new Date(v.since).toISOString(), reason: v.reason },
      phone: { state, way, url, check, lastRemote },
      port: this.d.port,
      serverNow: new Date(this.now()).toISOString(),
    };
  }
}
