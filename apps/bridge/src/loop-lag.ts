// Wie lange wartet ein Timer der Brücke über seine Zeit hinaus? Blockiert etwas die Ereignisschleife
// (oder bekommt der Prozess vom Mac keine Rechenzeit), steigt dieser Wert. Ab 1 s steht es im Log
// (`eventloop-lag`), das Maximum geht in den Status — so ist ein Ausfall unter Last künftig belegt.
import type { Log } from "./tracker.js";

export const LAG_WARN_MS = 1000;
const INTERVAL_MS = 500;

export class LoopLagMonitor {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private windowMax = 0;
  /** Größte gemessene Verzögerung seit dem Start (ms). */
  maxLagMs = 0;

  constructor(
    private readonly log: Log,
    private readonly o: { intervalMs?: number; warnMs?: number } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const every = this.o.intervalMs ?? INTERVAL_MS;
    this.last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - this.last - every);
      this.last = now;
      this.windowMax = Math.max(this.windowMax, lag);
      this.maxLagMs = Math.max(this.maxLagMs, lag);
      if (lag >= (this.o.warnMs ?? LAG_WARN_MS)) this.log("eventloop-lag", { ms: Math.round(lag) });
    }, every);
    this.timer.unref?.();
  }

  /** Größte Verzögerung seit dem letzten Abruf (für den Status alle 5 s), danach wieder 0. */
  takeMax(): number {
    const v = this.windowMax;
    this.windowMax = 0;
    return Math.round(v);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
