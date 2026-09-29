// Desktop-Mitteilung (RPC `notify` vom Server): macOS über `osascript`, Linux über `notify-send`. Der Hauptweg
// für Push, weil er ohne öffentlichen Port auskommt: die Brücke ist ohnehin per WebSocket mit dem Server verbunden.
//
// Sicherheit: Titel und Text kommen vom Server (u. a. Session-Titel = die erste Nachricht des Nutzers). Sie
// werden NIE in ein Skript oder eine Shell-Zeile eingesetzt, sondern als Argumente übergeben (`on run argv`
// bzw. `notify-send -- <titel> <text>`, `execFile` ohne Shell, `--` davor). So kann kein Anführungszeichen,
// Backslash, `$(…)` oder ein Text, der mit `-` anfängt, etwas ausführen oder als Schalter gelesen werden.
import { execFile } from "node:child_process";
import { MacNotifyRequestSchema, t } from "@nyxos/shared";
import { findBin } from "../platform.js";

export type NotifyRunner = (bin: string, args: string[], timeoutMs: number) => Promise<void>;

export const OSASCRIPT = "/usr/bin/osascript";

/** Festes AppleScript: liest Titel/Text aus argv, nie aus dem Skripttext. */
export const NOTIFY_SCRIPT = ["on run argv", 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', "end run"] as const;

const TIMEOUT_MS = 4000;
/** macOS kürzt ohnehin; lange Texte wären nur unnötig im Prozess-Argument. */
const MAX_TITLE = 120;
const MAX_MESSAGE = 400;

const defaultRunner: NotifyRunner = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300) || t("{bin} fehlgeschlagen", { bin })));
      else resolve();
    });
  });

/** Steuerzeichen (außer Zeilenumbruch) werden Leerzeichen, Länge begrenzt — sonst bleibt der Text, wie er ist. */
export function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

/** Argumente für `osascript`: festes Skript, dann `--`, dann genau zwei argv-Werte (Titel, Text). */
export function osascriptArgs(title: string, message: string): string[] {
  const args: string[] = [];
  for (const line of NOTIFY_SCRIPT) args.push("-e", line);
  args.push("--", cleanText(title, MAX_TITLE) || "NyxOS", cleanText(message, MAX_MESSAGE) || " ");
  return args;
}

export async function showMacNotification(params: unknown, run: NotifyRunner = defaultRunner): Promise<{ shown: true }> {
  const req = MacNotifyRequestSchema.parse(params);
  await run(OSASCRIPT, osascriptArgs(req.title, req.message), TIMEOUT_MS);
  return { shown: true };
}

/** Argumente für `notify-send`: App-Name, dann `--`, dann Titel und Text (nie als Schalter lesbar). */
export function notifySendArgs(title: string, message: string): string[] {
  return ["--app-name=NyxOS", "--", cleanText(title, MAX_TITLE) || "NyxOS", cleanText(message, MAX_MESSAGE) || " "];
}

export interface NotifyDeps {
  run?: NotifyRunner;
  platform?: NodeJS.Platform;
  /** Pfad zu `notify-send`; `undefined` = im PATH suchen, `null` = fehlt. */
  notifySend?: string | null;
}

/** Mitteilung auf diesem Rechner: macOS immer, Linux mit `notify-send` (Paket libnotify), sonst ein klarer Fehler. */
export async function showNotification(params: unknown, deps: NotifyDeps = {}): Promise<{ shown: true }> {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return showMacNotification(params, deps.run);
  const req = MacNotifyRequestSchema.parse(params);
  const bin = deps.notifySend !== undefined ? deps.notifySend : findBin("notify-send");
  if (platform !== "linux" || !bin) throw new Error(t("Mitteilungen gehen hier nicht: notify-send fehlt (Paket libnotify-bin)"));
  await (deps.run ?? defaultRunner)(bin, notifySendArgs(req.title, req.message), TIMEOUT_MS);
  return { shown: true };
}
