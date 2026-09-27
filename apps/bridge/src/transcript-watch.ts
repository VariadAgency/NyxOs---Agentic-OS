// Datei-Wächter für die Verlaufsquellen (`~/.claude/projects`, `~/.codex/sessions`, `~/.codex/session_index.jsonl`),
// die es beim Start der Brücke noch NICHT geben muss. Typischer Fall: NyxOS wird vor Claude Code/Codex
// installiert — chokidar beobachtet einen fehlenden Pfad nie, die Brücke sähe neue Sessions erst nach einem Neustart.
//
// Ablauf je Quelle:
// - vorhanden → chokidar darauf (wie bisher), `ready` abwarten;
// - fehlt → nur den nächsten VORHANDENEN Elternordner beobachten (`fs.watch`, nicht rekursiv, kein Baum-Polling).
//   Entsteht der Pfad (auch in mehreren Stufen, `mkdir -p`), hängt sich chokidar an und `onAppeared` liest einmal
//   alles nach, was schon darin liegt (Dateien, die zwischen `mkdir` und dem Wächter entstanden sind);
// - verschwindet eine beobachtete Quelle, geht sie zurück in den Wartezustand.
// Sicherheitsnetz: ein billiger Takt (ein paar `stat`-Aufrufe), falls ein Ordner-Ereignis verloren geht.
import { existsSync, watch as fsWatch, type FSWatcher as FsWatcher } from "node:fs";
import { dirname, sep } from "node:path";
import { watch as chokidarWatch, type ChokidarOptions, type FSWatcher } from "chokidar";
import type { Log } from "./tracker.js";

/** Takt des Sicherheitsnetzes (nur Existenz-Prüfungen der wenigen Quellpfade). */
export const PRESENCE_CHECK_MS = 10_000;
/** Mehrere Ordner-Ereignisse kurz hintereinander (z. B. `mkdir -p`) ergeben eine Prüfung. */
const SETTLE_MS = 50;

export interface TranscriptWatchOptions {
  /** Beobachtete Quellen (Ordner oder Dateien). */
  targets: string[];
  /** Optionen für chokidar (wie bisher: `ignoreInitial`, `ignored`, `depth`). */
  chokidar: ChokidarOptions;
  /** Neue oder geänderte Datei unter einer Quelle. */
  onPath: (path: string) => void;
  /** Quelle ist nach dem Start entstanden, der Wächter steht: alles darin einmal einlesen. */
  onAppeared: (target: string) => Promise<unknown>;
  log: Log;
  checkMs?: number;
}

interface Slot {
  target: string;
  watcher: FSWatcher | null;
  /** Wartender Wächter auf dem nächsten vorhandenen Elternordner. */
  parent: { dir: string; w: FsWatcher } | null;
  settle: NodeJS.Timeout | null;
  /** Serialisiert Anhängen/Lösen je Quelle. */
  queue: Promise<void>;
}

export class TranscriptWatch {
  private readonly slots: Slot[];
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly opts: TranscriptWatchOptions) {
    this.slots = opts.targets.map((target) => ({ target, watcher: null, parent: null, settle: null, queue: Promise.resolve() }));
  }

  /** Hängt sich an alle vorhandenen Quellen (erfüllt, sobald deren Wächter bereit sind) und wartet auf die übrigen. */
  async start(): Promise<void> {
    await Promise.all(this.slots.map((s) => this.run(s, () => this.sync(s, false))));
    if (this.closed) return;
    this.timer = setInterval(() => {
      for (const s of this.slots) this.check(s);
    }, this.opts.checkMs ?? PRESENCE_CHECK_MS);
    this.timer.unref?.();
  }

  /** Beobachtete Quellen (für Tests/Status). */
  watching(): string[] {
    return this.slots.filter((s) => s.watcher).map((s) => s.target);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const s of this.slots) {
      if (s.settle) clearTimeout(s.settle);
      this.dropParent(s);
    }
    await Promise.all(this.slots.map((s) => s.queue));
    await Promise.all(this.slots.map((s) => s.watcher?.close()));
  }

  private run(s: Slot, fn: () => Promise<void>): Promise<void> {
    s.queue = s.queue.then(fn).catch((e: unknown) => this.opts.log("verlauf-waechter-fehler", { pfad: s.target, error: String(e) }));
    return s.queue;
  }

  /** Nach einem Ordner-Ereignis: kurz sammeln, dann einmal prüfen. */
  private check(s: Slot): void {
    if (this.closed || s.settle) return;
    s.settle = setTimeout(() => {
      s.settle = null;
      void this.run(s, () => this.sync(s, true));
    }, SETTLE_MS);
  }

  /** Bringt den Wächter einer Quelle in Einklang mit dem Dateisystem. */
  private async sync(s: Slot, appeared: boolean): Promise<void> {
    if (this.closed) return;
    const present = existsSync(s.target);
    if (present && !s.watcher) {
      this.dropParent(s);
      const w = chokidarWatch(s.target, this.opts.chokidar);
      s.watcher = w;
      w.on("add", this.opts.onPath).on("change", this.opts.onPath);
      // Die Quelle selbst (oder ein Elternordner) wurde gelöscht → prüfen, ob sie zurück in den Wartezustand muss.
      w.on("unlinkDir", (p: string) => (s.target === p || s.target.startsWith(p + sep) ? this.check(s) : undefined));
      w.on("unlink", (p: string) => (p === s.target ? this.check(s) : undefined));
      w.on("error", (e: unknown) => this.opts.log("verlauf-waechter-fehler", { pfad: s.target, error: String(e) }));
      await new Promise<void>((r) => w.once("ready", () => r()));
      if (this.closed) return;
      if (appeared) {
        this.opts.log("verlauf-quelle-neu", { pfad: s.target });
        await this.opts.onAppeared(s.target);
      }
      return;
    }
    if (!present && s.watcher) {
      const w = s.watcher;
      s.watcher = null;
      await w.close();
      this.opts.log("verlauf-quelle-weg", { pfad: s.target });
    }
    if (!present) this.waitFor(s);
  }

  /** Beobachtet den nächsten vorhandenen Elternordner der fehlenden Quelle (neu, wenn er sich geändert hat). */
  private waitFor(s: Slot): void {
    let dir = dirname(s.target);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    if (s.parent?.dir === dir) return;
    this.dropParent(s);
    try {
      const w = fsWatch(dir, { persistent: false }, () => this.check(s));
      // Elternordner selbst gelöscht o. ä.: der Takt findet den nächsten.
      w.on("error", () => {
        if (s.parent?.w === w) this.dropParent(s);
      });
      s.parent = { dir, w };
    } catch (e) {
      // Nicht lesbar/nicht beobachtbar: dann bleibt es beim Takt.
      this.opts.log("verlauf-waechter-fehler", { pfad: dir, error: String(e) });
    }
  }

  private dropParent(s: Slot): void {
    s.parent?.w.close();
    s.parent = null;
  }
}
