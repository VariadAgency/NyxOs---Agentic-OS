// Ausführer für `nyx.ui` im Browser (Vertrag in packages/shared/src/nyx-ui.ts).
// Findet das Ziel (`data-nyx`-Kennung, Präfix mit `*` oder sichtbare Beschriftung), lässt den Nyx-Cursor
// sichtbar hinfliegen und klickt/tippt/wählt/scrollt. Riskante Ziele (`data-nyx-risk` am Element oder einem
// Vorfahren, oder eine Beschriftung aus der Freigabe-Liste wie „Löschen“, „Merge“, „Push“, „Deploy“) klickt Nyx NIE –
// er zeigt nur mit Glow darauf. DOM-Logik ohne React, damit sie in jsdom testbar ist.
// `select` wählt in Auswahllisten, Radio-Gruppen und Schaltern; „neue-session“ klappt von jeder Seite aus.
// Nyx klickt WIRKLICH (Zeiger-/Maus-Ereignisse + click am echten Element), `navigate` klickt den Eintrag in der
// Leiste, Ziele werden per MutationObserver abgewartet, Listeneinträge (`data-nyx-item` + `data-nyx-at`) sind als
// `item:<art>[:<rang>|:<text>]` ansprechbar – z. B. `item:session` = neueste Session, `item:task:heatmap` = Aufgabe per Text.
import { isRiskyLabel, t, type NyxScreenElement, type NyxUiCommand, type NyxUiScreen } from "@nyxos/shared";

export interface NyxCursorDriver {
  /** Cursor sichtbar zu (x, y) fliegen lassen (Bildschirm-Koordinaten). */
  flyTo(x: number, y: number): Promise<void>;
  /** Kurzer „Druck“ (Klick-Animation). */
  press(): Promise<void>;
  /** Ziel leuchten lassen (riskant oder „zeig mal“). */
  glow(rect: DOMRect, ms?: number, risky?: boolean): void;
}

export interface ExecDeps {
  navigate: (route: string) => void;
  cursor: NyxCursorDriver;
  root?: ParentNode;
  /** Aktuelle Route (für die Antwort). */
  route: () => string;
  /** So lange warten, bis ein Ziel erscheint (z. B. nach einem Seitenwechsel). */
  waitMs?: number;
  /** Pause je Zeichen beim Tippen (sichtbares Tippen). */
  typeDelayMs?: number;
}

export interface ExecResult {
  ok: boolean;
  risky?: boolean;
  detail?: string;
  route?: string;
  screen?: NyxUiScreen;
}

const INTERACTIVE =
  "a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=radiogroup],[role=radio],[role=switch],[role=checkbox],[contenteditable=true],[data-nyx]";

const norm = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[✕×⋯…]/g, "")
    .trim();

const isJsdom = () => typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);

export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return false;
  if (el.closest("[hidden],[inert],[aria-hidden=true]")) return false;
  for (let n: Element | null = el; n; n = n.parentElement) {
    const st = getComputedStyle(n);
    if (st.display === "none" || st.visibility === "hidden") return false;
  }
  // jsdom rechnet keine Größen – dort reicht die Stil-Prüfung.
  if (isJsdom()) return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Sichtbare Beschriftung eines Elements (für Suche und `read_screen`). */
export function labelOf(el: Element): string {
  const h = el as HTMLElement;
  const own = h.getAttribute("aria-label") ?? h.getAttribute("title");
  if (own) return own.trim();
  if (h instanceof HTMLSelectElement) {
    // Nie den Text aller Optionen – nur die Beschriftung des Felds.
    const byId = h.id ? document.querySelector(`label[for="${CSS.escape(h.id)}"]`)?.textContent : null;
    return (byId || h.name || "").trim();
  }
  if (h instanceof HTMLInputElement || h instanceof HTMLTextAreaElement) {
    const byId = h.id ? document.querySelector(`label[for="${CSS.escape(h.id)}"]`)?.textContent : null;
    return (h.placeholder || byId || h.name || "").trim();
  }
  return (h.textContent ?? "").replace(/\s+/g, " ").trim();
}

function kindOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role");
  const control = controlOf(el, false);
  if (control) return control.kind === "toggle" ? "switch" : "select";
  if (tag === "a" || role === "link") return "link";
  if (tag === "input" || tag === "textarea" || tag === "select" || el.getAttribute("contenteditable") === "true") return "input";
  if (role === "tab") return "tab";
  if (tag === "button" || role === "button" || role === "menuitem") return "button";
  if ((el.getAttribute("data-nyx") ?? "").includes("row")) return "row";
  return "other";
}

const CLICKABLE = "button,a,[role=button],[role=menuitem],[role=link],[role=tab]";

/** Alle Beschriftungen eines Elements: aria-label/title UND – bei Knöpfen/Links – der sichtbare Text (einer allein
 * kann täuschen). Bei Karten/Zeilen nicht der ganze Text, sonst wäre jede Karte mit „Schließen“-Knopf gesperrt. */
function labelsOf(el: Element): string[] {
  const h = el as HTMLElement;
  const text = el.matches(CLICKABLE) ? (h.textContent ?? "").replace(/\s+/g, " ").trim() : "";
  return [labelOf(el), text, h.getAttribute("data-nyx") ?? "", h.getAttribute("title") ?? ""];
}

