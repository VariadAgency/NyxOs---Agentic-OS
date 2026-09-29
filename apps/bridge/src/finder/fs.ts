// Finder-Dienst der Brücke — Ordner lesen, Dateien in Blöcken lesen, Vorschaubilder, Suche und
// Markdown speichern. Aufgerufen über den RPC `finder` (terminal/manager.ts), Vertrag in shared/finder.ts.
//
// Sicherheit (die Brücke ist die letzte Instanz, der Server prüft nur zusätzlich):
// - Nur Wurzeln aus FINDER_ROOTS; Pfade relativ, ohne `..`; jeder Pfad wird per realpath aufgelöst und muss
//   unter dem realpath der Wurzel liegen — ein Link nach draußen ist damit genauso gesperrt wie `../`.
// - Zugangsdaten-Dateien (.env, Schlüssel …) werden nie gelesen.
// - Schreiben nur: Wurzel beschreibbar, bestehende .md/.txt-Datei, kein verstecktes Segment (auch nicht
//   nach Auflösung von Links), Prüfsumme wie beim Laden (sonst Konflikt), vorher Sicherungskopie
//   außerhalb des Repos, dann atomar (Zwischendatei + rename, Rechte bleiben).
import { execFile } from "node:child_process";
import { constants as fsc } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, lstat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  FINDER_CHUNK_BYTES,
  FINDER_ERR,
  FINDER_LIST_MAX,
  FINDER_ROOTS,
  FINDER_SEARCH_MAX,
  FINDER_TEXT_MAX_BYTES,
  FinderRequestSchema,
  finderKindOf,
  finderPermissionText,
  finderRelHidden,
  finderRelOk,
  finderSecretName,
  finderSecretPath,
  finderWritableName,
  type FinderCountsResult,
  type FinderEntry,
  type FinderListResult,
  type FinderReadResult,
  type FinderRootId,
  type FinderRootInfo,
  type FinderSearchResult,
  type FinderStatResult,
  type FinderThumbResult,
  type FinderWriteResult,
  t,
} from "@nyxos/shared";
import { findBin } from "../platform.js";

const run = promisify(execFile);

