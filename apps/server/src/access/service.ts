// Zugänge: alle Schlüssel/Tokens an EINER Stelle – Zustand, Prüfen, Speichern (einzeln oder alle auf
// einmal), Entfernen. Gespeichert wird dort, wo die Pakete es schon lesen: Anbieter-Schlüssel/Adressen in den Modell-Einstellungen
// (`ModelService`), Telegram in N4 (`TelegramService`), Ideen-Postfach im Geheimnis-Speicher. Nichts hier gibt
// je einen Wert zurück – nur Zustand, „endet auf …1234“ und einfache Sätze. Nie loggen.
import {
  ACCESS_ITEMS,
  accessItem,
  TELEGRAM_TOKEN_RE,
  type AccessBulkResult,
  type AccessCheck,
  type AccessId,
  type AccessItem,
  type AccessListResponse,
  type AccessStatus,
  type ConnectorView,
  type ProviderKind,
  type ProviderView,
  type TelegramStatus,
  t,
} from "@nyxos/shared";
import { ProviderError } from "../models/chat.js";
import type { ModelService } from "../models/providers.js";
import { SECRETS_REASON, SecretsKeyError, type SecretStore } from "../secrets/store.js";
import { TELEGRAM_TOKEN_ENV, TELEGRAM_TOKEN_SECRET } from "../telegram/tokens.js";

/** Was der Dienst von Telegram braucht (strukturell – `TelegramService` passt). */
export interface AccessTelegram {
  status(): Promise<TelegramStatus>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
}

export interface AccessServiceDeps {
  models: ModelService;
  secrets: SecretStore;
  telegram?: AccessTelegram | null;
  /** Konnektoren (Higgsfield-Anmeldung). */
  connectors?: { list(): Promise<ConnectorView[]> } | null;
  env?: NodeJS.ProcessEnv;
  /** Tests: fetch für Telegram-/Dashboard-Prüfung. */
  fetchImpl?: typeof fetch;
}

/** Fehler mit einfachem Satz (Route → 400). */
export class AccessError extends Error {}

const CHECK_TIMEOUT_MS = 12_000;

/** „http://127.0.0.1:11434“ → „…/v1“ (OpenAI-kompatibler Pfad). */
export function normalizeLocalUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v)) throw new AccessError(t("Die Adresse muss mit http:// oder https:// beginnen, z. B. http://127.0.0.1:11434/v1."));
  return /^https?:\/\/[^/]+$/.test(v) ? `${v}/v1` : v;
}

export class AccessService {
  /** Letzte Prüfung je Zugang ohne eigenen Speicherplatz (Telegram, Postfach). Anbieter merken sie sich in den Modell-Einstellungen. */
  private readonly checks = new Map<AccessId, AccessCheck>();
  constructor(private readonly deps: AccessServiceDeps) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private blocked(item: AccessItem): string | null {
    if (item.storage === "link" || item.storage === "provider-url") return null;
    const k = this.deps.secrets.keyState;
    return k === "ok" ? null : t(SECRETS_REASON[k]);
  }

  // ─── Zustand ───

  private fromProvider(item: AccessItem, p: ProviderView | null): Omit<AccessStatus, "id" | "blocked"> {
    const base = { last4: p?.key.last4 ?? null, url: item.storage === "provider-url" ? (p?.baseUrl ?? null) : null, updatedAt: p?.lastTest?.at ?? null };
    const lastCheck: AccessCheck | null = p?.lastTest ? { ok: p.lastTest.ok, at: p.lastTest.at, ms: p.lastTest.ms, message: p.lastTest.message } : null;
    const present = item.storage === "provider-key" ? !!p?.key.set : !!p?.configured;
    if (!p || !present) return { ...base, state: "missing", detail: null, lastCheck };
    const off = p.enabled ? "" : t(" · ausgeschaltet");
    if (!p.lastTest) return { ...base, state: "unchecked", detail: `${t("gespeichert, noch nicht geprüft")}${off}`, lastCheck };
    if (p.lastTest.ok) return { ...base, state: "ok", detail: `${t("verbunden · {n} Modelle", { n: p.lastTest.models })}${off}`, lastCheck };
    return { ...base, state: "error", detail: p.lastTest.message, lastCheck };
  }

