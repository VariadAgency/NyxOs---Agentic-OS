// Persönlichkeit + Nutzerprofil von Nyx. Vertrag zwischen Server (`apps/server/src/nyx/persona.ts`
// baut daraus den Prompt-Abschnitt, `apps/server/src/nyx/profile.ts` speichert in `nyx_profile`/`nyx_presets`)
// und Web (Einstellungen → Nyx, `apps/web/src/features/settings/nyx/`).
// Idee Nutzerprofil/Seele: OpenClaw `USER.md`/`SOUL.md`/`IDENTITY.md`; eingebaute Vorlagen, die eigene
// überlagern: Hermes `hermes_cli/personality.py` (beide MIT, s. NOTICE).
import { z } from "zod";
import { lazyFields, tr } from "./lazy-text.js";

/** Kanal, über den Nyx gerade antwortet (Feld `channel` am Chat-Weg). */
export const NyxChannelSchema = z.enum(["web", "voice", "telegram"]);
export type NyxChannel = z.infer<typeof NyxChannelSchema>;

/**
 * Längen-Wahl an der Chat-Eingabe (Feld `length` am Chat-Weg). `auto` = Nyx richtet die Länge nach der Frage.
 * Überschreibt für die Runde den Regler „Länge“; ausdrückliche Längenwünsche in der Frage gehen immer vor.
 */
export const NyxAnswerLengthSchema = z.enum(["auto", "kurz", "normal", "ausfuehrlich"]);
export type NyxAnswerLength = z.infer<typeof NyxAnswerLengthSchema>;
const NYX_ANSWER_LENGTHS_DE: readonly { value: NyxAnswerLength; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Nyx entscheidet nach der Frage" },
  { value: "kurz", label: "Kurz", hint: "Ein paar Sätze" },
  { value: "normal", label: "Normal", hint: "Ein Absatz oder wenige Punkte" },
  { value: "ausfuehrlich", label: "Ausführlich", hint: "Gründlich erklärt" },
];
/** Labels and hints are German source texts, translated on every read. */
export const NYX_ANSWER_LENGTHS: readonly { value: NyxAnswerLength; label: string; hint: string }[] = NYX_ANSWER_LENGTHS_DE.map((o) => lazyFields(o, { label: tr, hint: tr }));

/** Verhaltens-Regler, je 0–100. Links = 0, rechts = 100 (Beschriftung s. {@link NYX_SLIDERS}). */
export const NYX_SLIDER_KEYS = ["length", "speed", "expertise", "formality", "initiative", "humor"] as const;
export type NyxSliderKey = (typeof NYX_SLIDER_KEYS)[number];

const sliderValue = z.number().int().min(0).max(100);
export const NyxSlidersSchema = z
  .object({
    /** 0 = kurz · 100 = ausführlich */
    length: sliderValue,
    /** 0 = schnell · 100 = gründlich (wirkt auch technisch: Denkaufwand, Modellwahl) */
    speed: sliderValue,
    /** 0 = fachlich · 100 = sehr einfach erklärt */
    expertise: sliderValue,
    /** 0 = förmlich · 100 = locker */
    formality: sliderValue,
    /** 0 = zurückhaltend · 100 = proaktiv */
    initiative: sliderValue,
    /** 0 = ernst · 100 = verspielt */
    humor: sliderValue,
  })
  .strict();
export type NyxSliders = z.infer<typeof NyxSlidersSchema>;

/** Grenzen je Textfeld – der ganze Abschnitt bleibt so unter ~4.000 Zeichen (wie OpenClaws USER.md-Budget). */
export const NYX_FIELD_MAX = 400;
export const NYX_TEXT_MAX = 1200;
const field = z.string().trim().max(NYX_FIELD_MAX);
const text = z.string().trim().max(NYX_TEXT_MAX);

