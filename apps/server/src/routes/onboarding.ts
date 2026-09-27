// Onboarding (first start): `GET /api/onboarding/ai` (can Nyx answer, over which access), `POST /api/onboarding/ai/use`
// (let Nyx run on a saved provider), `POST /api/onboarding/interview` (three answers → suggested Nyx profile),
// `POST /api/onboarding/finish` (name, onboarding done, profile name, first briefing). Writes need login + CSRF
// (global auth gate for /api/*). Everything else the wizard needs already exists (`/api/access`, `/api/setup`, …).
import {
  NYX_FIELD_MAX,
  NYX_SLIDER_KEYS,
  NYX_TEXT_MAX,
  NyxProfileSchema,
  ONBOARDING_PROVIDERS,
  OnboardingFinishSchema,
  OnboardingInterviewSchema,
  OnboardingUseProviderSchema,
  getLang,
  isEmbeddingModel,
  pick,
  t,
  type ModelRole,
  type NyxPersonality,
  type NyxProfile,
  type NyxSliders,
  type OnboardingAiState,
  type OnboardingFinishResult,
  type OnboardingInterview,
  type OnboardingInterviewResult,
  type OnboardingProvider,
  type OnboardingUseProviderResult,
  type ProviderModel,
} from "@nyxos/shared";
import { desc, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { Env } from "../app.js";
import { saveAppSettings } from "../app-info/settings.js";
import type { Db } from "../db/client.js";
import { haikuCalls } from "../db/schema.js";
import { extractJson } from "../haiku/json.js";
import { generateReport } from "../haiku/report.js";
import type { HaikuRuntime } from "../haiku/runtime.js";
import { ProviderError } from "../models/chat.js";
import type { ModelService } from "../models/providers.js";
import { loadNyxProfile, saveNyxProfile } from "../nyx/profile.js";

type Log = (msg: string, extra?: Record<string, unknown>) => void;

export interface OnboardingRouteDeps {
  db: Db;
  runtime: HaikuRuntime;
  models: ModelService;
  log: Log;
  env?: NodeJS.ProcessEnv;
  /** Tells open browsers that something changed (e.g. `report` after the first briefing). */
  notify?: (what: string) => void;
}

/** Nyx roles that follow the access chosen in the onboarding (the fixed roles stay as they are). */
const NYX_ROLES: readonly ModelRole[] = ["nyx.chat", "nyx.briefing", "nyx.voice"];
const INTERVIEW_TIMEOUT_MS = 90_000;

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

// ───────────────────────────── pure helpers (tested directly) ─────────────────────────────

/** Neutral start profile for a new user – the built-in default describes the original author. */
export function neutralProfile(name: string): NyxProfile {
  const personality: NyxPersonality = pick({
    de: {
      character: "Ruhige, direkte rechte Hand: ehrlich, denkt mit.",
      tone: "Freundlich und klar, ohne Floskeln.",
      address: "du",
      soul: "Hilf wirklich, statt nur gefällig zu wirken – kein „Gute Frage!“. Hab eine eigene Meinung und sag sie. Sieh erst selbst nach, bevor du fragst. Du bist Gast in den Projekten deines Menschen: geh sorgsam mit allem um.",
    },
    en: {
      character: "A calm, direct right hand: honest, thinks along.",
      tone: "Friendly and clear, no filler phrases.",
      address: "du",
      soul: "Really help instead of just being agreeable – no “Great question!”. Have an opinion and say it. Look things up yourself before you ask. You are a guest in your person's projects: handle everything with care.",
    },
  });
  return {
    user: { name: name.trim().slice(0, NYX_FIELD_MAX), role: "", projects: "", workStyle: "", likes: "", noGos: "", notes: "" },
    personality,
    sliders: { length: 35, speed: 45, expertise: 70, formality: 65, initiative: 55, humor: 25 },
    activePreset: null,
  };
}

const clip = (s: unknown, max: number): string => (typeof s === "string" ? s.trim().slice(0, max) : "");

/** Simple words → slider positions (both languages). Only what the answer clearly says moves a slider. */
export function slidersFromStyle(style: string, base: NyxSliders): NyxSliders {
  const s = style.toLowerCase();
  const next = { ...base };
  if (/kurz|knapp|short|brief|concise|to the point/.test(s)) next.length = 15;
  else if (/ausführlich|ausfuehrlich|detailliert|in detail|detailed|thorough/.test(s)) next.length = 80;
  if (/einfach|simpel|laie|ohne fachbegriffe|keine fachbegriffe|simple|plain|no jargon|beginner/.test(s)) next.expertise = 90;
  else if (/technisch|fachlich|entwickler|technical|developer|expert/.test(s)) next.expertise = 15;
  if (/locker|entspannt|casual|relaxed|informal/.test(s)) next.formality = 85;
  else if (/förmlich|foermlich|formal|professionell|professional|sachlich/.test(s)) next.formality = 20;
  if (/humor|witz|lustig|funny|playful|jokes?\b/.test(s) && !/kein humor|keine witze|no humou?r|no jokes/.test(s)) next.humor = 70;
  if (/ernst|kein humor|keine witze|serious|no humou?r|no jokes/.test(s)) next.humor = 5;
  if (/proaktiv|mitdenken|vorschläge|vorschlaege|proactive|suggest|think ahead/.test(s)) next.initiative = 80;
  else if (/zurückhaltend|zurueckhaltend|nur was ich|only what i ask|reserved|don't suggest/.test(s)) next.initiative = 20;
  if (/gründlich|gruendlich|sorgfältig|careful|double.?check/.test(s)) next.speed = 80;
  else if (/schnell|fast|quick/.test(s)) next.speed = 20;
  return next;
}

/** Wants to be addressed formally ("Sie")? Only explicit wishes count – "Sie soll …" usually means Nyx. */
export function addressFromStyle(style: string, base: NyxPersonality["address"]): NyxPersonality["address"] {
  const s = style.toLowerCase();
  if (/siezen|per sie|mit „?sie“? an|förmliche anrede/.test(s)) return "Sie";
  if (/duzen|per du|mit „?du“? an/.test(s)) return "du";
  return base;
}

/** Interview without AI: the answers go into the matching profile fields, sliders from simple words. */
export function rulesProfile(base: NyxProfile, a: OnboardingInterview): NyxProfile {
  const sliders = a.style ? slidersFromStyle(a.style, base.sliders) : base.sliders;
  const changed = NYX_SLIDER_KEYS.some((k) => sliders[k] !== base.sliders[k]);
  return {
    user: {
      ...base.user,
      name: clip(a.name, NYX_FIELD_MAX) || base.user.name,
      role: clip(a.who, NYX_FIELD_MAX) || base.user.role,
      projects: clip(a.work, NYX_FIELD_MAX) || base.user.projects,
      workStyle: clip(a.style, NYX_FIELD_MAX) || base.user.workStyle,
    },
    personality: { ...base.personality, address: addressFromStyle(a.style, base.personality.address) },
    sliders,
    activePreset: changed ? null : base.activePreset,
  };
}

/** Short sentences about what ended up in the profile. */
export function understoodLines(p: NyxProfile): string[] {
  const out: string[] = [];
  if (p.user.name) out.push(t("Du heißt {name}.", { name: p.user.name }));
  if (p.user.role) out.push(t("Über dich: {text}", { text: p.user.role }));
  if (p.user.projects) out.push(t("Du arbeitest an: {text}", { text: p.user.projects }));
  if (p.user.workStyle) out.push(t("So soll Nyx sein: {text}", { text: p.user.workStyle }));
  // du/Sie only matters in German.
  if (getLang() === "de") out.push(p.personality.address === "Sie" ? t("Nyx siezt dich.") : t("Nyx duzt dich."));
  return out;
}

export const INTERVIEW_SYSTEM = `You set up the assistant "Nyx" for a new user. You get the user's own answers to three questions:
who they are, what they work on, and how Nyx should behave. Turn them into a short profile.

Rules:
- Only use what the answers say. Invent nothing. Leave a field empty ("") if the answers say nothing about it.
- Write every text field in the language the user wrote in, in short, plain sentences (no jargon).
- "role": who the user is (job, background, experience with AI tools) · "projects": what they work on · "workStyle": how they work and how Nyx should work with them · "likes": what they like in answers · "noGos": what Nyx must avoid · "notes": anything else worth remembering.
- "address": "Sie" only if the user explicitly wants to be addressed formally in German, else "du".
- "sliders": each 0–100. length (0 short – 100 detailed), speed (0 fast – 100 thorough), expertise (0 technical – 100 very simple words), formality (0 formal – 100 casual), initiative (0 reserved – 100 proactive), humor (0 serious – 100 playful). Only include sliders the answers clearly speak about.
- "understood": 2–5 short sentences addressed to the user ("You …"), in their language, saying what you understood.

Answer ONLY with JSON in exactly this form:
{"role":"","projects":"","workStyle":"","likes":"","noGos":"","notes":"","address":"du","sliders":{},"understood":[""]}`;

export function buildInterviewPrompt(a: OnboardingInterview): string {
  return [`Name: ${a.name || "–"}`, `# Who are you?\n${a.who || "–"}`, `# What do you work on?\n${a.work || "–"}`, `# How should Nyx behave?\n${a.style || "–"}`].join("\n\n");
}

/** Model answer → full profile on top of `base`. `null` = unusable. */
export function parseInterview(raw: string, base: NyxProfile, a: OnboardingInterview): { profile: NyxProfile; understood: string[] } | null {
  const j = extractJson<Record<string, unknown>>(raw);
  if (!j || typeof j !== "object") return null;
  const field = (k: keyof NyxProfile["user"], max = NYX_FIELD_MAX) => clip(j[k], max) || base.user[k];
  const rawSliders = (j.sliders && typeof j.sliders === "object" ? j.sliders : {}) as Record<string, unknown>;
  const sliders = { ...base.sliders };
  let moved = false;
  for (const k of NYX_SLIDER_KEYS) {
    const v = rawSliders[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      sliders[k] = Math.max(0, Math.min(100, Math.round(v)));
      moved = moved || sliders[k] !== base.sliders[k];
    }
  }
  const profile: NyxProfile = {
    user: {
      name: clip(a.name, NYX_FIELD_MAX) || base.user.name,
      role: field("role"),
      projects: field("projects"),
      workStyle: field("workStyle"),
      likes: field("likes"),
      noGos: field("noGos"),
      notes: field("notes", NYX_TEXT_MAX),
    },
    personality: { ...base.personality, address: j.address === "Sie" ? "Sie" : j.address === "du" ? "du" : base.personality.address },
    sliders,
    activePreset: moved ? null : base.activePreset,
  };
  const checked = NyxProfileSchema.safeParse(profile);
  if (!checked.success) return null;
  const understood = Array.isArray(j.understood)
    ? j.understood
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 300))
        .slice(0, 5)
    : [];
  return { profile: checked.data, understood: understood.length > 0 ? understood : understoodLines(checked.data) };
}

