// Wartet die Session wirklich auf Eingabe? Eine Quelle für alle, die Text in eine
// Session schicken (Kontext komprimieren D3, Kontext-Wächter „Erzwingen“ W1, Konflikt-Hinweis G3,
// Chat „sofort“ vs. „in der Warteschlange“ D1).
//
// Früher galt nur die LETZTE Bildschirmzeile. Claude Code 2.1.282 zeichnet aber unter der Eingabe noch
// eine Trennlinie und Statuszeilen („out:208tok total:48,8k ctx:24%“, „⏸ manual mode on“), und in der
// leeren Eingabe steht ein grauer Vorschlag („Try "write a test …"“). Echte Abzüge: test/fixtures/screens/
// (`*.txt` = `capture-pane -p`, `*.ansi` = `capture-pane -p -e`). Darum hier: den Eingabe-Block unten
// suchen, die Zeilen darunter nur als Statuszeilen zulassen, grau (SGR 2) gezeichneten Text als
// Vorschlag erkennen — nie als getippten Text.

import { t } from "@nyxos/shared";
import { screenWaiting } from "./detect.js";

type Tool = "claude" | "codex";

export type PromptState =
  /** Leere Eingabe, nichts läuft, keine Frage offen. */
  | "idle"
  /** Spinner/„esc to interrupt“ über oder unter der Eingabe. */
  | "working"
  /** Freigabe-Frage oder Auswahl-Menü offen. */
  | "dialog"
  /** In der Eingabe steht schon Text (vom Nutzer), der nicht überschrieben werden darf. */
  | "typed"
  /** Keine Eingabezeile erkannt (z. B. Menü, Startbildschirm) — nie senden. */
  | "unknown";

/**
 * Arbeits-Anzeigen: „✽ Unraveling… (2s · …)“, „Running 1 shell command…“, Codex „Working (5s • esc to interrupt)“.
 * „Compacting conversation…“ auch ohne Spinner-Zeichen/Zeit — beim Komprimieren sagt der Hook
 * schon „wartet“, dann bremst nur noch der Bildschirm.
 */
export const WORKING_RE = /(esc to interrupt|…\s*\(\d+[sm]\b|Running \d+ shell command|\bWorking\b|\bCompacting conversation\b)/i;
/** Claude-Spinner auch ohne Zeitangabe („· Kneading…“, erste Sekunde): Spinner-Zeichen + Wort + „…“. */
const SPINNER_RE = /^\s*[·✢✳✶✻✽∗*]\s+\S.*…/;
/** Eingabezeile: Prompt-Zeichen am Zeilenanfang. */
const PROMPT_RE: Record<Tool, RegExp> = { claude: /^\s*[>❯](?:\s|$)/, codex: /^\s*›(?:\s|$)/ };
/** Menüpunkt („❯ 1. Yes“, „› 1. Update now“) ist nie die Eingabe. */
const MENU_ITEM_RE = /^\s*[>❯›]\s*\d+\.\s/;
/** Trennlinie über/unter der Claude-Eingabe (auch Codex-Rahmen). */
const RULE_RE = /^\s*[─━╌┄-]{10,}\s*$/;
/** So viele nicht-leere Zeilen darf die Eingabe höchstens über dem unteren Rand stehen. */
const MAX_LINES_BELOW = 6;
/** Wie viele nicht-leere Zeilen über der Eingabe auf einen Spinner geprüft werden. */
const WORKING_LINES_ABOVE = 5;
/** Codex: so viele Statuszeilen unter der Eingabe (Modell · Ordner, Kontext-Anzeige). */
const CODEX_STATUS_LINES = 2;

interface Line {
  /** Ohne Steuerzeichen. */
  plain: string;
  /** Ohne Steuerzeichen UND ohne grau (dim) gezeichneten Text — das, was wirklich getippt ist. */
  typed: string;
  /** Erstes sichtbares Zeichen grau gezeichnet (dim oder Grau-Farbe) — bei Claude das Prompt-Zeichen. */
  firstGrey: boolean;
}

/** Grau-Töne der 256er-Palette (232–255) und „hell-schwarz“ (8). */
const isGrey256 = (n: number) => n === 8 || (n >= 232 && n <= 255);

// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[([0-9;:?]*)([A-Za-z])/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

/** Eine Zeile aus `capture-pane -e` zerlegen: sichtbarer Text + nur der nicht-graue Anteil. */
export function splitStyled(raw: string): Line {
  const s = raw.replace(OTHER_ESC_RE, "");
  let plain = "";
  let typed = "";
  let dim = false;
  let greyFg = false;
  let firstGrey: boolean | null = null;
  const take = (chunk: string) => {
    plain += chunk;
    if (!dim) typed += chunk;
    if (firstGrey === null && chunk.trim() !== "") firstGrey = dim || greyFg;
  };
  let last = 0;
  CSI_RE.lastIndex = 0;
  for (let m = CSI_RE.exec(s); m; m = CSI_RE.exec(s)) {
    take(s.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== "m") continue;
    // SGR: 2 = grau an, 22 / 0 / leer = aus. Farbwerte (38;5;n / 38;2;r;g;b) überspringen, damit eine
    // „2“ darin nicht als „grau“ gelesen wird.
    const params = (m[1] ?? "").split(/[;:]/);
    for (let i = 0; i < params.length; i++) {
      const p = params[i] === "" ? 0 : Number(params[i]);
      if (p === 38 || p === 48 || p === 58) {
        if (p === 38) greyFg = params[i + 1] === "5" && isGrey256(Number(params[i + 2]));
        i += params[i + 1] === "5" ? 2 : params[i + 1] === "2" ? 4 : 1;
        continue;
      }
      if (p === 0) {
        dim = false;
        greyFg = false;
      } else if (p === 22) dim = false;
      else if (p === 2) dim = true;
      else if (p === 39 || (p >= 30 && p <= 37) || (p >= 91 && p <= 97)) greyFg = false;
      else if (p === 90) greyFg = true;
    }
  }
  take(s.slice(last));
  return { plain, typed, firstGrey: firstGrey ?? false };
}

/** Wo steht die Eingabe, und ist darunter nur Rahmen/Status? Index der Eingabezeile oder -1. */
function findPromptLine(tool: Tool, lines: Line[]): number {
  let nonEmptyBelow = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = lines[i]?.plain ?? "";
    if (plain.trim() === "") continue;
    if (PROMPT_RE[tool].test(plain) && !MENU_ITEM_RE.test(plain)) return belowIsChrome(tool, lines, i) ? i : -1;
    nonEmptyBelow++;
    if (nonEmptyBelow > MAX_LINES_BELOW) return -1;
  }
  return -1;
}