export function isRiskyElement(el: Element): boolean {
  if (el.closest("[data-nyx-risk]")) return true;
  // Geheimnisse (Schlüssel, Tokens) fasst Nyx nie an – auch nicht in einem Formular, das (noch) kein
  // `data-nyx-risk` trägt: Passwort-Felder selbst und alles in einem Formular mit Passwort-Feld gelten als riskant.
  if (el.matches("input[type=password]") || el.querySelector("input[type=password]") || el.closest("form")?.querySelector("input[type=password]")) return true;
  // Ein Listeneintrag ÖFFNET nur (Session, Aufgabe, …) – ein Titel wie „Push-Fix“ macht ihn nicht riskant.
  if (el.hasAttribute("data-nyx-item")) return false;
  if (labelsOf(el).some(isRiskyLabel)) return true;
  // Ein Klick blubbert hoch: liegt das Ziel in einem riskanten Knopf/Link, zählt dessen Beschriftung.
  const host = el.parentElement?.closest(CLICKABLE);
  return host ? labelsOf(host).some(isRiskyLabel) : false;
}

// ───────────── Listeneinträge ─────────────

/** Arten von Listeneinträgen, die Nyx kennt (`data-nyx-item` am klickbaren Eintrag). Audits sind Aufgaben-Zeilen. */
export const NYX_ITEM_KINDS = ["session", "task", "decision", "idea", "repo"] as const;
export type NyxItemKind = (typeof NYX_ITEM_KINDS)[number];
const ITEM_ALIAS: Record<string, NyxItemKind> = { audit: "task" };

/** Wie Nyx sagt, dass er nichts findet – je Art ein ganzer Satz (Grammatik je Sprache). */
const ITEM_MISSING: Record<NyxItemKind, { none: () => string; noneFor: (q: string) => string; tooFew: () => string }> = {
  session: {
    none: () => t("Ich finde keine Session."),
    noneFor: (q) => t("Ich finde keine Session zu „{q}“.", { q }),
    tooFew: () => t("So viele Einträge (Session) sehe ich nicht."),
  },
  task: {
    none: () => t("Ich finde keine Aufgabe."),
    noneFor: (q) => t("Ich finde keine Aufgabe zu „{q}“.", { q }),
    tooFew: () => t("So viele Einträge (Aufgabe) sehe ich nicht."),
  },
  decision: {
    none: () => t("Ich finde keine Entscheidung."),
    noneFor: (q) => t("Ich finde keine Entscheidung zu „{q}“.", { q }),
    tooFew: () => t("So viele Einträge (Entscheidung) sehe ich nicht."),
  },
  idea: {
    none: () => t("Ich finde keine Idee."),
    noneFor: (q) => t("Ich finde keine Idee zu „{q}“.", { q }),
    tooFew: () => t("So viele Einträge (Idee) sehe ich nicht."),
  },
  repo: {
    none: () => t("Ich finde kein Repo."),
    noneFor: (q) => t("Ich finde kein Repo zu „{q}“.", { q }),
    tooFew: () => t("So viele Einträge (Repo) sehe ich nicht."),
  },
};

const ITEM_RE = /^item:([a-z]+)(?::(.*))?$/;

interface ItemQuery {
  kind: NyxItemKind;
  rank: number | null;
  text: string | null;
}

const isItemKind = (k: string): k is NyxItemKind => (NYX_ITEM_KINDS as readonly string[]).includes(k);

function parseItemTarget(target: string): ItemQuery | null {
  const m = ITEM_RE.exec(target.trim());
  const raw = m?.[1];
  if (!raw) return null;
  const kind = ITEM_ALIAS[raw] ?? (isItemKind(raw) ? raw : null);
  if (!kind) return null;
  const rest = (m[2] ?? "").trim();
  if (!rest) return { kind, rank: 0, text: null };
  if (/^\d+$/.test(rest)) return { kind, rank: Number(rest), text: null };
  return { kind, rank: null, text: rest };
}

const stamp = (el: Element) => {
  const t = Date.parse(el.getAttribute("data-nyx-at") ?? "");
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

/** Sichtbare Einträge einer Art, neueste zuerst (ohne Zeitstempel: Reihenfolge im DOM, stabil). */
export function rankedItems(kind: NyxItemKind, root: ParentNode = document): HTMLElement[] {
  const els = [...root.querySelectorAll<HTMLElement>(`[data-nyx-item="${kind}"]`)].filter((e) => isVisible(e));
  return els
    .map((el, i) => ({ el, i, t: stamp(el) }))
    .sort((a, b) => (b.t === a.t ? a.i - b.i : b.t > a.t ? 1 : -1))
    .map((x) => x.el);
}

const compact = (s: string) => norm(s).replace(/[^\p{L}\p{N}]+/gu, "");
const words = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);

/** Unscharfer Text-Treffer: ganze Phrase (auch ohne Leerzeichen, „heat map“ = „Heatmap“) vor Wort-Überlappung. */
export function textScore(label: string, query: string): number {
  const l = norm(label);
  const q = norm(query);
  if (!q || !l) return 0;
  if (l === q) return 100;
  if (l.startsWith(q)) return 90;
  if (l.includes(q)) return 80;
  const lc = compact(label);
  const qc = compact(query);
  if (qc.length >= 3 && lc.includes(qc)) return 70;
  const qw = words(query);
  if (qw.length === 0) return 0;
  const hit = qw.filter((w) => lc.includes(w)).length;
  return hit / qw.length >= 0.5 ? Math.round(60 * (hit / qw.length)) : 0;
}

