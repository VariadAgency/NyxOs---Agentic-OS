// Eingaben der 3D-Ansicht, als reine Funktionen: Was wurde gerade getan — Trackpad
// (zwei Finger), Kneifen oder Maus-Rad — und was soll die Kamera daraufhin tun?
//
// Vorher behandelte OrbitControls JEDES Rad-Ereignis als Zoom: unter macOS zoomte schon das normale
// Zwei-Finger-Wischen (statt zu drehen), seitliches Wischen tat gar nichts, und Kneifen wurde ×10
// verstärkt → ruckartige Sprünge. Hier wird zuerst die Quelle erkannt, dann gehandelt.

export type WheelKind = "trackpad" | "wheel" | "pinch";
export type Control = "orbit" | "fly";

/** Was an einem Rad-Ereignis zählt (echte `WheelEvent`s passen, Tests bauen sich eigene). */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Veraltete, aber in Chrome/Safari vorhandene Werte — verraten Trackpad vs. Rad. */
  wheelDeltaX?: number | undefined;
  wheelDeltaY?: number | undefined;
}

/** Gedächtnis über eine Geste hinweg (Trackpad-Nachschwingen soll nicht plötzlich als Rad gelten). */
export interface WheelMemory {
  kind: WheelKind | null;
  at: number;
}

/** Innerhalb dieser Pause gehört ein Ereignis noch zur selben Geste (ms). */
export const GESTURE_GAP_MS = 220;
const LINE_PX = 16;
const MAC_WHEEL_LINE_PX = 4.000244140625;
/** Größter Zoom-Schritt je Ereignis (|ln Faktor|) — große Rad-Werte springen nicht. */
export const MAX_ZOOM_STEP = 0.3;
/** Zoom je Pixel: Rad (grob, ~±100 je Raste) und Kneifen (fein, ~±1…10 je Ereignis). */
const WHEEL_ZOOM_PER_PX = 0.0022;
const PINCH_ZOOM_PER_PX = 0.012;
/** Drehen je Pixel Mausweg im leeren Raum (rad) und Umschauen im Flug-Modus. Vorher 0,0052 —
 * zu stark; danach für ruhigeres, langsameres Schwenken alle drei auf ~60 %. */
export const ROTATE_PER_PX = 0.0016;
export const LOOK_PER_PX = 0.0013;
/** Zwei Finger auf dem Trackpad: Drehen je (geglättetem) Pixel. */
export const TRACKPAD_ROTATE_PER_PX = 0.001;
/** Beschleunigungs-Kurve: unterhalb davon feiner (Faktor 0,55 → 1), oberhalb gedeckelt (weich, tanh). */
const ACCEL_KNEE_PX = 7;
const ACCEL_SLOW_GAIN = 0.55;
export const ACCEL_CAP_PX = 44;

export function normalizeWheel(e: Pick<WheelLike, "deltaX" | "deltaY" | "deltaMode">, pagePx: number): { dx: number; dy: number } {
  const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pagePx : 1;
  return { dx: e.deltaX * k, dy: e.deltaY * k };
}

/** Trackpad, Maus-Rad oder Kneifen? `now` in ms. */
export function classifyWheel(e: WheelLike, mem: WheelMemory, now: number): WheelKind {
  let kind: WheelKind;
  if (e.ctrlKey) kind = "pinch"; // Kneifen am Trackpad (Chrome/Firefox) bzw. Strg+Rad
  // Seitliches Wischen ohne Shift ist immer das Trackpad — auch mitten in einer Geste, die mit einem
  // runden Wert begann und deshalb als Rad galt (dann zoomte seitliches Wischen die Kamera).
  else if (e.deltaX !== 0 && !e.shiftKey && e.deltaMode === 0) kind = "trackpad";
  else if (mem.kind && mem.kind !== "pinch" && now - mem.at < GESTURE_GAP_MS) kind = mem.kind;
  else if (e.deltaMode !== 0) kind = "wheel"; // Firefox-Maus: Zeilen
  // Chrome/Firefox unter macOS liefern je Maus-Raste ein Vielfaches von 4,000244 px (bekannt aus maplibre).
  else if (e.deltaY !== 0 && e.deltaX === 0 && Math.abs(e.deltaY) % MAC_WHEEL_LINE_PX === 0) kind = "wheel";
  else if (e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 && e.deltaY !== 0) kind = e.wheelDeltaY === -3 * e.deltaY ? "trackpad" : "wheel";
  else if (e.wheelDeltaX !== undefined && e.wheelDeltaX !== 0 && e.deltaX !== 0) kind = e.wheelDeltaX === -3 * e.deltaX ? "trackpad" : "wheel";
  else if (e.deltaX !== 0 && !e.shiftKey) kind = "trackpad"; // Mäuse wischen nicht seitlich
  else kind = Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY) ? "wheel" : "trackpad";
  mem.kind = kind;
  mem.at = now;
  return kind;
}