  private async statusOf(item: AccessItem, cache: { providers?: ProviderView[]; connectors?: ConnectorView[] | null }): Promise<AccessStatus> {
    const blocked = this.blocked(item);
    const empty = { last4: null, url: null, updatedAt: null, lastCheck: this.checks.get(item.id) ?? null, blocked };
    switch (item.storage) {
      case "provider-key":
      case "provider-url": {
        cache.providers ??= await this.deps.models.listProviders();
        const p = cache.providers.find((x) => x.id === item.providerKind) ?? null;
        return { id: item.id, blocked, ...this.fromProvider(item, p) };
      }
      case "telegram": {
        if (!this.deps.telegram) return { id: item.id, state: "missing", detail: t("Telegram ist auf diesem Server nicht eingebaut."), ...empty };
        const st = await this.deps.telegram.status();
        const tBlocked = st.token.canEdit ? blocked : (st.token.editHint ?? blocked);
        const base = { last4: st.token.last4, url: null, updatedAt: null, lastCheck: this.checks.get(item.id) ?? null, blocked: tBlocked };
        if (!st.token.set) return { id: item.id, state: "missing", detail: null, ...base };
        const who = st.bot ? `@${st.bot.username}` : "Bot";
        if (st.state === "connected") return { id: item.id, state: "ok", detail: st.paired ? t("{who} verbunden · gekoppelt mit {name}", { who, name: st.paired.name }) : t("{who} verbunden · noch nicht gekoppelt", { who }), ...base };
        if (st.state === "error") return { id: item.id, state: "error", detail: st.fix ?? st.sentence, ...base };
        return { id: item.id, state: "unchecked", detail: st.sentence, ...base };
      }
      case "secret": {
        const name = item.secretName as string;
        const info = await this.deps.secrets.info(name);
        const check = this.checks.get(item.id) ?? null;
        if (!info.set) return { id: item.id, state: "missing", detail: null, ...empty };
        const state = check ? (check.ok ? "ok" : "error") : "unchecked";
        return { id: item.id, state, detail: check ? check.message : t("gespeichert, noch nicht geprüft"), last4: info.last4, url: null, updatedAt: info.updatedAt, lastCheck: check, blocked };
      }
      case "link": {
        if (item.id === "higgsfield") {
          if (cache.connectors === undefined) cache.connectors = this.deps.connectors ? await this.deps.connectors.list().catch(() => null) : null;
          const c = cache.connectors?.find((x) => x.template === "higgsfield" || x.name === "higgsfield");
          if (c?.token.set) return { id: item.id, state: c.lastTest && !c.lastTest.ok ? "error" : "ok", detail: c.lastTest && !c.lastTest.ok ? c.lastTest.message : t("angemeldet"), ...empty };
          if (c) return { id: item.id, state: "missing", detail: t("hinzugefügt, noch nicht angemeldet"), ...empty };
        }
        return { id: item.id, state: "link", detail: null, ...empty };
      }
    }
  }

  async list(): Promise<AccessListResponse> {
    const cache: { providers?: ProviderView[]; connectors?: ConnectorView[] | null } = {};
    const items: AccessStatus[] = [];
    for (const item of ACCESS_ITEMS) items.push(await this.statusOf(item, cache));
    return { items, secretsKey: this.deps.secrets.keyState };
  }

  async get(id: AccessId): Promise<AccessStatus> {
    return this.statusOf(accessItem(id), {});
  }

  // ─── Speichern / Entfernen ───

  async save(id: AccessId, rawValue: string): Promise<void> {
    const item = accessItem(id);
    const value = rawValue.trim();
    if (!value) throw new AccessError(t("Bitte einen Wert einfügen."));
    const blocked = this.blocked(item);
    if (blocked) throw new AccessError(blocked);
    switch (item.storage) {
      case "provider-key":
        await this.deps.models.saveProvider({ kind: item.providerKind as ProviderKind, apiKey: value, enabled: true });
        return;
      case "provider-url":
        await this.deps.models.saveProvider({ kind: item.providerKind as ProviderKind, baseUrl: normalizeLocalUrl(value), enabled: true });
        return;
      case "telegram":
        if (!TELEGRAM_TOKEN_RE.test(value)) throw new AccessError(t("Das sieht nicht wie ein Bot-Token aus. Es hat die Form 123456789:ABC… – bitte bei @BotFather kopieren."));
        if (!this.deps.telegram) throw new AccessError(t("Telegram ist auf diesem Server nicht eingebaut."));
        await this.deps.telegram.setToken(value);
        this.checks.delete(id);
        return;
      case "secret":
        await this.deps.secrets.setSecret(item.secretName as string, value);
        this.checks.delete(id);
        return;
      case "link":
        throw new AccessError(t("Dieser Zugang wird an anderer Stelle eingerichtet – bitte dem Link auf der Karte folgen."));
    }
  }

