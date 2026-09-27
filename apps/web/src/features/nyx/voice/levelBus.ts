// EIN gemeinsamer Pegel für das Nyx-Logo (NyxAura). Wer gerade Ton aufnimmt oder abspielt (Halten in der
// Leiste, Dauer-Zuhören, Nyx-Tab, Diktat, Nyx' Stimme), meldet hier nur eine Lese-Funktion an – solange er aktiv ist.
// EINE requestAnimationFrame-Schleife für alle Logos liest den lautesten Pegel, glättet ihn (Anstieg ~40 ms,
// Abklingen ~250 ms) und schreibt ihn als CSS-Variable `--nyx-lvl` (0–1) direkt an jedes Logo – kein React-Rendern
// pro Bild. Dazu `--nyx-rot` (Grad): der Ring dreht umso schneller, je lauter es ist.
// Die Schleife läuft nur, solange eine Quelle angemeldet ist (oder der Pegel noch abklingt) UND ein Logo zu sehen ist;
// sonst übernimmt die ruhige CSS-Animation.
import { followEnvelope } from "../tab/voice/level";

/** Anstieg: nach so vielen ms sind 90 % des neuen Pegels erreicht. */
export const LEVEL_ATTACK_MS = 40;
/** Abklingen: nach so vielen ms ist der Pegel zu 90 % zurück. */
export const LEVEL_RELEASE_MS = 250;
/** Zusätzliche Drehung des Rings bei vollem Pegel (Grad pro Sekunde). */
const SPIN_DEG_PER_S = 140;
/** Unter diesem Wert gilt der Pegel als abgeklungen. */
const QUIET = 0.002;

type Reader = () => number;

const sources = new Set<{ read: Reader }>();
const targets = new Set<HTMLElement | SVGElement>();
let raf = 0;
let lastAt = 0;
let smooth = 0;
let rot = 0;

const hasRaf = () => typeof requestAnimationFrame === "function";

function write(el: HTMLElement | SVGElement) {
  el.style.setProperty("--nyx-lvl", smooth.toFixed(3));
  el.style.setProperty("--nyx-rot", rot.toFixed(1));
}

function schedule() {
  if (raf || !hasRaf() || targets.size === 0) return;
  if (sources.size === 0 && smooth <= QUIET) return;
  raf = requestAnimationFrame(nyxLevelFrame);
}

/**
 * Ein Bild der gemeinsamen Schleife (exportiert für Tests). Liest alle Quellen, glättet, schreibt an alle Logos
 * und plant das nächste Bild nur, solange noch etwas zu tun ist.
 */
export function nyxLevelFrame(now: number): void {
  raf = 0;
  const dt = lastAt ? Math.min(100, Math.max(0, now - lastAt)) : 16;
  lastAt = now;
  let raw = 0;
  for (const s of sources) {
    try {
      const v = s.read();
      if (Number.isFinite(v) && v > raw) raw = v;
    } catch {
      // Eine kaputte Quelle darf das Logo nicht anhalten.
    }
  }
  raw = Math.min(1, raw);
  smooth = followEnvelope(smooth, raw, raw > smooth ? LEVEL_ATTACK_MS : LEVEL_RELEASE_MS, dt);
  rot = (rot + (smooth * SPIN_DEG_PER_S * dt) / 1000) % 360;
  if (sources.size === 0 && smooth <= QUIET) {
    smooth = 0;
    lastAt = 0;
  }
  for (const el of targets) write(el);
  schedule();
}

/**
 * Pegel melden, solange Ton läuft. `read` wird pro Bild gerufen (0–1). Rückgabe: abmelden.
 * Beispiel: `useEffect(() => (recording ? reportNyxLevel(level) : undefined), [recording, level])`.
 */
export function reportNyxLevel(read: Reader): () => void {
  const entry = { read };
  sources.add(entry);
  schedule();
  return () => {
    sources.delete(entry);
    schedule();
  };
}

/** Ein Logo empfängt ab jetzt `--nyx-lvl`/`--nyx-rot`. Rückgabe: abmelden. */
export function attachNyxLevel(el: HTMLElement | SVGElement): () => void {
  targets.add(el);
  write(el);
  schedule();
  return () => {
    targets.delete(el);
    if (targets.size === 0 && raf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(raf);
      raf = 0;
      lastAt = 0;
    }
  };
}

/** Für Tests: aktueller geglätteter Pegel und ob die Schleife läuft. */
export function nyxLevelSnapshot(): { level: number; running: boolean; sources: number; targets: number } {
  return { level: smooth, running: raf !== 0, sources: sources.size, targets: targets.size };
}