/**
 * Unter der Eingabe darf nur stehen: leere Zeilen, eine Trennlinie und danach Statuszeilen (Claude),
 * bzw. eingerückte Statuszeilen (Codex: „  gpt-5.6-luna medium · ~/code/app“). Steht zwischen
 * Eingabe und Trennlinie echter Text, ist das eine mehrzeilige Eingabe → nicht leer.
 */
function belowIsChrome(tool: Tool, lines: Line[], promptIdx: number): boolean {
  let sawRule = false;
  let codexStatus = 0;
  for (let i = promptIdx + 1; i < lines.length; i++) {
    const line = lines[i] as Line;
    if (line.plain.trim() === "") continue;
    if (RULE_RE.test(line.plain)) {
      sawRule = true;
      continue;
    }
    if (sawRule) continue; // Statuszeilen unter der Trennlinie
    // Codex hat keine Trennlinie: bis zu zwei eingerückte Statuszeilen direkt darunter.
    if (tool === "codex" && /^\s{2,}\S/.test(line.plain) && ++codexStatus <= CODEX_STATUS_LINES) continue;
    return false;
  }
  return true;
}

/** Oberkante des Eingabe-Blocks: die Trennlinie direkt über der Eingabe (falls vorhanden). */
function blockTop(lines: Line[], promptIdx: number): number {
  for (let i = promptIdx - 1; i >= 0; i--) {
    const plain = lines[i]?.plain ?? "";
    if (plain.trim() === "") continue;
    return RULE_RE.test(plain) ? i : promptIdx;
  }
  return promptIdx;
}

/**
 * Zustand der Session laut Bildschirm. `screen` darf Steuerzeichen enthalten (`capture-pane -e`) — dann
 * wird ein grauer Vorschlag in der Eingabe erkannt. Ohne Steuerzeichen gilt jeder Text hinter dem
 * Prompt-Zeichen als getippt (lieber nicht senden als den Text des Nutzers zerstören).
 */
export function promptState(tool: Tool, screen: string): PromptState {
  const lines = screen.replace(/\s+$/, "").split("\n").map(splitStyled);
  const plainScreen = lines.map((l) => l.plain).join("\n");
  if (screenWaiting(tool, plainScreen).waiting) return "dialog";

  const promptIdx = findPromptLine(tool, lines);
  // Arbeits-Anzeige nahe der Eingabe (darüber) und in den Statuszeilen darunter — nicht im ganzen
  // Verlauf: eine Antwort, die das Wort „Working“ enthält, soll die Session nicht blockieren.
  const top = promptIdx >= 0 ? blockTop(lines, promptIdx) : lines.length;
  const near: string[] = [];
  for (let i = top - 1; i >= 0 && near.length < WORKING_LINES_ABOVE; i--) {
    const plain = lines[i]?.plain ?? "";
    if (plain.trim() !== "") near.push(plain);
  }
  if (promptIdx >= 0) for (let i = promptIdx + 1; i < lines.length; i++) near.push(lines[i]?.plain ?? "");
  // Getippter Text zuerst — auch wenn Claude gerade arbeitet, darf der Chat nichts an
  // Entwurf des Nutzers anhängen. Der graue Vorschlag ist in `typed` schon weg.
  const input = promptIdx >= 0 ? (lines[promptIdx] as Line).typed.replace(/^\s*[>❯›]/, "").trim() : "";
  if (input !== "") return "typed";
  if (near.some((l) => WORKING_RE.test(l) || SPINNER_RE.test(l))) return "working";
  if (promptIdx < 0) return "unknown";
  // Während Claude die Antwort schreibt, steht oft kein Spinner da — aber das Prompt-Zeichen
  // ist grau (echte Abzüge: streaming/spinner grau, wartend Standardfarbe). Nur mit Farben erkennbar;
  // ohne Farben bleibt der Hook-Zustand die zweite Quelle.
  if (tool === "claude" && (lines[promptIdx] as Line).firstGrey) return "working";
  return "idle";
}

/** Freundlicher Grund für den Nutzer, warum nicht gesendet wurde. */
export function notIdleReason(state: Exclude<PromptState, "idle">): string {
  switch (state) {
    case "working":
      return t("Session arbeitet gerade");
    case "dialog":
      return t("Die Session wartet auf eine Freigabe – beantworte sie zuerst im Terminal.");
    case "typed":
      return t("In der Eingabe der Session steht schon angefangener Text – schick ihn ab oder lösche ihn, dann geht es.");
    case "unknown":
      return t("Die Eingabe der Session ist gerade nicht zu sehen (z. B. ein Menü ist offen). Schau kurz ins Terminal.");
  }
}