export class FinderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface FinderFsOptions {
  /** Projektordner; der erste ist die Wurzel der Projekt-Favoriten (ohne Ordner: das Home-Verzeichnis). */
  projectRoots: readonly string[];
  /** Obsidian-Vault (für einen Vault-Favoriten); `null` = keiner. */
  vaultDir?: string | null;
  home: string;
  /** Ablageort für Bildschirmfotos (Systemeinstellung); `null` = Schreibtisch. */
  screenshotsDir: string | null;
  /** Sicherungskopien vor dem Speichern (außerhalb aller Repos). */
  backupsDir: string;
  now?: () => Date;
  /** `sips` (macOS) für Vorschaubilder; austauschbar für Tests. */
  sipsBin?: string;
  /** Linux: ImageMagick (`magick` oder `convert`) für Vorschaubilder; `null` = keins. Standard: im PATH suchen. */
  imageMagickBin?: string | null;
  /** Tests: Betriebssystem vorgeben. */
  platform?: NodeJS.Platform;
  /** Nur Tests: wird vor jedem Eintrags-`lstat` beim Auflisten abgewartet (simuliert eine kalte Platte). */
  onStat?: () => Promise<void>;
  /** Uhr für den Listen-Zwischenspeicher (ms); austauschbar für Tests. */
  nowMs?: () => number;
  /**
   * So lange darf das erste Lesen einer Wurzel dauern, dann antwortet die Brücke mit
   * `macos_freigabe_offen` (Standard 6 s). Das Lesen selbst läuft weiter.
   */
  firstAccessTimeoutMs?: number;
  /** Nur Tests: ersetzt das erste Lesen einer Wurzel (simuliert den offenen macOS-Dialog). */
  probeDir?: (abs: string) => Promise<unknown>;
  /** Brücken-Log (Ereignis + Daten), z. B. wenn macOS nach der Freigabe fragt. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Ordner, die die Suche nie betritt (groß, erzeugt oder intern). */
const SEARCH_SKIP = new Set(["node_modules", ".git", ".build", "DerivedData", "Pods", ".next", ".turbo", ".cache", ".Trash"]);
const SEARCH_MAX_VISITED = 60_000;
const SEARCH_BUDGET_MS = 4_000;
/**
 * Kinder gleich beim Auflisten nur zählen, wenn der Ordner höchstens so viele Unterordner hat.
 * Sonst kommt die Liste ohne Zahlen (`childrenPending`) und die Oberfläche lädt sie über `counts` nach.
 */
const COUNT_CHILDREN_INLINE_DIRS = 32;
/** Höchstens so viele Unterordner zählt `counts` (danach bleibt es bei „–“). */
const COUNT_CHILDREN_MAX_DIRS = 2_000;
/**
 * So viele Datei-Abfragen gleichzeitig. Vorher lief jede einzeln nacheinander — bei kalter
 * Platte (erstes Öffnen von ~/Downloads, 1.752 Einträge) summierte sich das über 20 s. Gleichzeitig, aber
 * gedeckelt, damit ein riesiger Ordner den Rechner nicht flutet.
 */
const STAT_PARALLEL = 32;
/**
 * (~/Downloads stand beim ersten Öffnen erst nach Sekunden): eine fertige Ordner-Liste bleibt so lange
 * gültig, solange sich der Ordner selbst nicht ändert (mtime) — kurz, damit wachsende Downloads nicht lange
 * mit alter Größe stehen. Gleichzeitige Anfragen für denselben Ordner teilen sich eine Runde.
 */
const LIST_CACHE_MS = 15_000;
const LIST_CACHE_MAX = 24;
/** Diese Favoriten liest die Brücke einmal vorab, sobald die Oberfläche die Favoriten abfragt (groß, oft kalt). */
const PREWARM_ROOTS: readonly FinderRootId[] = ["downloads"];
/**
 * Nach einem Update fragt macOS erneut, ob die Brücke ~/Downloads lesen darf. Bis der Nutzer
 * antwortet, hängt jedes Lesen dort — der Server wartete 20 s und gab 504. Darum: je Wurzel höchstens EIN erstes
 * Lesen gleichzeitig, und nach dieser Zeit sagt die Brücke klar, dass macOS fragt.
 */
const FIRST_ACCESS_TIMEOUT_MS = 6_000;
const THUMB_CACHE_MAX = 300;
/** Obergrenze des Vorschau-Speichers (Base64-Zeichen), sonst bis zu 300 × 4 MB im Brücken-Prozess. */
const THUMB_CACHE_MAX_CHARS = 48 * 1024 * 1024;
/** Höchstens so viele Vorschaubild-Prozesse (`sips`/ImageMagick) gleichzeitig — die Galerie fragt Dutzende Bilder auf einmal an (Rechner-Last). */
const THUMB_PARALLEL = 2;
/** Ohne `sips` (oder wenn es scheitert) geht ein kleines Bild direkt raus. */
const THUMB_FALLBACK_MAX_BYTES = 3 * 1024 * 1024;
const THUMB_DIRECT_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;

/** `fn` für alle Elemente, höchstens `limit` gleichzeitig; Ergebnis in derselben Reihenfolge. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function countChildren(abs: string): Promise<number | null> {
  try {
    return (await readdir(abs)).filter((n) => n !== ".DS_Store").length;
  } catch {
    return null;
  }
}

function under(real: string, root: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

interface Resolved {
  rootId: FinderRootId;
  rootReal: string;
  /** Realer Pfad des Ziels. */
  real: string;
  rel: string;
}

export class FinderFs {
  private readonly thumbs = new Map<string, FinderThumbResult>();
  /** Fertige Listen je realem Ordner (+ mtime des Ordners) und laufende Runden. */
  private readonly lists = new Map<string, { dirMtimeMs: number; at: number; result: FinderListResult }>();
  private readonly listsRunning = new Map<string, Promise<FinderListResult>>();
  /**
   * Erstes Lesen je Wurzel (realpath + readdir). Läuft höchstens einmal gleichzeitig; ist es einmal
   * geglückt, gilt die Wurzel für diesen Prozess als frei. `warm`: Ordner, die nach dem späten Erfolg im
   * Hintergrund gelistet werden (füllt den Zwischenspeicher, damit der nächste Neuversuch sofort da ist).
   */
  private readonly rootAccess = new Map<FinderRootId, { ok: boolean; since: number; probe: Promise<void>; warm: Set<string>; told: boolean }>();
  private thumbChars = 0;
  private thumbRunning = 0;
  private readonly thumbWaiting: (() => void)[] = [];
  private screenshotsDir: string | null;

