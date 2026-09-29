// Small state per area for the overview („Angemeldet“, „2 Wege an“, „aus“). Only existing queries (the same keys as
// the panels, so a shared cache) – no new endpoints. Without an answer nothing shows (`null`): the overview stays
// calm instead of showing errors; the subpage shows the error.
import { matchingNyxPreset, t, type NightSettings, type NyxUserProfile, type PushSettings } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useAppInfo } from "../../hooks/useAppInfo";
import { useAuthStatus } from "../../hooks/useAuthStatus";
import { useRules } from "../../hooks/useRules";
import { useHaikuStatus } from "../haiku/EngineStatus";
import { fetchIdeaLinks } from "../haiku/haikuApi";
import { useCompanionSettings } from "../nyx/companionSettings";
import { fetchSupportState, SUPPORT_STATE_KEY } from "../support/api";
import { useAccess } from "./access/accessApi";
import { useProviders } from "./modelsApi";
import { fetchNyxPresets, fetchNyxProfile, fetchVoiceSettings, PRESETS_KEY, PROFILE_KEY, VOICE_SETTINGS_KEY } from "./nyx/nyxApi";
import type { SectionStatus } from "./types";
import { useConnections } from "./useConnections";

/** The overview reloads states at most once a minute. */
const STATUS_STALE_MS = 60_000;

async function getOrThrow<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export function useAuthSectionStatus(): SectionStatus | null {
  const { data } = useAuthStatus();
  const local = useAppInfo().data?.mode === "local";
  if (!data) return null;
  // Local mode has no passkeys – signed in or not is all there is.
  if (local) return data.authenticated ? { text: t("Angemeldet"), tone: "ok" } : { text: t("Nicht angemeldet"), tone: "wait" };
  if (data.authenticated) return { text: data.hasPasskey ? t("Angemeldet · Passkey da") : t("Angemeldet"), tone: "ok" };
  return data.hasPasskey ? { text: t("Nicht angemeldet"), tone: "wait" } : { text: t("Kein Passkey"), tone: "bad" };
}

export function useConnectionsSectionStatus(): SectionStatus | null {
  const { data } = useConnections();
  const sum = data?.summary;
  if (!sum) return null;
  if (sum.fail > 0) return { text: t("{n} gestört", { n: sum.fail }), tone: "bad" };
  if (sum.user > 0) return { text: sum.user === 1 ? t("1 wartet auf dich") : t("{n} warten auf dich", { n: sum.user }), tone: "wait" };
  if (sum.warn > 0) return { text: sum.warn === 1 ? t("1 Hinweis") : t("{n} Hinweise", { n: sum.warn }), tone: "wait" };
  return { text: t("Alles verbunden"), tone: "ok" };
}

export function usePushSectionStatus(): SectionStatus | null {
  // Own key: the notifications panel may rebuild its query freely without both getting in each other's way.
  const { data } = useQuery({ queryKey: ["settings-status", "push"], queryFn: () => getOrThrow<Partial<PushSettings>>("/api/push/settings"), staleTime: STATUS_STALE_MS, retry: false });
  if (!data?.channels) return null;
  const on = Object.values(data.channels).filter(Boolean).length;
  if (on === 0) return { text: t("aus"), tone: "mut" };
  return { text: on === 1 ? t("1 Weg an") : t("{n} Wege an", { n: on }), tone: "ok" };
}

export function useAccessSectionStatus(): SectionStatus | null {
  const { data } = useAccess();
  const items = data?.items;
  if (!items?.length) return null;
  const ok = items.filter((i) => i.state === "ok" || i.state === "link").length;
  const broken = items.filter((i) => i.state === "error").length;
  if (broken > 0) return { text: t("{n} mit Fehler", { n: broken }), tone: "bad" };
  return { text: t("{ok} von {n} eingerichtet", { ok, n: items.length }), tone: ok > 0 ? "ok" : "mut" };
}

export function useModelsSectionStatus(): SectionStatus | null {
  const { data } = useProviders();
  const list = data?.providers;
  if (!list) return null;
  // Templates do not count – only created, switched-on providers with a key (if one is needed).
  const n = list.filter((p) => p.configured && p.enabled && (!p.needsKey || p.key?.set)).length;
  return n === 0 ? { text: t("Kein Anbieter bereit"), tone: "wait" } : { text: n === 1 ? t("1 Anbieter bereit") : t("{n} Anbieter bereit", { n }), tone: "ok" };
}