  async remove(id: AccessId): Promise<void> {
    const item = accessItem(id);
    switch (item.storage) {
      case "provider-key":
        if (await this.deps.models.getProvider(item.providerKind as string).then((p) => p?.configured)) await this.deps.models.saveProvider({ kind: item.providerKind as ProviderKind, clearKey: true });
        return;
      case "provider-url":
        await this.deps.models.deleteProvider(item.providerKind as string);
        return;
      case "telegram":
        await this.deps.telegram?.clearToken();
        this.checks.delete(id);
        return;
      case "secret":
        await this.deps.secrets.deleteSecret(item.secretName as string);
        this.checks.delete(id);
        return;
      case "link":
        throw new AccessError(t("Dieser Zugang wird an anderer Stelle entfernt – bitte dem Link auf der Karte folgen."));
    }
  }

  // ─── Prüfen ───

  async check(id: AccessId): Promise<AccessCheck> {
    const item = accessItem(id);
    const started = Date.now();
    const done = (ok: boolean, message: string): AccessCheck => {
      const c = { ok, at: new Date().toISOString(), ms: Date.now() - started, message };
      if (item.storage === "telegram" || item.storage === "secret") this.checks.set(id, c);
      return c;
    };
    try {
      switch (item.storage) {
        case "provider-key":
        case "provider-url": {
          const p = await this.deps.models.getProvider(item.providerKind as string);
          if (!p?.configured || (item.storage === "provider-key" && !p.key.set)) return done(false, t("Noch nichts eingetragen."));
          const tested = await this.deps.models.testProvider(p.id);
          return { ok: tested.ok, at: tested.at, ms: tested.ms, message: tested.message };
        }
        case "telegram":
          return await this.checkTelegram(done);
        case "secret":
          return (await this.deps.secrets.info(item.secretName as string)).set ? done(true, t("Gespeichert.")) : done(false, t("Noch nichts eingetragen."));
        case "link":
          return done(false, t("Dieser Zugang wird an anderer Stelle geprüft – bitte dem Link auf der Karte folgen."));
      }
    } catch (e) {
      const msg = e instanceof SecretsKeyError || e instanceof ProviderError || e instanceof AccessError ? e.message : (e as { name?: string })?.name === "TimeoutError" ? t("Keine Antwort in 12 Sekunden – bitte gleich noch einmal prüfen.") : t("Die Prüfung hat nicht geklappt – bitte gleich noch einmal versuchen.");
      return done(false, msg);
    }
  }

  private async tokenForTelegram(): Promise<string | null> {
    return (await this.deps.secrets.getSecret(TELEGRAM_TOKEN_SECRET)) ?? (this.env[TELEGRAM_TOKEN_ENV]?.trim() || null);
  }

  private async checkTelegram(done: (ok: boolean, message: string) => AccessCheck): Promise<AccessCheck> {
    const token = await this.tokenForTelegram();
    if (!token) return done(false, t("Noch kein Bot-Token eingetragen."));
    const res = await this.fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), redirect: "error" });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null;
    if (res.ok && body?.ok) return done(true, t("Token gültig – Bot @{name}.", { name: body.result?.username ?? "?" }));
    if (res.status === 401 || res.status === 404) return done(false, t("Telegram kennt dieses Token nicht – bei @BotFather mit /token neu holen."));
    return done(false, t("Telegram hat nicht wie erwartet geantwortet – bitte gleich noch einmal prüfen."));
  }

  // ─── Alles auf einmal ───

  async bulk(entries: { id: AccessId; value: string }[], check = true): Promise<AccessBulkResult> {
    const results: AccessBulkResult["results"] = [];
    for (const e of entries) {
      try {
        await this.save(e.id, e.value);
        results.push({ id: e.id, saved: true, error: null, check: null });
      } catch (err) {
        const msg = err instanceof AccessError || err instanceof ProviderError || err instanceof SecretsKeyError ? err.message : t("Konnte nicht gespeichert werden.");
        results.push({ id: e.id, saved: false, error: msg, check: null });
      }
    }
    if (check) {
      await Promise.all(
        results.filter((r) => r.saved).map(async (r) => {
          r.check = await this.check(r.id);
        }),
      );
    }
    return { results, items: (await this.list()).items };
  }
}
