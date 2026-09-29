// App info (version, mode, language, onboarding state) — loaded once before the first render so every
// `t()` call already uses the right language. Changing the language reloads the page.
import { isLang, setLang, type AppInfo, type AppSettingsPatch } from "@nyxos/shared";

const LANG_KEY = "nyxos.lang";

function storedLang(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

function rememberLang(lang: string): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // private mode: the server setting is enough
  }
}

function browserLang(): "de" | "en" {
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
}

/** Sets the language before React renders: server setting, else last choice, else browser language. */
export async function bootLanguage(): Promise<AppInfo | null> {
  const cached = storedLang();
  setLang(isLang(cached) ? cached : browserLang());
  try {
    const res = await fetch("/api/app/info", { credentials: "same-origin" });
    if (!res.ok) return null;
    const info = (await res.json()) as AppInfo;
    // Before the onboarding the server only knows its default; the browser language is the better guess.
    const lang = info.settings.onboardingDone || isLang(cached) ? info.settings.lang : browserLang();
    setLang(lang);
    rememberLang(lang);
    document.documentElement.lang = lang;
    return info;
  } catch {
    return null;
  }
}

export async function fetchAppInfo(): Promise<AppInfo> {
  const res = await fetch("/api/app/info", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AppInfo;
}

/** Switches the language: stores it on the server and reloads so every text is rendered again. */
export async function switchLanguage(lang: "de" | "en", save: (patch: AppSettingsPatch) => Promise<unknown>): Promise<void> {
  rememberLang(lang);
  await save({ lang });
  window.location.reload();
}
