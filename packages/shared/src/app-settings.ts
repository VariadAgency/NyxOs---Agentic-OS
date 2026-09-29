// App-wide settings and the "Info" data: language, the user's name, onboarding state, updates, run mode.
import { z } from "zod";

export const AppLangSchema = z.enum(["de", "en"]);

export const AppSettingsSchema = z.object({
  lang: AppLangSchema,
  /** How NyxOS and Nyx address the user. Empty until the onboarding asked for it. */
  userName: z.string().max(60),
  /** Set once the onboarding finished; the dashboard shows the wizard until then. */
  onboardingDone: z.boolean(),
  /** Install new releases automatically (local mode) or only show a notice. */
  autoUpdate: z.boolean(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const AppSettingsPatchSchema = AppSettingsSchema.partial().strict();
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = { lang: "de", userName: "", onboardingDone: false, autoUpdate: true };

/** `local` = everything on this computer (default), `server` = API runs on an own server (Docker Compose). */
export type AppMode = "local" | "server";

export interface AppUpdateState {
  /** Latest release on GitHub, `null` = not checked yet or offline. */
  latest: string | null;
  available: boolean;
  checkedAt: string | null;
  /** Local mode can install updates itself; the server mode updates with Docker Compose. */
  canInstall: boolean;
  /** Running install, or the last error in plain words. */
  installing: boolean;
  error: string | null;
}

export interface AppInfo {
  name: "NyxOS";
  version: string;
  mode: AppMode;
  /** Demo instance with invented data (`nyxos demo`). */
  demo: boolean;
  /** Demo only: the user's real installation to go back to for setting up (null for a standalone `nyxos demo`). */
  demoHomeUrl: string | null;
  /** Demo only: how Nyx answers — the user's AI, scripted demo answers, or null outside a demo. */
  demoEngine: "ai" | "scripted" | null;
  repo: string;
  settings: AppSettings;
  update: AppUpdateState;
  /** Data folder of this installation (local mode), for the help page. */
  dataDir: string | null;
}

/** Compare two versions like `0.2.10` and `0.2.9`. Returns > 0 if `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** GitHub repository ("owner/name") that releases and the installer come from. Set with scripts/set-repo.sh. */
export const NYXOS_REPO = "VariadAgency/NyxOs---Agentic-OS";