  constructor(private readonly o: FinderFsOptions) {
    this.screenshotsDir = o.screenshotsDir;
  }

  /** Der Ablageort der Bildschirmfotos kommt beim Start etwas später (`defaults read`). */
  setScreenshotsDir(dir: string | null): void {
    this.screenshotsDir = dir;
  }

  /** Einstieg für den RPC: prüft die Anfrage und verteilt. Wirft `FinderError` mit Code. */
  async handle(params: unknown): Promise<unknown> {
    const parsed = FinderRequestSchema.safeParse(params);
    if (!parsed.success) throw new FinderError(t("Dieser Pfad ist hier nicht erlaubt."), FINDER_ERR.badPath);
    const req = parsed.data;
    switch (req.op) {
      case "roots":
        return this.roots();
      case "list":
        return this.list(req.root, req.rel);
      case "stat":
        return this.stat(req.root, req.rel);
      case "counts":
        return this.counts(req.root, req.rel);
      case "read":
        return this.read(req.root, req.rel, req.offset, req.length);
      case "thumb":
        return this.thumb(req.root, req.rel, req.size);
      case "search":
        return this.search(req.root, req.rel, req.q);
      case "write":
        return this.write(req.root, req.rel, req.content, req.baseSha256);
    }
  }

  rootAbs(id: FinderRootId): string {
    const def = FINDER_ROOTS.find((r) => r.id === id);
    if (!def) throw new FinderError(t("Unbekannter Ort."), FINDER_ERR.badPath);
    const base: string = def.base;
    const project = this.o.projectRoots[0] ?? this.o.home;
    // Ein Vault-Favorit zeigt auf den eingestellten Vault (ohne Vault: unter dem Projektordner).
    if (base === "vault" && this.o.vaultDir) return this.o.vaultDir;
    if (base === "project" || base === "vault") return def.rel ? join(project, ...def.rel.split("/")) : project;
    if (base === "home") return join(this.o.home, ...def.rel.split("/"));
    return this.screenshotsDir ?? join(this.o.home, "Desktop");
  }

  private writableRoot(id: FinderRootId): boolean {
    return FINDER_ROOTS.find((r) => r.id === id)?.writable ?? false;
  }

  /**
   * Große Favoriten einmal im Hintergrund lesen, kurz nach dem Start der Brücke. Der erste
   * Zugriff eines frisch gestarteten Brücken-Prozesses auf ~/Downloads ist teuer (kalte Platte, erste
   * Rechte-Prüfung des neuen Programms durch macOS) — nach einem Brücken-Update gemessen: erste Liste
   * 6,8 s, zweite 0,3 s. Das zahlt jetzt die Brücke vorab, nicht der Nutzer beim Klick. Liefert die Anzahl Einträge.
   */
  async prewarm(): Promise<number> {
    let n = 0;
    for (const id of PREWARM_ROOTS) {
      try {
        n += (await this.list(id, "")).entries.length;
      } catch {
        // still: der Ordner fehlt oder ist gesperrt — beim echten Öffnen kommt die Meldung
      }
    }
    return n;
  }

  async roots(): Promise<FinderRootInfo[]> {
    // Große Favoriten schon einmal lesen, während die Oberfläche noch aufbaut (Fehler still).
    for (const id of PREWARM_ROOTS) void this.list(id, "").catch(() => undefined);
    return Promise.all(
      FINDER_ROOTS.map(async (r) => {
        const abs = this.rootAbs(r.id);
        let exists: boolean;
        try {
          exists = (await stat(abs)).isDirectory();
        } catch {
          exists = false;
        }
        return { id: r.id, label: r.label, icon: r.icon, abs, exists, writable: r.writable };
      }),
    );
  }