function findItem(q: ItemQuery, root: ParentNode): HTMLElement | null {
  const items = rankedItems(q.kind, root);
  if (q.text === null) return items[q.rank ?? 0] ?? null;
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const el of items) {
    const score = Math.max(textScore(labelOf(el), q.text), textScore(el.textContent ?? "", q.text) - 5);
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

/** Ziel suchen: `item:<art>…` → exakte `data-nyx`-Kennung → Präfix (`abc:*`) → sichtbare Beschriftung (genau, Anfang, enthält). */
export function findNyxTarget(target: string, root: ParentNode = document): HTMLElement | null {
  const t = target.trim();
  if (!t) return null;
  const item = parseItemTarget(t);
  if (item) return findItem(item, root);
  const visible = (els: Iterable<Element>) => [...els].find((e) => isVisible(e)) as HTMLElement | undefined;

  if (t.endsWith("*")) {
    const prefix = t.slice(0, -1);
    const hit = visible([...root.querySelectorAll("[data-nyx]")].filter((e) => (e.getAttribute("data-nyx") ?? "").startsWith(prefix)));
    if (hit) return hit;
  } else {
    const hit = visible(root.querySelectorAll(`[data-nyx="${CSS.escape(t)}"]`));
    if (hit) return hit;
  }

  const want = norm(t.replace(/\*$/, ""));
  if (!want) return null;
  const candidates = [...root.querySelectorAll(INTERACTIVE)].filter((e) => isVisible(e));
  const labelled = candidates.map((el) => ({ el, label: norm(labelOf(el)) })).filter((c) => c.label);
  const pick = labelled.find((c) => c.label === want) ?? labelled.find((c) => c.label.startsWith(want)) ?? (want.length >= 3 ? labelled.find((c) => c.label.includes(want)) : undefined);
  return (pick?.el as HTMLElement | undefined) ?? null;
}

// ───────────── Auswahl (`select`) ─────────────

/** Eine Wahl in einer Auswahl: sichtbare Beschriftung, Wert und (bei Radio-Gruppen) das Element zum Anklicken. */
interface Choice {
  label: string;
  value: string;
  el: HTMLElement | null;
}

type Control = { kind: "select"; el: HTMLSelectElement } | { kind: "radiogroup"; el: HTMLElement } | { kind: "toggle"; el: HTMLElement };

const TOGGLE = "[role=switch],[role=checkbox],input[type=checkbox]";
const CONTROL = `select,[role=radiogroup],${TOGGLE}`;
const RADIO = "[role=radio],input[type=radio]";

/** Welche Auswahl steckt hinter dem Ziel? Das Element selbst oder (bei einer Hülle mit Kennung) die erste darin. */
function controlOf(el: Element, inside = true): Control | null {
  const own = el.matches(CONTROL) ? el : inside ? el.querySelector(CONTROL) : null;
  if (!own) return null;
  if (own instanceof HTMLSelectElement) return { kind: "select", el: own };
  if (own.getAttribute("role") === "radiogroup") return { kind: "radiogroup", el: own as HTMLElement };
  return { kind: "toggle", el: own as HTMLElement };
}

/** `read_screen` bleibt klein: höchstens so viele Optionen je Auswahl, so lang je Beschriftung. */
const MAX_OPTIONS = 20;
const MAX_OPTION_LABEL = 80;
const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX_OPTION_LABEL);

function radioLabel(r: HTMLElement): string {
  if (r instanceof HTMLInputElement) return (r.labels?.[0]?.textContent ?? r.getAttribute("aria-label") ?? r.value).trim();
  return labelOf(r);
}

const isChecked = (el: HTMLElement) => (el instanceof HTMLInputElement ? el.checked : el.getAttribute("aria-checked") === "true");
const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";

function choicesFor(c: Control): Choice[] {
  if (c.kind === "select") return [...c.el.options].filter((o) => !o.disabled).map((o) => ({ label: (o.label || o.textContent || "").trim(), value: o.value, el: null }));
  if (c.kind === "radiogroup")
    return [...c.el.querySelectorAll<HTMLElement>(RADIO)]
      .filter((r) => isVisible(r) && !isDisabled(r))
      .map((r) => ({ label: radioLabel(r), value: r instanceof HTMLInputElement ? r.value : radioLabel(r), el: r }));
  return [
    { label: t("an"), value: "true", el: null },
    { label: t("aus"), value: "false", el: null },
  ];
}

function currentOf(c: Control): string | undefined {
  if (c.kind === "select") {
    const o = c.el.selectedOptions[0];
    return o ? (o.label || o.textContent || "").trim() : undefined;
  }
  if (c.kind === "radiogroup") {
    const r = [...c.el.querySelectorAll<HTMLElement>(RADIO)].find(isChecked);
    return r ? radioLabel(r) : undefined;
  }
  return isChecked(c.el) ? t("an") : t("aus");
}

/** Für `read_screen`: Möglichkeiten (gekürzt) und aktueller Wert – nur bei Auswahlen. */
function choicesOf(el: Element): Pick<NyxScreenElement, "options" | "value"> {
  const c = controlOf(el, false);
  if (!c) return {};
  const current = currentOf(c);
  return { options: choicesFor(c).slice(0, MAX_OPTIONS).map((o) => clip(o.label)), ...(current !== undefined ? { value: clip(current) } : {}) };
}