/** A small, cheap chat model per provider: from the live list if there is one, else a known id. */
export function pickDefaultModel(kind: OnboardingProvider, live: readonly ProviderModel[]): string | null {
  const ids = live.map((m) => m.id).filter((id) => !isEmbeddingModel(id));
  const find = (re: RegExp) => ids.find((id) => re.test(id)) ?? null;
  switch (kind) {
    case "anthropic":
      return find(/haiku/) ?? "claude-haiku-4-5-20251001";
    case "openai":
      return find(/^gpt-5-mini$/) ?? find(/mini/) ?? "gpt-5-mini";
    case "openrouter":
      return find(/claude-haiku|haiku/) ?? find(/gpt-5-mini|mini/) ?? ids[0] ?? null;
    case "ollama":
    case "lmstudio":
      return ids[0] ?? null;
  }
}

// ───────────────────────────── routes ─────────────────────────────

export function registerOnboardingRoutes(app: Hono<Env>, deps: OnboardingRouteDeps): void {
  const { db, runtime, models, log } = deps;
  const env = deps.env ?? process.env;

  /** Nyx could answer now? Read-only (the runtime's preflight would log a budget refusal on every poll). */
  const readiness = async () => {
    const status = await runtime.status();
    const overBudget = status.today.costUsd >= status.settings.dailyBudgetUsd;
    const ready = status.engine.available && !overBudget;
    const reason = ready ? null : !status.engine.available ? (status.engine.reason ?? t("Nyx ist noch nicht verbunden.")) : t("Das Tages-Budget ist für heute aufgebraucht.");
    return { status, ready, reason };
  };

  app.get("/api/onboarding/ai", async (c) => {
    const { status, ready, reason } = await readiness();
    const [cli, chat, providers, [last]] = await Promise.all([
      runtime.engineView("claude-cli"),
      models.resolveModel("nyx.chat"),
      models.listProviders(),
      db.select({ at: haikuCalls.createdAt }).from(haikuCalls).where(eq(haikuCalls.status, "ok")).orderBy(desc(haikuCalls.createdAt)).limit(1),
    ]);
    const token = env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
    const body: OnboardingAiState = {
      ready,
      reason,
      via: status.settings.engine === "off" ? "off" : chat.source,
      modelLabel: chat.label,
      // Found = the program answered `--version` (also when its sign-in was rejected); a missing program has no version.
      cli: { found: cli.ok || cli.version != null, version: cli.version ?? null, token: token.startsWith("sk-ant-") && token.length > 20 },
      lastAnswerAt: last?.at ? new Date(last.at).toISOString() : null,
      providers: ONBOARDING_PROVIDERS.map((kind) => {
        const p = providers.find((x) => x.id === kind);
        return {
          kind,
          configured: !!p?.configured && (!p.needsKey || p.key.set),
          ok: p?.lastTest ? p.lastTest.ok : null,
          message: p?.lastTest?.message ?? null,
          models: p?.models.length ?? 0,
        };
      }),
      budgetUsd: status.settings.dailyBudgetUsd,
      spentTodayUsd: status.today.costUsd,
    };
    return c.json(body);
  });

  app.post("/api/onboarding/ai/use", async (c) => {
    const parsed = OnboardingUseProviderSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Diesen Zugang gibt es nicht.") }, 400);
    const kind = parsed.data.provider;
    try {
      let p = await models.getProvider(kind);
      if (!p?.configured || (p.needsKey && !p.key.set)) return c.json({ error: t("Dieser Zugang ist noch nicht eingerichtet.") }, 409);
      // Local apps list their models only after a test – fetch the list once if it is still empty.
      if (!parsed.data.model && p.models.length === 0 && (kind === "ollama" || kind === "lmstudio" || kind === "openrouter")) {
        await models.testProvider(kind);
        p = (await models.getProvider(kind)) ?? p;
      }
      const model = parsed.data.model ?? pickDefaultModel(kind, p.models);
      if (!model) {
        const hint = kind === "ollama" ? t("In Ollama ist noch kein Modell geladen – zum Beispiel im Terminal: ollama pull llama3.2") : kind === "lmstudio" ? t("In LM Studio ist noch kein Modell geladen – bitte eins laden und den lokalen Server starten.") : t("Dieser Zugang hat keine Modelle gemeldet.");
        return c.json({ error: hint }, 409);
      }
      let label = model;
      for (const role of NYX_ROLES) label = (await models.assignRole(role, kind, model)).label;
      log("onboarding-zugang", { provider: kind, model });
      return c.json({ provider: kind, model, label } satisfies OnboardingUseProviderResult);
    } catch (e) {
      if (e instanceof ProviderError) return c.json({ error: e.message }, 400);
      log("onboarding-zugang-fehler", { error: e instanceof Error ? e.name : "unbekannt" });
      return c.json({ error: t("Das hat nicht geklappt – bitte noch einmal versuchen.") }, 500);
    }
  });

  app.post("/api/onboarding/interview", async (c) => {
    const parsed = OnboardingInterviewSchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return c.json({ error: t("Die Antworten sind zu lang – bitte etwas kürzen.") }, 400);
    const a = parsed.data;
    const current = await loadNyxProfile(db);
    const base = current.updatedAt === null ? neutralProfile(a.name) : current.profile;
    const fallback = (): OnboardingInterviewResult => {
      const profile = rulesProfile(base, a);
      return { profile, source: "rules", understood: understoodLines(profile) };
    };
    const answered = [a.who, a.work, a.style].some((x) => x.length > 0);
    if (!answered || !(await readiness()).ready) return c.json(fallback());
    const res = await runtime.run({
      kind: "auswertung",
      role: "nyx.chat",
      scope: "none",
      lane: "onboarding",
      thinking: false,
      systemPrompt: INTERVIEW_SYSTEM,
      prompt: buildInterviewPrompt(a),
      timeoutMs: INTERVIEW_TIMEOUT_MS,
      maxTokens: 1200,
      signal: c.req.raw.signal,
    });
    if (res.type !== "final") {
      log("onboarding-interview-fehler", { code: res.code });
      return c.json(fallback());
    }
    const out = parseInterview(res.rawText, base, a);
    if (!out) {
      log("onboarding-interview-unbrauchbar", { callId: res.callId });
      return c.json(fallback());
    }
    return c.json({ profile: out.profile, source: "nyx", understood: out.understood } satisfies OnboardingInterviewResult);
  });

  app.post("/api/onboarding/finish", async (c) => {
    const parsed = OnboardingFinishSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: t("Bitte gib deinen Namen ein.") }, 400);
    const { userName, lang, briefing } = parsed.data;
    const settings = await saveAppSettings(db, { userName, onboardingDone: true, ...(lang ? { lang } : {}) });
    // The greeting (overview, briefing) reads the name from the Nyx profile – never keep the author's default there.
    const current = await loadNyxProfile(db);
    const profile = current.updatedAt === null ? neutralProfile(userName) : { ...current.profile, user: { ...current.profile.user, name: userName } };
    await saveNyxProfile(db, profile);
    let started: OnboardingFinishResult["briefing"] = "skipped";
    if (briefing !== false && (await readiness()).ready) {
      started = "started";
      void generateReport(runtime, "briefing")
        .then(() => deps.notify?.("report"))
        .catch((e: unknown) => log("onboarding-briefing-fehler", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }
    log("onboarding-fertig", { briefing: started });
    return c.json({ userName: settings.userName, onboardingDone: true, briefing: started } satisfies OnboardingFinishResult);
  });
}