  /**
   * Wartet auf das erste Lesen der Wurzel, aber höchstens `firstAccessTimeoutMs` ab dessen Beginn.
   * Läuft die Zeit ab, kommt sofort `macos_freigabe_offen`; das Lesen läuft weiter (ein Faden im Hintergrund,
   * kein zweiter). Scheitert das erste Lesen (gesperrt, fehlt), meldet die eigentliche Aktion ihren Fehler.
   */
  private async firstAccess(rootId: FinderRootId, warmRel: string | null): Promise<void> {
    let a = this.rootAccess.get(rootId);
    if (a?.ok) return;
    if (!a) {
      const abs = this.rootAbs(rootId);
      const probeDir = this.o.probeDir ?? readdir;
      const entry = { ok: false, since: performance.now(), probe: realpath(abs).then(async (real) => void (await probeDir(real))), warm: new Set<string>(), told: false };
      this.rootAccess.set(rootId, entry);
      entry.probe.then(
        () => {
          entry.ok = true;
          if (entry.told) this.o.log?.("finder-freigabe-da", { root: rootId, ms: Math.round(performance.now() - entry.since) });
          for (const rel of entry.warm) void this.list(rootId, rel).catch(() => undefined);
          entry.warm.clear();
        },
        () => {
          if (this.rootAccess.get(rootId) === entry) this.rootAccess.delete(rootId);
        },
      );
      a = entry;
    }
    const left = a.since + (this.o.firstAccessTimeoutMs ?? FIRST_ACCESS_TIMEOUT_MS) - performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      a.probe.then(
        () => "done" as const,
        () => "done" as const,
      ),
      new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), Math.max(0, left));
      }),
    ]);
    clearTimeout(timer);
    if (outcome === "done") return;
    // Nur macOS fragt per Dialog nach Ordner-Rechten; anderswo ist ein langsames erstes Lesen nur langsam.
    if ((this.o.platform ?? process.platform) !== "darwin") {
      await a.probe.catch(() => undefined);
      return;
    }
    if (warmRel !== null) a.warm.add(warmRel);
    if (!a.told) {
      a.told = true;
      this.o.log?.("finder-macos-fragt", { root: rootId, ms: Math.round(performance.now() - a.since) });
    }
    const label = FINDER_ROOTS.find((r) => r.id === rootId)?.label ?? rootId;
    throw new FinderError(finderPermissionText(label), FINDER_ERR.macosPermission);
  }

  private async resolve(rootId: FinderRootId, rel: string, warmOnLate = false): Promise<Resolved> {
    if (!FINDER_ROOTS.some((r) => r.id === rootId) || !finderRelOk(rel)) throw new FinderError(t("Dieser Pfad ist hier nicht erlaubt."), FINDER_ERR.badPath);
    await this.firstAccess(rootId, warmOnLate ? rel : null);
    let rootReal: string;
    try {
      rootReal = await realpath(this.rootAbs(rootId));
    } catch {
      throw new FinderError(t("Diesen Ort gibt es auf diesem Rechner gerade nicht."), FINDER_ERR.notFound);
    }
    const target = rel ? join(rootReal, ...rel.split("/")) : rootReal;
    let real: string;
    try {
      real = await realpath(target);
    } catch (e) {
      if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") throw new FinderError(t("Diese Datei gibt es nicht mehr."), FINDER_ERR.notFound);
      throw new FinderError(t("Auf diese Datei darf die Brücke nicht zugreifen."), FINDER_ERR.badPath);
    }
    if (!under(real, rootReal)) throw new FinderError(t("Dieser Pfad ist hier nicht erlaubt."), FINDER_ERR.badPath);
    return { rootId, rootReal, real, rel };
  }

  /** Eintrag zu einem (schon geprüften) Pfad; `null`, wenn ein Link aus der Wurzel hinaus zeigt. */
  private async entryFor(abs: string, rel: string, rootReal: string, withChildren: boolean): Promise<FinderEntry | null> {
    const name = basename(abs);
    let st = await lstat(abs);
    const link = st.isSymbolicLink();
    if (link) {
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        return null; // kaputter Link
      }
      if (!under(real, rootReal)) return null;
      st = await stat(real);
    }
    const isDir = st.isDirectory();
    const children = isDir && withChildren ? await countChildren(abs) : null;
    return {
      name,
      rel,
      kind: finderKindOf(name, isDir),
      isDir,
      size: isDir ? 0 : st.size,
      mtimeMs: Math.round(st.mtimeMs),
      children,
      hidden: name.startsWith("."),
      secret: !isDir && (finderSecretPath(rel) || (link && finderSecretName(basename(await realpath(abs))))),
      link,
    };
  }

  async list(rootId: FinderRootId, rel: string): Promise<FinderListResult> {
    const r = await this.resolve(rootId, rel, true);
    const key = `${rootId}|${rel}|${r.real}`;
    const now = (this.o.nowMs ?? Date.now)();
    let dirMtimeMs: number;
    try {
      dirMtimeMs = (await stat(r.real)).mtimeMs;
    } catch {
      throw new FinderError(t("Dieser Ordner lässt sich gerade nicht lesen."), FINDER_ERR.badPath);
    }
    const hit = this.lists.get(key);
    if (hit && hit.dirMtimeMs === dirMtimeMs && now - hit.at < LIST_CACHE_MS) return structuredClone(hit.result);
    const running = this.listsRunning.get(key);
    if (running) return structuredClone(await running);
    const job = this.listFresh(r, rootId, rel).then((result) => {
      this.lists.delete(key);
      this.lists.set(key, { dirMtimeMs, at: now, result });
      while (this.lists.size > LIST_CACHE_MAX) {
        const first = this.lists.keys().next().value;
        if (first === undefined) break;
        this.lists.delete(first);
      }
      return result;
    });
    this.listsRunning.set(key, job);
    try {
      return structuredClone(await job);
    } finally {
      this.listsRunning.delete(key);
    }
  }

  private async listFresh(r: Resolved, rootId: FinderRootId, rel: string): Promise<FinderListResult> {
    let names: string[];
    try {
      names = (await readdir(r.real)).filter((n) => n !== ".DS_Store");
    } catch (e) {
      if (errno(e) === "ENOTDIR") throw new FinderError(t("Das ist eine Datei, kein Ordner."), FINDER_ERR.notAFile);
      throw new FinderError(t("Dieser Ordner lässt sich gerade nicht lesen."), FINDER_ERR.badPath);
    }
    const truncated = names.length > FINDER_LIST_MAX;
    // Erst schnell: Name, Art, Größe, Datum — alle Einträge gleichzeitig (gedeckelt), ohne in Unterordner zu schauen.
    const listed = await mapLimit(names.slice(0, FINDER_LIST_MAX), STAT_PARALLEL, async (name) => {
      try {
        await this.o.onStat?.();
        return await this.entryFor(join(r.real, name), rel ? `${rel}/${name}` : name, r.rootReal, false);
      } catch {
        return null; // verschwunden oder nicht lesbar: einfach auslassen
      }
    });
    const entries = listed.filter((e): e is FinderEntry => e !== null);
    const dirs = entries.filter((e) => e.isDir);
    const childrenPending = dirs.length > COUNT_CHILDREN_INLINE_DIRS;
    if (!childrenPending) {
      await mapLimit(dirs, STAT_PARALLEL, async (e) => {
        e.children = await countChildren(join(r.real, e.name));
      });
    }
    return { root: rootId, rel, entries, truncated, writable: this.writableRoot(rootId) && !finderRelHidden(rel), childrenPending };
  }

  /** Kinderzahlen der Unterordner, nachgeladen nach einer Liste mit `childrenPending`. */
  async counts(rootId: FinderRootId, rel: string): Promise<FinderCountsResult> {
    const r = await this.resolve(rootId, rel);
    let items;
    try {
      items = await readdir(r.real, { withFileTypes: true });
    } catch (e) {
      if (errno(e) === "ENOTDIR") throw new FinderError(t("Das ist eine Datei, kein Ordner."), FINDER_ERR.notAFile);
      throw new FinderError(t("Dieser Ordner lässt sich gerade nicht lesen."), FINDER_ERR.badPath);
    }
    // Gleiche Regeln wie `list` — ein Link auf einen Ordner zählt mit, aber nur, wenn er innerhalb
    // der Wurzel landet (sonst bleibt er draußen, wie in der Liste). Ein kaputter Link fällt still heraus.
    const dirs = items.filter((it) => it.isDirectory() || it.isSymbolicLink()).slice(0, COUNT_CHILDREN_MAX_DIRS);
    const counted = await mapLimit(dirs, STAT_PARALLEL, async (it): Promise<readonly [string, number | null] | null> => {
      const abs = join(r.real, it.name);
      if (it.isSymbolicLink()) {
        try {
          const real = await realpath(abs);
          if (!under(real, r.rootReal) || !(await stat(real)).isDirectory()) return null;
        } catch {
          return null;
        }
      }
      return [it.name, await countChildren(abs)] as const;
    });
    return { root: rootId, rel, counts: Object.fromEntries(counted.filter((x): x is readonly [string, number | null] => x !== null)) };
  }

  async stat(rootId: FinderRootId, rel: string): Promise<FinderStatResult> {
    const r = await this.resolve(rootId, rel);
    const entry = await this.entryFor(r.real, rel, r.rootReal, true);
    if (!entry) throw new FinderError(t("Dieser Pfad ist hier nicht erlaubt."), FINDER_ERR.badPath);
    return { root: rootId, entry, writable: !entry.isDir && this.canWrite(rootId, rel, relative(r.rootReal, r.real)) };
  }

  private canWrite(rootId: FinderRootId, rel: string, realRel: string): boolean {
    return this.writableRoot(rootId) && !finderRelHidden(rel) && !finderRelHidden(realRel.split(sep).join("/")) && finderWritableName(basename(rel));
  }

  private async fileOf(rootId: FinderRootId, rel: string): Promise<{ r: Resolved; size: number; mtimeMs: number }> {
    const r = await this.resolve(rootId, rel);
    const st = await stat(r.real);
    if (!st.isFile()) throw new FinderError(t("Das ist ein Ordner, keine Datei."), FINDER_ERR.notAFile);
    if (finderSecretPath(rel) || finderSecretPath(relative(r.rootReal, r.real).split(sep).join("/"))) throw new FinderError(t("Diese Datei enthält vermutlich Zugangsdaten und wird hier nicht geöffnet."), FINDER_ERR.secret);
    return { r, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  }

  async read(rootId: FinderRootId, rel: string, offset: number, length: number): Promise<FinderReadResult> {
    const { r, size, mtimeMs } = await this.fileOf(rootId, rel);
    const want = Math.max(0, Math.min(length, FINDER_CHUNK_BYTES, size - offset));
    const buf = Buffer.alloc(want);
    if (want > 0) {
      // Zwischen Prüfung und Öffnen könnte ein Ordner auf dem Weg gegen einen Link getauscht
      // werden. Darum ohne Link-Folgen öffnen und danach prüfen, dass die offene Datei noch die geprüfte ist.
      const fh = await open(r.real, fsc.O_RDONLY | fsc.O_NOFOLLOW).catch(() => {
        throw new FinderError(t("Auf diese Datei darf die Brücke nicht zugreifen."), FINDER_ERR.badPath);
      });
      try {
        const [opened, again] = await Promise.all([fh.stat(), this.resolve(rootId, rel).then((x) => stat(x.real))]);
        if (opened.ino !== again.ino || opened.dev !== again.dev) throw new FinderError(t("Dieser Pfad ist hier nicht erlaubt."), FINDER_ERR.badPath);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
      } finally {
        await fh.close();
      }
    }
    const eof = offset + want >= size;
    return { b64: buf.toString("base64"), offset, size, mtimeMs, sha256: offset === 0 && eof ? sha256(buf) : null, eof };
  }

  async thumb(rootId: FinderRootId, rel: string, size: number): Promise<FinderThumbResult> {
    const { r, size: bytes, mtimeMs } = await this.fileOf(rootId, rel);
    if (finderKindOf(basename(r.real), false) !== "image" && !r.real.toLowerCase().endsWith(".pdf")) throw new FinderError(t("Für diese Datei gibt es kein Vorschaubild."), FINDER_ERR.noThumb);
    const key = `${r.real}|${mtimeMs}|${bytes}|${size}`;
    const cached = this.thumbs.get(key);
    if (cached) return cached;
    let result: FinderThumbResult | null = null;
    await this.thumbSlot();
    const dir = await mkdtemp(join(tmpdir(), "nyxos-thumb-")).catch((e: unknown) => {
      this.thumbDone();
      throw e;
    });
    try {
      const out = join(dir, "t.jpg");
      await this.makeThumb(r.real, out, size);
      result = { b64: (await readFile(out)).toString("base64"), mime: "image/jpeg" };
    } catch {
      const ext = r.real.slice(r.real.lastIndexOf(".")).toLowerCase();
      const mime = THUMB_DIRECT_MIME[ext];
      if (mime && bytes <= THUMB_FALLBACK_MAX_BYTES) result = { b64: (await readFile(r.real)).toString("base64"), mime };
    } finally {
      this.thumbDone();
      await rm(dir, { recursive: true, force: true });
    }
    if (!result) throw new FinderError(t("Für diese Datei gibt es kein Vorschaubild."), FINDER_ERR.noThumb);
    while (this.thumbs.size > 0 && (this.thumbs.size >= THUMB_CACHE_MAX || this.thumbChars + result.b64.length > THUMB_CACHE_MAX_CHARS)) {
      const first = this.thumbs.keys().next().value;
      if (first === undefined) break;
      this.thumbChars -= this.thumbs.get(first)?.b64.length ?? 0;
      this.thumbs.delete(first);
    }
    if (!this.thumbs.has(key)) {
      this.thumbs.set(key, result);
      this.thumbChars += result.b64.length;
    }
    return result;
  }

  /**
   * Vorschaubild als JPEG: macOS mit `sips`, Linux mit ImageMagick (falls installiert). Ohne Werkzeug wirft das —
   * dann geht ein kleines Bild direkt raus, sonst zeigt die Oberfläche das Original.
   */
  private async makeThumb(src: string, out: string, size: number): Promise<void> {
    if ((this.o.platform ?? process.platform) === "darwin") {
      await run(this.o.sipsBin ?? "/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", String(size), src, "--out", out], { timeout: 15_000 });
      return;
    }
    const magick = this.o.imageMagickBin !== undefined ? this.o.imageMagickBin : (findBin("magick") ?? findBin("convert"));
    if (!magick) throw new Error("no thumbnail tool");
    // `[0]` = erste Seite/erstes Bild (PDF, GIF); `>` = nur verkleinern.
    await run(magick, [`${src}[0]`, "-auto-orient", "-thumbnail", `${size}x${size}>`, "-quality", "70", `jpg:${out}`], { timeout: 15_000 });
  }

  private thumbSlot(): Promise<void> {
    if (this.thumbRunning < THUMB_PARALLEL) {
      this.thumbRunning++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.thumbWaiting.push(resolve));
  }

  /** Platz frei: direkt an den nächsten Wartenden weitergeben (Zähler bleibt dann gleich). */
  private thumbDone(): void {
    const next = this.thumbWaiting.shift();
    if (next) next();
    else this.thumbRunning--;
  }

  async search(rootId: FinderRootId, rel: string, q: string): Promise<FinderSearchResult> {
    const r = await this.resolve(rootId, rel);
    const needle = q.toLowerCase();
    const hits: FinderEntry[] = [];
    const started = Date.now();
    let visited = 0;
    let truncated = false;
    const queue: { abs: string; rel: string }[] = [{ abs: r.real, rel }];
    while (queue.length > 0) {
      const dir = queue.shift();
      if (!dir) break;
      let items;
      try {
        items = await readdir(dir.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const it of items) {
        visited++;
        if (visited > SEARCH_MAX_VISITED || Date.now() - started > SEARCH_BUDGET_MS || hits.length >= FINDER_SEARCH_MAX) {
          truncated = true;
          queue.length = 0;
          break;
        }
        if (it.name === ".DS_Store" || it.isSymbolicLink()) continue;
        const childRel = dir.rel ? `${dir.rel}/${it.name}` : it.name;
        const childAbs = join(dir.abs, it.name);
        if (it.isDirectory() && (SEARCH_SKIP.has(it.name) || it.name.startsWith("."))) continue;
        if (it.name.toLowerCase().includes(needle)) {
          try {
            const e = await this.entryFor(childAbs, childRel, r.rootReal, false);
            if (e) hits.push(e);
          } catch {
            // weg
          }
        }
        if (it.isDirectory()) queue.push({ abs: childAbs, rel: childRel });
      }
    }
    return { root: rootId, rel, q, hits, truncated };
  }

  async write(rootId: FinderRootId, rel: string, content: string, baseSha: string): Promise<FinderWriteResult> {
    if (!this.writableRoot(rootId) || finderRelHidden(rel) || !finderWritableName(basename(rel))) {
      throw new FinderError(t("Hier kann nur Markdown oder Text in den Projektordnern gespeichert werden."), FINDER_ERR.readOnly);
    }
    if (Buffer.byteLength(content) > FINDER_TEXT_MAX_BYTES) throw new FinderError(t("Der Text ist zu groß zum Speichern."), FINDER_ERR.tooLarge);
    const { r } = await this.fileOf(rootId, rel);
    const realRel = relative(r.rootReal, r.real).split(sep).join("/");
    if (finderRelHidden(realRel) || !finderWritableName(basename(r.real))) {
      throw new FinderError(t("Hier kann nur Markdown oder Text in den Projektordnern gespeichert werden."), FINDER_ERR.readOnly);
    }
    const current = await readFile(r.real);
    if (sha256(current) !== baseSha) throw new FinderError(t("Die Datei wurde inzwischen woanders geändert."), FINDER_ERR.conflict);
    const now = (this.o.now ?? (() => new Date()))();
    const iso = now.toISOString();
    const day = iso.slice(0, 10);
    const stamp = iso.slice(11, 23).replace(/[:.]/g, "");
    const backup = join(this.o.backupsDir, day, rootId, ...realRel.split("/")) + `.${stamp}.bak`;
    await mkdir(dirname(backup), { recursive: true });
    await copyFile(r.real, backup);
    const mode = (await stat(r.real)).mode & 0o777;
    const tmp = join(dirname(r.real), `.${basename(r.real)}.nyxos-${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, content, { encoding: "utf8", mode });
      await chmod(tmp, mode);
      await rename(tmp, r.real);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    const st = await stat(r.real);
    return { mtimeMs: Math.round(st.mtimeMs), sha256: sha256(content), size: st.size, backup };
  }
}

/**
 * Ablageort der Bildschirmfotos: macOS laut `defaults read com.apple.screencapture location`; Linux der Ordner
 * `Screenshots` im Bilder-Ordner (XDG_PICTURES_DIR, sonst ~/Pictures), falls es ihn gibt. Sonst `null`.
 */
export async function screenshotsLocation(home: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (platform !== "darwin") {
    const pictures = await xdgPicturesDir(home, env);
    // GNOME benennt den Ordner je nach Systemsprache („Screenshots“, deutsch „Bildschirmfotos“).
    for (const dir of [join(pictures, "Screenshots"), join(pictures, "Bildschirmfotos"), pictures]) {
      try {
        if ((await stat(dir)).isDirectory()) return dir;
      } catch {
        // weiter
      }
    }
    return null;
  }
  try {
    const { stdout } = await run("/usr/bin/defaults", ["read", "com.apple.screencapture", "location"], { timeout: 3_000 });
    const p = stdout.trim().replace(/^~(?=\/|$)/, home);
    return p.startsWith("/") ? p : null;
  } catch {
    return null;
  }
}

/** Bilder-Ordner nach XDG: Umgebung, dann `~/.config/user-dirs.dirs`, sonst `~/Pictures`. */
async function xdgPicturesDir(home: string, env: NodeJS.ProcessEnv): Promise<string> {
  const expand = (v: string) => v.replace(/^\$HOME(?=\/|$)/, home).replace(/^~(?=\/|$)/, home);
  if (env.XDG_PICTURES_DIR?.trim()) return expand(env.XDG_PICTURES_DIR.trim());
  try {
    const text = await readFile(join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "user-dirs.dirs"), "utf8");
    const m = /^XDG_PICTURES_DIR="([^"]+)"/m.exec(text);
    if (m?.[1]) return expand(m[1]);
  } catch {
    // keine Datei
  }
  return join(home, "Pictures");
}
