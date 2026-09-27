// Live-Test Safari: Safari spielt Ton nur ab, wenn die Seite schon einmal auf einen Klick/Tastendruck hin
// Ton abgespielt hat, und hält Web-Audio-Kontexte bis zu so einer Geste an. Nyx spricht aber später von selbst
// (nach Denkpause, ohne Klick) – ohne Freischalten blieb er in Safari stumm, Pegel und Zuhören tot.
// Lösung: beim ERSTEN Klick/Tastendruck/Tippen einmal einen stillen Ton abspielen und alle Kontexte wecken.

/** 44 Byte stilles WAV (0 Samples). */
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

const contexts = new Set<AudioContext>();
let installed = false;
let unlocked = false;

/** Kontext merken, damit er bei der nächsten Geste geweckt wird (idempotent). */
export function registerAudioContext(ctx: AudioContext): void {
  contexts.add(ctx);
  if (unlocked) void ctx.resume().catch(() => {});
}

export function audioUnlocked(): boolean {
  return unlocked;
}

function unlock(): void {
  for (const ctx of contexts) {
    if (ctx.state === "closed") contexts.delete(ctx);
    else void ctx.resume().catch(() => {});
  }
  if (unlocked) return;
  try {
    const el = new Audio(SILENT_WAV);
    el.volume = 0;
    void el.play().then(
      () => {
        unlocked = true;
      },
      () => {},
    );
  } catch {
    // kein Audio-Element (Tests) – egal
  }
}

/** Einmal pro Seite: bei jeder Geste Kontexte wecken, bei der ersten zusätzlich die Wiedergabe freischalten. */
export function installAudioUnlock(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const ev of ["pointerdown", "keydown", "touchend"] as const) window.addEventListener(ev, unlock, { passive: true, capture: true });
}
