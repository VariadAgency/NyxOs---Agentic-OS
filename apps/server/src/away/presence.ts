// Abwesenheit: Ist der Nutzer gerade in NyxOS? Das Web schickt alle ~30 s einen Herzschlag, solange ein Fenster
// sichtbar ist UND er in den letzten ~2 Min Maus/Tastatur/Touch benutzt hat. Kommt länger keiner, gilt er als „weg“.
// Nur im Speicher: nach einem Neustart zählt der Start als „zuletzt gesehen“ – so meldet sich Nyx nicht direkt
// nach einem Deploy, sondern erst, wenn wirklich N Minuten lang kein Fenster aktiv war.

export class Presence {
  private lastSeen: number;
  private seenByHeartbeat = false;

  constructor(private readonly now: () => number = Date.now) {
    this.lastSeen = now();
  }

  /** Herzschlag aus einem aktiven NyxOS-Fenster. */
  beat(): void {
    this.lastSeen = this.now();
    this.seenByHeartbeat = true;
  }

  /** Zeitpunkt des letzten Herzschlags (null = seit dem Start noch keiner). */
  lastSeenAt(): number | null {
    return this.seenByHeartbeat ? this.lastSeen : null;
  }

  /** Weg = seit mehr als `awayAfterMs` kein Herzschlag. */
  isAway(awayAfterMs: number): boolean {
    return this.now() - this.lastSeen > awayAfterMs;
  }
}