const ON = /^(an|ein|on|true|ja|yes|1|aktiv|aktivieren|einschalten|enable|enabled|active|turn on)$/i;
const OFF = /^(aus|off|false|nein|no|0|inaktiv|deaktivieren|ausschalten|disable|disabled|inactive|turn off)$/i;

/** Beste Wahl zur Eingabe: genauer Wert bzw. genaue Beschriftung zuerst, sonst unscharf (`textScore`). */
function bestChoice(choices: Choice[], want: string): Choice | null {
  const w = norm(want);
  const exact = choices.find((c) => c.value !== "" && norm(c.value) === w) ?? choices.find((c) => norm(c.label) === w);
  if (exact) return exact;
  let best: Choice | null = null;
  let bestScore = 0;
  for (const c of choices) {
    const score = Math.max(textScore(c.label, want), c.value ? textScore(c.value, want) - 1 : 0);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Wert so setzen, dass React ihn übernimmt (nativer Setter + input/change, beide blubbern). */
function setSelectValue(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const listChoices = (choices: Choice[]) =>
  choices.length
    ? choices
        .slice(0, MAX_OPTIONS)
        .map((c) => clip(c.label) || t("(leer)"))
        .join(", ")
    : t("keine");

/** Was ist gerade sichtbar und steuerbar? (Antwort auf `read_screen`.) */
export function readScreen(root: ParentNode = document, route = location.pathname + location.search): NyxUiScreen {
  const seen = new Set<string>();
  const elements: NyxScreenElement[] = [];
  for (const el of root.querySelectorAll("[data-nyx]")) {
    const id = el.getAttribute("data-nyx") ?? "";
    if (!id || seen.has(id) || !isVisible(el)) continue;
    seen.add(id);
    elements.push({ id: id.slice(0, 200), label: labelOf(el).slice(0, 200), kind: kindOf(el), risk: isRiskyElement(el), ...choicesOf(el) });
    if (elements.length >= 300) break;
  }
  // Auswahllisten/Radio-Gruppen ohne Kennung – über ihre Beschriftung ansprechbar (`ui_select` mit dem Label).
  for (const el of root.querySelectorAll("select:not([data-nyx]),[role=radiogroup]:not([data-nyx])")) {
    if (elements.length >= 330 || !isVisible(el)) continue;
    const label = labelOf(el).slice(0, 200);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    elements.push({ id: label, label, kind: "select", risk: isRiskyElement(el), ...choicesOf(el) });
  }
  // Listeneinträge nach Rang (neueste zuerst) – das Modell klickt dann `item:<art>:<rang>`.
  for (const kind of NYX_ITEM_KINDS) {
    rankedItems(kind, root)
      .slice(0, 25)
      .forEach((el, rank) => {
        if (elements.length < 390) elements.push({ id: `item:${kind}:${rank}`, label: labelOf(el).slice(0, 200), kind: "row", risk: isRiskyElement(el) });
      });
  }
  const title = (document.querySelector("main h1")?.textContent ?? document.title ?? "").trim().slice(0, 300);
  return { route: route.slice(0, 500), title, elements };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wartet, bis `find` etwas liefert: prüft bei jeder DOM-Änderung (MutationObserver) und zur Sicherheit alle 100 ms. */
export function waitFor<T>(find: () => T | null, waitMs: number, root: ParentNode = document): Promise<T | null> {
  const first = find();
  if (first || waitMs <= 0) return Promise.resolve(first);
  return new Promise((resolve) => {
    let done = false;
    // Alles Folgende läuft erst asynchron (Beobachter/Takt/Frist) – dann sind obs/poll/timer schon gesetzt.
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      obs?.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(v);
    };
    const check = () => {
      const v = find();
      if (v) finish(v);
    };
    const target = root instanceof Node ? root : document;
    const obs = typeof MutationObserver !== "undefined" ? new MutationObserver(check) : null;
    obs?.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class", "data-nyx", "data-nyx-item"] });
    const poll = setInterval(check, 100);
    const timer = setTimeout(() => finish(find()), waitMs);
  });
}

function centerOf(el: Element): { x: number; y: number; rect: DOMRect } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 18), rect };
}

/** Setzt den Wert so, dass auch React-gesteuerte Felder ihn übernehmen. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const NOT_VISIBLE = (target: string) => t("„{target}“ ist gerade nicht zu sehen.", { target });

/** Ehrliche Antwort, wenn das Ziel fehlt – bei Listeneinträgen in Nyx' Worten („Ich finde keine Session.“). */
function notFound(target: string): string {
  const q = parseItemTarget(target);
  if (!q) return NOT_VISIBLE(target);
  const m = ITEM_MISSING[q.kind];
  if (q.text) return m.noneFor(q.text);
  return q.rank ? m.tooFew() : m.none();
}

/** Ziele direkt nach einem Seitenwechsel dürfen etwas brauchen; Listen laden ihre Daten erst. */
const DEFAULT_WAIT_MS = 1800;
const ITEM_WAIT_MS = 4000;
/** Tempo beim Tippen: schnell, aber sichtbar. */
const TYPE_DELAY_MS = 15;
/** Kurzes Aufleuchten des angeklickten Elements. */
const CLICK_FLASH_MS = 650;

