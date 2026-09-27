/** Verteilt Änderungen an alle offenen `/live`-Verbindungen. */
export interface LiveClient {
  send(data: string): void;
}

export class LiveHub {
  private readonly clients = new Set<LiveClient>();

  add(c: LiveClient): void {
    this.clients.add(c);
  }

  remove(c: LiveClient): void {
    this.clients.delete(c);
  }

  get size(): number {
    return this.clients.size;
  }

  /** Herzschlag `{type:"ping"}`, damit Browser eine still gestorbene Verbindung erkennen und neu
   * verbinden (sonst kommen Nyx-Befehle nie an). Nur solange jemand verbunden ist; hält den Prozess nicht wach. */
  heartbeat(ms: number): () => void {
    const t = setInterval(() => {
      if (this.clients.size > 0) this.broadcast({ type: "ping" });
    }, ms);
    t.unref?.();
    return () => clearInterval(t);
  }

  broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const c of this.clients) {
      try {
        c.send(data);
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
