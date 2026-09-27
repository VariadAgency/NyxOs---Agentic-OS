// Schwere Arbeit in Scheiben: Die Brücke hat nur EINE Ereignisschleife — für Pong, Tunnel-Prüfung,
// Terminal-Tasten und Nachimport zugleich. Wer länger rechnet, gibt nach `SLICE_MS` kurz ab.

/** So lange darf ein Stück Arbeit am Stück laufen, bevor es die Schleife freigibt. */
export const SLICE_MS = 8;

/** Gibt die Ereignisschleife einmal frei (Timer, Netz, Signale kommen dran). */
export const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

export class Slicer {
  private start = performance.now();

  constructor(private readonly budgetMs = SLICE_MS) {}

  /** true, sobald die laufende Scheibe ihr Zeitbudget aufgebraucht hat. Billig — in engen Schleifen aufrufen. */
  due(): boolean {
    return performance.now() - this.start >= this.budgetMs;
  }

  /** Schleife freigeben und eine neue Scheibe beginnen. */
  async yield(): Promise<void> {
    await yieldNow();
    this.start = performance.now();
  }
}