/** Wer der Nutzer ist (wie OpenClaw `USER.md`). Leere Felder fehlen im Prompt. */
export const NyxUserProfileSchema = z
  .object({
    name: field,
    role: field,
    projects: field,
    workStyle: field,
    likes: field,
    noGos: field,
    /** Freitext: alles Weitere, das Nyx über der Nutzer wissen soll. */
    notes: text,
  })
  .strict();
export type NyxUserProfile = z.infer<typeof NyxUserProfileSchema>;

export const NyxAddressSchema = z.enum(["du", "Sie"]);
export type NyxAddress = z.infer<typeof NyxAddressSchema>;

/** Wer Nyx ist (wie OpenClaw `SOUL.md`/`IDENTITY.md`). */
export const NyxPersonalitySchema = z
  .object({
    character: field,
    tone: field,
    address: NyxAddressSchema,
    /** Freitext „Seele“: Grundhaltung, Werte, Grenzen. */
    soul: text,
  })
  .strict();
export type NyxPersonality = z.infer<typeof NyxPersonalitySchema>;

export const NyxPresetIdSchema = z.string().min(1).max(60);

export const NyxProfileSchema = z
  .object({
    user: NyxUserProfileSchema,
    personality: NyxPersonalitySchema,
    sliders: NyxSlidersSchema,
    /** Zuletzt angewandte Vorlage; `null`, sobald ein Regler von Hand verschoben wurde. */
    activePreset: NyxPresetIdSchema.nullable(),
  })
  .strict();
export type NyxProfile = z.infer<typeof NyxProfileSchema>;

/** `PUT /api/nyx/profile`: immer das ganze Profil (Formular speichert als Ganzes). */
export const NyxProfilePutSchema = NyxProfileSchema;

export interface NyxPreset {
  id: string;
  label: string;
  description: string;
  builtin: boolean;
  sliders: NyxSliders;
}

export const NYX_PRESET_LABEL_MAX = 40;
/** Höchstzahl eigener Vorlagen (Eingaben auch in der Anzahl begrenzt). */
export const NYX_CUSTOM_PRESETS_MAX = 30;
/** `POST /api/nyx/presets`: eigene Vorlage aus den aktuellen Reglern. */
export const NyxPresetCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(NYX_PRESET_LABEL_MAX),
    description: z.string().trim().max(160).optional(),
    sliders: NyxSlidersSchema,
  })
  .strict();
export type NyxPresetCreate = z.infer<typeof NyxPresetCreateSchema>;

export interface NyxProfileResponse {
  profile: NyxProfile;
  /** Startwerte (für „Zurücksetzen“). */
  defaults: NyxProfile;
  updatedAt: string | null;
}

export interface NyxPresetsResponse {
  presets: NyxPreset[];
}

/** Beschriftung der Regler (links = 0, rechts = 100) und ihre Farbe (Token-Name ohne `--`). */
const NYX_SLIDERS_DE: { key: NyxSliderKey; label: string; left: string; right: string; color: string }[] = [
  { key: "length", label: "Länge", left: "kurz", right: "ausführlich", color: "a-acc" },
  { key: "speed", label: "Tempo", left: "schnell", right: "gründlich", color: "a-wait" },
  { key: "expertise", label: "Erklären", left: "fachlich", right: "sehr einfach", color: "a-ok" },
  { key: "formality", label: "Ton", left: "förmlich", right: "locker", color: "a-violet" },
  { key: "initiative", label: "Eigeninitiative", left: "zurückhaltend", right: "proaktiv", color: "a-claude" },
  { key: "humor", label: "Humor", left: "ernst", right: "verspielt", color: "a-conf" },
];

/** Label and both ends are German source texts, translated on every read. */
export const NYX_SLIDERS: { key: NyxSliderKey; label: string; left: string; right: string; color: string }[] = NYX_SLIDERS_DE.map((sl) => lazyFields(sl, { label: tr, left: tr, right: tr }));