export function useNightSectionStatus(): SectionStatus | null {
  const { data } = useQuery({ queryKey: ["settings-status", "night"], queryFn: () => getOrThrow<Partial<NightSettings>>("/api/night/settings"), staleTime: STATUS_STALE_MS, retry: false });
  const w = data?.window;
  if (!w) return null;
  return { text: t("Nacht {start}–{end}", { start: w.start, end: w.end }), tone: "mut" };
}

export function useRulesSectionStatus(): SectionStatus | null {
  const { data } = useRules();
  const rules = data?.rules;
  if (!rules) return null;
  if (rules.length === 0) return { text: t("Noch leer"), tone: "mut" };
  return { text: t("{active} von {n} aktiv", { active: rules.filter((r) => r.active).length, n: rules.length }), tone: "ok" };
}

export function useIdeaLinksSectionStatus(): SectionStatus | null {
  const { data } = useQuery({ queryKey: ["idealinks"], queryFn: fetchIdeaLinks, staleTime: STATUS_STALE_MS, retry: false });
  if (!data) return null;
  const now = Date.now();
  const live = data.filter((l) => !l.revokedAt && Date.parse(l.expiresAt) > now).length;
  return live === 0 ? { text: t("Kein Link"), tone: "mut" } : { text: t("{n} aktiv", { n: live }), tone: "ok" };
}

export function useSupportSectionStatus(): SectionStatus | null {
  const { data } = useQuery({ queryKey: SUPPORT_STATE_KEY, queryFn: fetchSupportState, staleTime: STATUS_STALE_MS, retry: false });
  const waiting = data?.outbox.waiting ?? 0;
  if (waiting === 0) return null;
  return { text: waiting === 1 ? t("1 Meldung wartet") : t("{n} Meldungen warten", { n: waiting }), tone: "wait" };
}

// ─── Nyx ───

export function usePersonalitySectionStatus(): SectionStatus | null {
  const profile = useQuery({ queryKey: PROFILE_KEY, queryFn: fetchNyxProfile, staleTime: STATUS_STALE_MS });
  const presets = useQuery({ queryKey: PRESETS_KEY, queryFn: fetchNyxPresets, staleTime: STATUS_STALE_MS });
  const p = profile.data?.profile;
  if (!p?.sliders) return null;
  const list = presets.data?.presets ?? [];
  const preset = list.find((x) => x.id === p.activePreset) ?? matchingNyxPreset(p.sliders, list);
  return { text: preset ? preset.label : t("Eigene Mischung"), tone: "mut" };
}

const USER_KEYS: (keyof NyxUserProfile)[] = ["name", "role", "projects", "workStyle", "likes", "noGos", "notes"];

export function useAboutSectionStatus(): SectionStatus | null {
  const profile = useQuery({ queryKey: PROFILE_KEY, queryFn: fetchNyxProfile, staleTime: STATUS_STALE_MS });
  const user = profile.data?.profile?.user;
  if (!user) return null;
  const filled = USER_KEYS.filter((k) => (user[k] ?? "").trim().length > 0).length;
  return { text: t("{filled} von {n} ausgefüllt", { filled, n: USER_KEYS.length }), tone: filled > 0 ? "ok" : "mut" };
}

export function useVoiceSectionStatus(): SectionStatus | null {
  const { data } = useQuery({ queryKey: VOICE_SETTINGS_KEY, queryFn: fetchVoiceSettings, staleTime: STATUS_STALE_MS, retry: false });
  if (!data?.provider) return null;
  return { text: data.provider === "elevenlabs" ? "ElevenLabs" : t("Eigene Stimme"), tone: "mut" };
}

export function useCompanionSectionStatus(): SectionStatus {
  const s = useCompanionSettings();
  return { text: t("Vorlesen {speak} · Zuhören {listen}", { speak: s.speak ? t("an") : t("aus"), listen: s.listening ? t("an") : t("aus") }), tone: "mut" };
}

export function useEngineSectionStatus(): SectionStatus | null {
  const { data } = useHaikuStatus();
  const kind = data?.settings?.engine;
  if (!kind) return null;
  if (kind === "off") return { text: t("aus"), tone: "wait" };
  const state = data.engine?.state;
  const label = kind === "claude-cli" ? t("Max-Plan") : "API";
  if (state === "error") return { text: t("{label} · Fehler", { label }), tone: "bad" };
  if (state === "waiting_token") return { text: t("{label} · wartet auf Token", { label }), tone: "wait" };
  return { text: label, tone: "ok" };
}