function mouseLike(type: string, x: number, y: number, pointer: boolean): Event {
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith("down") ? 1 : 0 };
  if (pointer && typeof PointerEvent !== "undefined") return new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true });
  return new MouseEvent(type, init);
}

/** Ein echter Klick: Zeiger/Maus runter und hoch am Element, Fokus, dann `click()` (löst auch React-Router-Links aus).
 * Zeiger-Ereignisse zählen, weil manche Menüs schon beim Drücken aufgehen und auf `click` allein nicht reagieren. */
export function realClick(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  el.dispatchEvent(mouseLike("pointerover", x, y, true));
  el.dispatchEvent(mouseLike("mouseover", x, y, false));
  el.dispatchEvent(mouseLike("pointerdown", x, y, true));
  el.dispatchEvent(mouseLike("mousedown", x, y, false));
  if (el.isConnected && el.matches("a[href],button,input,textarea,select,summary,[tabindex]")) el.focus({ preventScroll: true });
  el.dispatchEvent(mouseLike("pointerup", x, y, true));
  el.dispatchEvent(mouseLike("mouseup", x, y, false));
  el.click();
}

/** Ist das Element selbst anklickbar (Knopf/Link), oder nur eine Karte, auf die Nyx zeigt? */
const isClickable = (el: Element) => el.matches(CLICKABLE) || el.matches("summary,input,select,textarea,[onclick]");

/** Leiste versteckt (Handy-Schublade)? Dann erst „Mehr“ (untere Leiste) bzw. „Menü“ öffnen – auch das klickt der
 * Cursor sichtbar. vorher gab es den Knopf „menue“ nicht mehr – am Handy sprang Nyx deshalb still. */
async function revealNav(target: string, root: ParentNode, deps: ExecDeps): Promise<void> {
  if (!target.startsWith("nav:") || findNyxTarget(target, root)) return;
  if (!root.querySelector(`[data-nyx="${CSS.escape(target)}"]`)) return;
  const menu = findNyxTarget("tabbar:mehr", root) ?? findNyxTarget("menue", root);
  if (!menu) return;
  const c = centerOf(menu);
  await deps.cursor.flyTo(c.x, c.y);
  await deps.cursor.press();
  realClick(menu);
}

// ───────────── Navigation per Cursor ─────────────