/** Regler-Wert → Stufe 0–4 (sehr links … sehr rechts). Prompt und Vorschau reden in Stufen, nie in Zahlen. */
export function nyxLevel(value: number): 0 | 1 | 2 | 3 | 4 {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (v < 20 ? 0 : v < 40 ? 1 : v < 60 ? 2 : v < 80 ? 3 : 4) as 0 | 1 | 2 | 3 | 4;
}

export type NyxStages = readonly [string, string, string, string, string];

/** Je Regler fünf Stufen (links → rechts) – genau diese Sätze bekommt Nyx im Prompt (Server `buildPersona`),
 * die Einstellungen zeigen sie unter dem Regler. */
const NYX_SLIDER_STAGES_DE: Record<NyxSliderKey, NyxStages> = {
  length: [
    "Antworte extrem knapp: ein bis zwei Sätze, nur das Ergebnis.",
    "Antworte kurz: wenige Sätze, das Wichtigste zuerst.",
    "Antworte mittellang: Ergebnis zuerst, dann die nötigen Details.",
    "Antworte ausführlich: Ergebnis, Begründung und nächste Schritte.",
    "Antworte sehr ausführlich: vollständig, mit Hintergründen, Alternativen und Beispielen.",
  ],
  speed: [
    "Tempo vor Tiefe: antworte sofort mit dem, was du schnell sicher weißt – höchstens ein kurzer Blick in die Werkzeuge.",
    "Eher schnell: nur die nötigsten Werkzeug-Aufrufe, keine langen Überlegungen.",
    "Ausgewogen: prüfe das Wichtigste nach, dann antworte.",
    "Eher gründlich: prüfe Fakten mit mehreren Werkzeugen und denk Randfälle mit.",
    "Gründlichkeit vor Tempo: prüfe alles doppelt, vergleiche Quellen und nenne Unsicherheiten ausdrücklich.",
  ],
  expertise: [
    "Sprich fachlich wie mit einem Entwickler: Fachbegriffe, Datei- und Funktionsnamen und Befehle sind erwünscht.",
    "Eher fachlich: Fachbegriffe sind in Ordnung, kurz eingeordnet.",
    "Gemischt: Fachbegriffe nur, wenn nötig – und dann kurz erklärt.",
    "Einfach erklärt: Alltagssprache, Fachbegriffe vermeiden oder in einem Halbsatz übersetzen.",
    "Sehr einfach erklärt, wie für jemanden ohne Technik-Wissen: keine Fachwörter, kurze Sätze, gern ein Vergleich aus dem Alltag.",
  ],
  formality: [
    "Förmlich und sachlich, keine Umgangssprache.",
    "Eher sachlich, höflich-distanziert.",
    "Freundlich-neutral.",
    "Locker und persönlich, wie unter Kollegen.",
    "Sehr locker, wie unter Freunden – Umgangssprache ist okay.",
  ],
  initiative: [
    "Tu nur, was gefragt ist. Keine ungefragten Vorschläge.",
    "Eher zurückhaltend: Vorschläge nur, wenn sie klar helfen.",
    "Nenne am Ende höchstens einen sinnvollen nächsten Schritt.",
    "Denk mit: weise auf Risiken hin und schlag nächste Schritte vor.",
    "Sehr proaktiv: erkenne Probleme früh, schlag Lösungen vor und bereite nächste Schritte vor (Freigaben bleiben beim Nutzer).",
  ],
  humor: [
    "Kein Humor, rein sachlich.",
    "Kaum Humor.",
    "Ab und zu ein leichter, trockener Satz ist okay.",
    "Gern mit einem Augenzwinkern, solange die Sache klar bleibt.",
    "Verspielt und humorvoll – aber nie auf Kosten der Klarheit.",
  ],
};

const trStages = (stages: NyxStages): NyxStages => stages.map((de) => tr(de)) as unknown as NyxStages;