/**
 * Beschleunigungs-Kurve für Trackpad-Wege (Betrag in px, ≥ 0): langsame, kleine Bewegungen fein
 * (präzises Umsehen), normale 1:1, große Ausreißer (Schwung-Ereignisse von macOS) weich gedeckelt —
 * so gibt es keine Sprünge. Stetig steigend.
 */
export function accelCurve(px: number): number {
  const a = Math.abs(px);
  if (a === 0) return 0;
  const k = Math.min(1, a / ACCEL_KNEE_PX);
  const gain = ACCEL_SLOW_GAIN + (1 - ACCEL_SLOW_GAIN) * k * k * (3 - 2 * k);
  return ACCEL_CAP_PX * Math.tanh((a * gain) / ACCEL_CAP_PX);
}

/**
 * Zwei-Finger-Wischen („Zieh“-Pixel) → Drehung (rad). Die Kurve wirkt auf die Länge des Wegs, nicht je
 * Achse: waagrecht und senkrecht gleich stark, die Richtung bleibt erhalten.
 */
export function trackpadRotation(dx: number, dy: number): { dTheta: number; dPhi: number } {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { dTheta: 0, dPhi: 0 };
  const k = (accelCurve(len) / len) * TRACKPAD_ROTATE_PER_PX;
  return { dTheta: -dx * k, dPhi: -dy * k };
}

export type WheelAction =
  | { type: "rotate"; dx: number; dy: number }
  | { type: "zoom"; factor: number }
  | { type: "look"; dx: number; dy: number }
  | { type: "move"; amount: number };

const clampStep = (x: number) => Math.max(-MAX_ZOOM_STEP, Math.min(MAX_ZOOM_STEP, x));

/**
 * Rad-Ereignis → Kamera-Aktion. dx/dy sind „Zieh“-Pixel: so, als hätte man mit der Maus in diese
 * Richtung gezogen (Finger nach rechts = Inhalt folgt nach rechts).
 */
export function wheelAction(kind: WheelKind, e: WheelLike, mode: Control, pagePx: number): WheelAction {
  const { dx, dy } = normalizeWheel(e, pagePx);
  // Ein rein waagrechtes Rad-Ereignis (ohne Shift) zoomt nie — es dreht wie das Trackpad.
  const sideways = kind === "wheel" && dy === 0 && dx !== 0 && !e.shiftKey;
  if (kind === "pinch" || (kind === "wheel" && !sideways) || (kind === "trackpad" && e.altKey)) {
    const per = kind === "pinch" ? PINCH_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX;
    // Rad mit Shift: Browser legen den Wert auf dx.
    const d = dy !== 0 ? dy : dx;
    const step = clampStep(d * per);
    if (mode === "fly") return { type: "move", amount: -step };
    return { type: "zoom", factor: Math.exp(step) };
  }
  if (mode === "fly") return { type: "look", dx: -dx, dy: -dy };
  // Mit zwei Fingern dreht sich nur die Gehirnkugel, nicht die eigene Perspektive:
  // zwei Finger drehen IMMER — auch mit Shift. Schwenken geht nur noch per Maus (rechts/Mitte/Shift-Ziehen).
  return { type: "rotate", dx: -dx, dy: -dy };
}

/** Ab diesem Vielfachen des Anflug-Abstands gilt die Kamera nicht mehr als „nah am Punkt“. */
export const FOCUS_PIVOT_FACTOR = 1.6;

/**
 * Um welchen Punkt dreht die Kugel? Immer um ihre Mitte — nur wer gerade nah an einem angeflogenen
 * Punkt ist, dreht um diesen Punkt (seine Nachbarn bleiben dann im Bild). Nie Verschieben.
 */
export function rotationPivot(o: { focused: boolean; camToFocus: number; focusDist: number }): "center" | "node" {
  return o.focused && o.camToFocus <= o.focusDist * FOCUS_PIVOT_FACTOR ? "node" : "center";
}

export type DragAction = "rotate" | "pan" | "look" | "node";

/**
 * Maus: links auf einem Knoten = den Knoten greifen und ziehen, links im leeren Raum drehen,
 * rechts/Mitte oder Shift+links schwenken; im Flug-Modus links im leeren Raum umschauen.
 */
export function pointerAction(button: number, shift: boolean, mode: Control, onNode = false): DragAction {
  if (button === 2 || button === 1 || shift) return "pan";
  if (onNode && button === 0) return "node";
  return mode === "fly" ? "look" : "rotate";
}

export const MOVE_KEYS = new Set(["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"]);
export type KeyAction = "fit" | "toggleFly" | "move" | "deselect" | "open";

export function keyAction(key: string): KeyAction | null {
  const k = key.toLowerCase();
  if (k === "f") return "fit";
  if (k === "v") return "toggleFly";
  if (k === "escape") return "deselect";
  if (k === "enter") return "open";
  return MOVE_KEYS.has(k) ? "move" : null;
}