const pathOf = (route: string) => (route.split(/[?#]/)[0] ?? route).replace(/(.)\/+$/, "$1");
const safeDecode = (s: string) => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};
/** Pfad-Vergleich unabhängig von Kodierung (`/skills/a%20b` = `/skills/a b`). */
const samePath = (a: string, b: string) => safeDecode(pathOf(a)) === safeDecode(pathOf(b));
/** `prefix` ist ein ganzer Pfad-Abschnitt von `path` (`/settings` ⊂ `/settings/konto`, nicht `/set`). */
const underPath = (path: string, prefix: string) => samePath(path, prefix) || safeDecode(pathOf(path)).startsWith(`${safeDecode(pathOf(prefix))}/`);

/** Wohin führt ein Klick auf das Element? Link-Ziel oder `data-nyx-href` (Kacheln/Karten, die per Code navigieren). */
function hrefOf(el: Element): string | null {
  const h = el.getAttribute("data-nyx-href") ?? (el.matches("a[href]") ? el.getAttribute("href") : null);
  return h && h.startsWith("/") ? h : null;
}

/** Höchstens so viele Klicks für eine Navigation (Leiste → Übersicht → Bereich → Unterseite → …). */
const MAX_NAV_STEPS = 8;
/** So lange wartet der Cursor nach einem Klick auf den Seitenwechsel bzw. auf das nächste Ziel. */
const NAV_STEP_WAIT_MS = 2500;

/** Ein Leisten-Eintrag: am Handy lieber das Pendant in der unteren Leiste (sichtbar), sonst über „Mehr“ aufklappen. */
async function navElement(navId: string, root: ParentNode, deps: ExecDeps): Promise<HTMLElement | null> {
  const tab = findNyxTarget(`tabbar:${navId}`, root);
  if (tab && root.querySelector(`[data-nyx="tabbar:${CSS.escape(navId)}"]`) === tab) return tab;
  const id = `nav:${navId}`;
  await revealNav(id, root, deps);
  return waitFor(() => {
    const el = root.querySelector<HTMLElement>(`[data-nyx="${CSS.escape(id)}"]`);
    return el && isVisible(el) ? el : null;
  }, 800, root);
}

/** Ziel eines Klickpfad-Schritts (data-nyx-Kennung); `nav:<id>` klappt die Leiste bei Bedarf auf. */
async function viaElement(step: string, root: ParentNode, deps: ExecDeps, wait: number): Promise<HTMLElement | null> {
  if (step.startsWith("nav:")) return navElement(step.slice(4), root, deps);
  return waitFor(() => {
    const el = root.querySelector<HTMLElement>(`[data-nyx="${CSS.escape(step)}"]`);
    return el && isVisible(el) ? el : null;
  }, wait, root);
}

/** Nächster Klick ohne Klickpfad: ein sichtbarer Link genau zum Ziel, sonst der längste passende Abschnitt, sonst die
 * Leiste (als `{ nav }` – sie kann am Handy zu sein und wird dann erst aufgeklappt). */
function genericCandidate(targetPath: string, current: string, root: ParentNode, tried: Set<Element>): HTMLElement | { nav: string } | null {
  const links = [...root.querySelectorAll<HTMLElement>("a[href],[data-nyx-href]")].filter((el) => !tried.has(el) && isVisible(el));
  const exact = links.filter((el) => samePath(hrefOf(el) ?? "", targetPath));
  const exactHit = exact.find((el) => el.hasAttribute("data-nyx")) ?? exact[0];
  if (exactHit) return exactHit;
  // Tiefer in dieselbe Richtung: Link, dessen Ziel ein Abschnitt des Ziels und länger als der jetzige Stand ist.
  const isBar = (el: Element) => /^(nav|tabbar):/.test(el.getAttribute("data-nyx") ?? "");
  const deeper = links
    .map((el) => ({ el, href: hrefOf(el) ?? "" }))
    .filter((c) => c.href && !isBar(c.el) && underPath(targetPath, c.href) && !underPath(current, c.href))
    .sort((a, b) => pathOf(b.href).length - pathOf(a.href).length)[0];
  if (deeper) return deeper.el;
  // Leiste: der Eintrag, unter dem das Ziel liegt.
  let best: { id: string; len: number } | null = null;
  for (const el of root.querySelectorAll<HTMLElement>('[data-nyx^="nav:"]')) {
    const href = el.getAttribute("href");
    const id = el.getAttribute("data-nyx")?.slice(4);
    if (!href || !id || tried.has(el) || !underPath(targetPath, href) || underPath(current, href)) continue;
    if (!best || href.length > best.len) best = { id, len: href.length };
  }
  return best ? { nav: best.id } : null;
}

/** Schöner Name eines Schritts für die Antwort („Skills → /web-design“). */
const stepName = (el: HTMLElement) => (labelOf(el).split(/\s[–-]\s/)[0] ?? "").slice(0, 40) || (el.getAttribute("data-nyx") ?? "");

/** `navigate`: Schritt für Schritt per Cursor bis zum Ziel. Kein stiller Routensprung. */
async function navigateByCursor(cmd: Extract<NyxUiCommand, { action: "navigate" }>, deps: ExecDeps, root: ParentNode): Promise<ExecResult> {
  const targetPath = pathOf(cmd.route);
  const via = cmd.via ?? [];
  const tried = new Set<Element>();
  const trail: string[] = [];
  const wait = deps.waitMs ?? NAV_STEP_WAIT_MS;
  let viaPos = 0;
  for (let i = 0; i < MAX_NAV_STEPS && !samePath(deps.route(), targetPath); i++) {
    const current = deps.route();
    let el: HTMLElement | null = null;
    // Klickpfad der Karte: der späteste Schritt, der schon zu sehen ist (bin ich schon in „Einstellungen“, geht es
    // gleich mit der Zeile weiter) – sonst der nächste offene Schritt, auf den der Cursor kurz wartet.
    for (let k = via.length - 1; k >= viaPos; k--) {
      const step = via[k] ?? "";
      if (step.startsWith("nav:")) {
        if (k !== viaPos) continue;
        viaPos = k + 1;
        const href = root.querySelector(`[data-nyx="${CSS.escape(step)}"]`)?.getAttribute("href");
        // Schon genau auf dieser Seite der Leiste – nicht noch mal klicken.
        if (href && samePath(current, href)) break;
        el = await navElement(step.slice(4), root, deps);
        break;
      }
      const found = await viaElement(step, root, deps, k === viaPos ? wait : 0);
      if (found && !tried.has(found)) {
        el = found;
        viaPos = k + 1;
        break;
      }
    }
    if (!el) {
      const cand = await waitFor(() => genericCandidate(targetPath, current, root, tried), wait, root);
      el = cand && "nav" in cand ? await navElement(cand.nav, root, deps) : cand;
    }
    if (!el) break;
    tried.add(el);
    if (!isClickable(el)) break;
    const r = await clickEl(el, deps);
    if (!r.ok) return { ...r, route: deps.route() };
    trail.push(stepName(el));
    await waitFor(() => (deps.route() !== current ? true : null), wait, root);
  }
  if (!samePath(deps.route(), targetPath)) {
    const where = trail.length ? ` ${t("Ich bin bis „{trail}“ gekommen.", { trail: trail.join(" → ") })}` : "";
    return { ok: false, detail: `${t("Ich finde keinen Klickweg nach {route}.", { route: cmd.route })}${where} ${t("Schau mit ui_read_screen, was zu sehen ist.")}`, route: deps.route() };
  }
  // Auf der Zielseite: `?…` (z. B. Vorlesen starten) bzw. `#…` (Stelle auf der Seite) direkt setzen – kein Tab-Wechsel.
  const [, rest = ""] = /^[^?#]*(.*)$/.exec(cmd.route) ?? [];
  if (rest) {
    const search = rest.split("#")[0] ?? "";
    const hash = rest.includes("#") ? rest.slice(rest.indexOf("#") + 1) : "";
    if (search && !deps.route().endsWith(search)) deps.navigate(cmd.route);
    else if (hash) deps.navigate(cmd.route);
    if (hash) {
      const spot = await waitFor(() => {
        const e = root instanceof Document ? root.getElementById(hash) : root.querySelector<HTMLElement>(`#${CSS.escape(hash)}`);
        return e && isVisible(e) ? e : null;
      }, 1500, root);
      if (spot) {
        spot.scrollIntoView?.({ behavior: "smooth", block: "center" });
        const c = centerOf(spot);
        await deps.cursor.flyTo(c.x, c.y);
        deps.cursor.glow(c.rect, 2400);
      }
    }
  }
  return { ok: true, route: cmd.route, ...(trail.length ? { detail: t("Weg: {trail}", { trail: trail.join(" → ") }) } : {}) };
}

async function clickEl(el: HTMLElement, deps: ExecDeps): Promise<ExecResult> {
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const c = centerOf(el);
  await deps.cursor.flyTo(c.x, c.y);
  if (!isClickable(el)) {
    // Karte ohne eigenen Knopf (z. B. eine Entscheidung): hinzeigen, NIE einen Knopf darin raten (Ja/Nein!).
    // VOR der Risiko-Prüfung — Entscheidungs-Karten tragen `data-nyx-risk` (ihre Ja/Nein-Knöpfe sind
    // tabu), die Karte selbst zeigt Nyx aber weiter ruhig an („Hier ist es.“) statt „riskanter Knopf“.
    el.scrollIntoView?.({ behavior: "smooth", block: "center" });
    deps.cursor.glow(el.getBoundingClientRect(), 2400);
    return { ok: true, detail: t("Hier ist es."), route: deps.route() };
  }
  if (isRiskyElement(el)) {
    deps.cursor.glow(c.rect, 3200, true);
    return { ok: false, risky: true, detail: t("Riskanter Knopf – ich zeige nur darauf. Klick selbst, wenn du willst."), route: deps.route() };
  }
  await deps.cursor.press();
  realClick(el);
  deps.cursor.glow(c.rect, CLICK_FLASH_MS);
  return { ok: true, route: deps.route() };
}

/** Abschicken wie per Enter: Tastendruck am Feld; steckt es in einem Formular, dieses absenden. */
function submitField(field: HTMLElement): void {
  const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  const go = field.dispatchEvent(new KeyboardEvent("keydown", opts));
  field.dispatchEvent(new KeyboardEvent("keyup", opts));
  const form = field.closest("form");
  if (go && form) form.requestSubmit();
}

/** Ziele, die es nur auf einer bestimmten Seite gibt. Fehlen sie, geht Nyx erst sichtbar dorthin (Leiste), statt
 * „nicht zu sehen“ zu melden – z. B. „neue-session“ (der „+“-Knopf in der Session-Tab-Leiste). */
export const NYX_TARGET_HOME: Readonly<Record<string, string>> = { "neue-session": "/sessions" };
/** Kennungen, deren Seite am Präfix erkennbar ist (Skill-Kachel, Einstellungs-Zeile, Idee, Session). */
const NYX_PREFIX_HOME: readonly (readonly [string, string])[] = [
  ["skill-", "/skills"],
  ["settings:", "/settings"],
  ["idea:", "/ideas"],
  ["session-row:", "/sessions"],
];

/** `true` = Nyx musste erst die Seite wechseln (dann darf das Ziel etwas länger brauchen). */
async function openHomeOf(target: string, root: ParentNode, deps: ExecDeps): Promise<boolean> {
  const home = NYX_TARGET_HOME[target] ?? NYX_PREFIX_HOME.find(([p]) => target.startsWith(p))?.[1];
  if (!home || findNyxTarget(target, root)) return false;
  if (samePath(deps.route(), home)) {
    // Schon auf der Seite, aber das Ziel fehlt (z. B. Unteransicht offen): Leisten-Eintrag noch mal sichtbar klicken.
    const id = root.querySelector(`[data-nyx^="nav:"][href="${CSS.escape(home)}"]`)?.getAttribute("data-nyx")?.slice(4);
    const nav = id ? await navElement(id, root, deps) : null;
    if (nav) await clickEl(nav, deps);
    return true;
  }
  await executeNyxUi({ action: "navigate", route: home }, deps);
  return true;
}

/** `select`: Auswahlliste, Radio-Gruppe oder Schalter bedienen – sichtbar, wie du es tätest. */
async function selectIn(el: HTMLElement, target: string, option: string, deps: ExecDeps, root: ParentNode): Promise<ExecResult> {
  const control = controlOf(el);
  if (!control) return { ok: false, detail: t("In „{target}“ kann ich nichts auswählen – das ist keine Auswahl.", { target }), route: deps.route() };
  const ctl = control.el;
  ctl.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const c = centerOf(ctl);
  await deps.cursor.flyTo(c.x, c.y);
  if (isRiskyElement(ctl)) {
    deps.cursor.glow(c.rect, 3200, true);
    return { ok: false, risky: true, detail: t("Hier wähle ich nicht selbst – ich zeige nur darauf."), route: deps.route() };
  }
  // Gesperrt, weil noch geladen wird (z. B. Ordner)? Kurz warten, dann ehrlich melden.
  const settle = Math.min(deps.waitMs ?? DEFAULT_WAIT_MS, DEFAULT_WAIT_MS);
  if (isDisabled(ctl) && !(await waitFor(() => (isDisabled(ctl) ? null : ctl), settle, root))) {
    return { ok: false, detail: t("„{target}“ ist gerade gesperrt.", { target }), route: deps.route() };
  }

  if (control.kind === "toggle") {
    const want = option.trim();
    const on = ON.test(want) ? true : OFF.test(want) ? false : null;
    if (on === null) return { ok: false, detail: t("„{target}“ ist ein Schalter – wähle „an“ oder „aus“.", { target }), route: deps.route() };
    if (isChecked(ctl) !== on) {
      await deps.cursor.press();
      realClick(ctl);
    }
    deps.cursor.glow(c.rect, CLICK_FLASH_MS);
    return { ok: true, detail: on ? t("„{target}“ ist an.", { target }) : t("„{target}“ ist aus.", { target }), route: deps.route() };
  }

  // Optionen laden manchmal nach (z. B. Ordner von der Brücke): kurz warten, bis etwas passt.
  const pick = await waitFor(() => bestChoice(choicesFor(control), option), settle, root);
  if (!pick) return { ok: false, detail: t("„{option}“ gibt es bei „{target}“ nicht. Zur Wahl: {choices}.", { option, target, choices: listChoices(choicesFor(control)) }), route: deps.route() };
  if (pick.el && isRiskyElement(pick.el)) {
    deps.cursor.glow(pick.el.getBoundingClientRect(), 3200, true);
    return { ok: false, risky: true, detail: t("Hier wähle ich nicht selbst – ich zeige nur darauf."), route: deps.route() };
  }
  if (control.kind === "select") {
    await deps.cursor.press();
    control.el.focus({ preventScroll: true });
    setSelectValue(control.el, pick.value);
    deps.cursor.glow(c.rect, CLICK_FLASH_MS);
  } else if (pick.el) {
    const p = centerOf(pick.el);
    await deps.cursor.flyTo(p.x, p.y);
    if (!isChecked(pick.el)) {
      await deps.cursor.press();
      realClick(pick.el);
    }
    deps.cursor.glow(p.rect, CLICK_FLASH_MS);
  }
  return { ok: true, detail: t("„{label}“ gewählt.", { label: pick.label }), route: deps.route() };
}

export async function executeNyxUi(cmd: NyxUiCommand, deps: ExecDeps): Promise<ExecResult> {
  const root = deps.root ?? document;
  if (cmd.action === "navigate") return navigateByCursor(cmd, deps, root);
  if (cmd.action === "read_screen") return { ok: true, screen: readScreen(root, deps.route()) };

  await revealNav(cmd.target, root, deps);
  const wentHome = await openHomeOf(cmd.target, root, deps);
  const waitMs = deps.waitMs ?? (parseItemTarget(cmd.target) || wentHome ? ITEM_WAIT_MS : DEFAULT_WAIT_MS);
  const el = await waitFor(() => findNyxTarget(cmd.target, root), waitMs, root);
  if (!el) return { ok: false, detail: notFound(cmd.target), route: deps.route() };
  if (cmd.action === "click") return clickEl(el, deps);
  if (cmd.action === "select") return selectIn(el, cmd.target, cmd.option, deps, root);

  const risky = isRiskyElement(el);
  if (cmd.action !== "highlight") el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const c = centerOf(el);

  switch (cmd.action) {
    case "highlight":
      await deps.cursor.flyTo(c.x, c.y);
      deps.cursor.glow(c.rect, 2400, risky);
      return { ok: true, risky, route: deps.route() };
    case "focus":
      await deps.cursor.flyTo(c.x, c.y);
      el.focus();
      return { ok: true, route: deps.route() };
    case "scroll":
      el.scrollIntoView?.({ behavior: "smooth", block: "center" });
      await deps.cursor.flyTo(c.x, c.y);
      return { ok: true, route: deps.route() };
    case "type": {
      const field = el.matches("input,textarea,[contenteditable=true]") ? el : el.querySelector<HTMLElement>("input,textarea,[contenteditable=true]");
      if (!field) return { ok: false, detail: t("In „{target}“ kann man nicht tippen.", { target: cmd.target }), route: deps.route() };
      await deps.cursor.flyTo(c.x, c.y);
      if (risky) {
        // Riskantes Feld (in einem `data-nyx-risk`-Bereich, z. B. Entscheidungs-Karte): nur zeigen, du tippst selbst.
        deps.cursor.glow(c.rect, 3200, true);
        return { ok: false, risky: true, detail: t("Hier tippe ich nicht selbst – ich zeige nur darauf."), route: deps.route() };
      }
      if (document.activeElement !== field) {
        await deps.cursor.press();
        realClick(field);
      }
      field.focus();
      const text = cmd.text ?? "";
      const delay = deps.typeDelayMs ?? TYPE_DELAY_MS;
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        // Suchfelder ersetzt Nyx (sonst hinge der neue Begriff an einem alten), andere Felder schreibt er weiter.
        const replace = field instanceof HTMLInputElement && (field.type === "search" || field.getAttribute("data-nyx") === "suche");
        let value = replace ? "" : field.value;
        if (replace && field.value !== "") setNativeValue(field, "");
        for (const ch of text) {
          value += ch;
          setNativeValue(field, value);
          if (delay > 0) await sleep(delay);
        }
      } else {
        field.textContent = (field.textContent ?? "") + text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (cmd.submit) submitField(field);
      return { ok: true, route: deps.route() };
    }
  }
}
