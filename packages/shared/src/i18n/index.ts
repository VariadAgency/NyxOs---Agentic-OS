// Translation layer shared by server, bridge and web app.
// German is the source language: every UI text is written in German and wrapped in `t()`.
// The German text itself is the key; `en/*.ts` map it to English. Missing keys fall back to German.
import { EN } from "./en/index.js";

export type Lang = "de" | "en";
export const LANGS: readonly Lang[] = ["de", "en"] as const;

let current: Lang = "de";
let zoneOverride: string | null = null;

export function isLang(v: unknown): v is Lang {
  return v === "de" || v === "en";
}

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

/** BCP-47 locale for Intl formatters that match the current language. */
export function locale(lang: Lang = current): string {
  return lang === "en" ? "en-US" : "de-DE";
}

/** Time zone for all dates shown to the user: the system zone unless the settings override it. */
export function timeZone(): string {
  if (zoneOverride) return zoneOverride;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function setTimeZone(zone: string | null): void {
  zoneOverride = zone && zone.trim() ? zone.trim() : null;
}

type Vars = Record<string, string | number | null | undefined>;

function fill(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

/**
 * Translate a German source text. Placeholders use `{name}`: `t("{n} Sessions offen", { n: 3 })`.
 * With `lang` a specific language is forced (e.g. for Telegram messages or prompts).
 */
export function t(de: string, vars?: Vars, lang: Lang = current): string {
  const text = lang === "en" ? (EN[de] ?? de) : de;
  return fill(text, vars);
}

/**
 * Translate a German text whose English depends on where it appears ("Fragen" = "Ask" as a button, "Questions"
 * as a heading). The dictionary key is `"<context>::<German text>"`; without such an entry the plain key is used.
 */
export function tc(context: string, de: string, vars?: Vars, lang: Lang = current): string {
  if (lang !== "en") return fill(de, vars);
  return fill(EN[`${context}::${de}`] ?? EN[de] ?? de, vars);
}

/** Put a text in the quotation marks of the language: „Titel“ (German) or “Title” (English). */
export function quote(text: string, lang: Lang = current): string {
  return lang === "en" ? `“${text}”` : `„${text}“`;
}

/** Pick between two already written variants (for longer texts such as prompts). */
export function pick<T>(variants: { de: T; en: T }, lang: Lang = current): T {
  return variants[lang];
}

/** Number of English entries (for tests and the settings page). */
export function translationCount(): number {
  return Object.keys(EN).length;
}