/** The stages are German source texts, translated on every read (settings page and Nyx's prompt). */
export const NYX_SLIDER_STAGES: Record<NyxSliderKey, NyxStages> = lazyFields(NYX_SLIDER_STAGES_DE, {
  length: trStages,
  speed: trStages,
  expertise: trStages,
  formality: trStages,
  initiative: trStages,
  humor: trStages,
});

/** Eingebaute Vorlagen (nicht löschbar). Eigene Vorlagen kommen aus der DB dazu. */
const BUILTIN_NYX_PRESETS_DE: readonly NyxPreset[] = [
  {
    id: "kurz-knapp",
    label: "Kurz & knapp",
    description: "Das Wichtigste in ein, zwei Sätzen.",
    builtin: true,
    sliders: { length: 5, speed: 20, expertise: 60, formality: 70, initiative: 40, humor: 15 },
  },
  {
    id: "einfach",
    label: "Erklär's einfach",
    description: "Alltagssprache, Beispiele, keine Fachwörter.",
    builtin: true,
    sliders: { length: 45, speed: 50, expertise: 95, formality: 80, initiative: 50, humor: 30 },
  },
  {
    id: "technik-profi",
    label: "Technik-Profi",
    description: "Fachbegriffe, Dateien und Befehle – ohne Umwege.",
    builtin: true,
    sliders: { length: 45, speed: 55, expertise: 5, formality: 55, initiative: 60, humor: 10 },
  },
  {
    id: "gruendlich",
    label: "Gründlich",
    description: "Nimmt sich Zeit, prüft doppelt, nennt Gründe.",
    builtin: true,
    sliders: { length: 85, speed: 95, expertise: 60, formality: 50, initiative: 70, humor: 10 },
  },
  {
    id: "sprachmodus",
    label: "Sprachmodus",
    description: "Sehr kurz und gut vorlesbar.",
    builtin: true,
    sliders: { length: 0, speed: 10, expertise: 80, formality: 85, initiative: 40, humor: 25 },
  },
];

/** Label and description are German source texts, translated on every read. */
export const BUILTIN_NYX_PRESETS: readonly NyxPreset[] = BUILTIN_NYX_PRESETS_DE.map((p) => lazyFields(p, { label: tr, description: tr }));

/** Startwerte: das Nutzerprofil ist leer (Name, Rolle, Projekte füllt das Onboarding bzw. der Nutzer
 * unter Einstellungen → Nyx), die Persönlichkeit hat vernünftige Vorgaben. */
export const DEFAULT_NYX_PROFILE: NyxProfile = {
  user: {
    name: "",
    role: "",
    projects: "",
    workStyle: "",
    likes: "",
    noGos: "",
    notes: "",
  },
  // German source texts, translated on every read (an English install starts with English defaults).
  personality: lazyFields(
    {
      character: "Rechte Hand: ruhig, direkt, ehrlich, denkt mit.",
      tone: "Freundlich und klar, ohne Floskeln.",
      address: "du",
      soul: "Hilf wirklich, statt nur gefällig zu wirken – kein „Gute Frage!“. Hab eine eigene Meinung und sag sie. Sieh erst selbst nach, bevor du fragst. Vertrauen verdienst du durch Können. Du bist Gast in den Projekten des Nutzers: geh sorgsam mit allem um.",
    },
    { character: tr, tone: tr, soul: tr },
  ),
  sliders: { length: 20, speed: 45, expertise: 80, formality: 70, initiative: 65, humor: 25 },
  activePreset: null,
};

/** Passt die Regler-Stellung genau auf eine Vorlage? (Chip „aktiv“ auch ohne gespeicherte Auswahl.) */
export function matchingNyxPreset(sliders: NyxSliders, presets: readonly NyxPreset[]): NyxPreset | null {
  return presets.find((p) => NYX_SLIDER_KEYS.every((k) => p.sliders[k] === sliders[k])) ?? null;
}
