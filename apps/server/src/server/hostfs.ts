// Server-Finder — Dateien des Hosts NUR LESEN. Die Ordner sind im API-Container unter /hostfs/<id>
// schreibgeschützt eingehängt (infra/docker-compose.yml). Drei Sperren, jede für sich:
// 1. Der Pfad ist relativ, ohne `..`/`.`/leere Teile/NUL (sonst 400).
// 2. `realpath` muss in der Wurzel bleiben — ein Symlink nach draußen führt nie hinaus (403).
// 3. Sperrliste: Zugangsdaten, Schlüssel, Datenbank-Daten und Sicherungen sind „gesperrt“ (403) — geprüft am
//    angefragten UND am aufgelösten Pfad (ein Link auf ~/.ssh ist genauso gesperrt).
import type { HostFsEntry, HostFsListResult, HostFsRoot, HostFsSearchResult, HostFsTextResponse } from "@nyxos/shared";
import { HOSTFS_MAX_BYTES, HOSTFS_PART_BYTES, HOSTFS_SEARCH_MAX, t } from "@nyxos/shared";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface HostFsRootDef {
  id: string;
  label: string;
  /** Pfad auf dem Host (nur Anzeige). */
  hostPath: string;
  /** Pfad im Container (dort eingehängt). */
  dir: string;
}

export type HostFsOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 413 | 415 | 429 | 500; error: string; code: string };

const MAX_ENTRIES = 2000;
/** Rekursive Suche: höchstens so viele Ordner und so lange — dann „gekürzt“ statt den Server zu beschäftigen. */
const SEARCH_MAX_DIRS = 5000;
const SEARCH_BUDGET_MS = 4000;
const SEARCH_Q_MAX = 100;
/** Diese Ordner betritt die Suche nicht (riesig, nie gesucht) — ihr eigener Name kann trotzdem ein Treffer sein. */
const SEARCH_SKIP_DESCEND = new Set(["node_modules", ".pnpm-store"]);

const SEARCH_PARALLEL = 2;
const NAME_ORDER = new Intl.Collator("de");

export type HostFsPart = "head" | "tail";
const ROOT_ID = /^[a-z][a-z0-9-]{0,31}$/;

const LABELS: Record<string, string> = { home: "Home", srv: "/srv", opt: "/opt", log: "Logs (/var/log)", nyxos: "NyxOS" };

/** `NYXOS_HOSTFS_ROOTS="home:/hostfs/home:/home/alex,log:/hostfs/log:/var/log"` — ungültige Teile fallen still weg. */
export function parseHostFsRoots(raw: string | undefined): HostFsRootDef[] {
  if (!raw) return [];
  const out: HostFsRootDef[] = [];
  for (const part of raw.split(",")) {
    const [id, dir, hostPath] = part.trim().split(":");
    if (!id || !dir || !ROOT_ID.test(id) || !dir.startsWith("/") || out.some((r) => r.id === id)) continue;
    out.push({ id, dir, hostPath: hostPath || dir, label: LABELS[id] ?? (hostPath || id) });
  }
  return out;
}

// ───────────────────────────── Sperrregel ─────────────────────────────
// ORDNER öffnen sich (.ssh, .config,
// .cache, .claude, backups …) — gesperrt bleiben DATEIEN mit Geheimnis-Inhalt. Als ganzer Ordner bleiben zu:
// der Inhalt von .git (config mit Zugangsdaten in der URL, objects), /proc, Rohdaten der Datenbanken und Ordner,
// deren Dateien Schlüssel sind, ohne dass man es am Namen sieht (.gnupg, Keyrings, .kube, .cloudflared …).
// Der API-Container läuft als uid 1000 (meist der Besitzer des Home-Ordners), 0600-Dateien wären lesbar — diese Regel ist die Hürde.
// Die Tabelle mit Beispielen (erlaubt/gesperrt) steht in test/server-finder-lock-rule.test.ts.

/** Ordner, die ganz zu bleiben (Kleinschreibung). */
const SECRET_DIRS = new Set([
  ".git", "proc",
  ".gnupg", ".password-store", "keyrings", "private-keys-v1.d",
  "pgdata", "postgres-data", "postgres_data", "postgresql", "redis-data", "redis_data", "caddy_data", "caddy-data", "volumes",
  ".kube", ".cloudflared", ".acme.sh", "letsencrypt", ".pki", ".tailscale", "tailscale", "wireguard", "sudoers.d",
  // Werkzeug-Ordner, deren Dateien (mit harmlosen Namen) Tokens tragen.
  ".aws", "gcloud", "github-copilot", "hcloud", ".wrangler", "ngrok", "doctl", "netlify", ".mc", "sops", "borg",
]);
/** Wörter in ORDNER-Namen, unter denen jede DATEI gesperrt ist (Sicherungen, Geheimnis-Ordner) — der Ordner selbst
 * ist sichtbar und durchsuchbar. Viele Projekte legen z. B. `secrets/` neben die Compose-Datei. */
const FILES_LOCKED_BELOW_WORDS = ["backup", "snapshot", "dump", "secret", "credential", "private", "vault", "password", "passwd", "keyring"];
/** In ~/.ssh ist nur das Öffentliche lesbar — private Schlüssel heißen oft frei (github, server, nas_ed25519). */
const SSH_OPEN_FILES = new Set(["known_hosts", "known_hosts.old", "config", "authorized_keys", "authorized_keys2", "environment.md"]);

/** Dateinamen (Kleinschreibung), die immer Geheimnisse enthalten. */
const SECRET_FILE_NAMES = new Set([
  ".netrc", ".pgpass", ".npmrc", ".pypirc", ".git-credentials", ".yarnrc", ".yarnrc.yml", ".my.cnf", ".s3cfg", ".boto", ".dockercfg",
  ".htpasswd", "htpasswd", "acme.json", "rclone.conf", "gradle.properties", ".vault-token", ".claude.json",
  "auth.json", "hosts.yml", "hosts.json", "apps.json", "config.json", "kubeconfig", ".lesshst",
  // Werkzeug-Einstellungen mit möglichen Schlüsseln (env-Block, MCP-Server-Tokens).
  "settings.json", "settings.local.json", "config.toml", ".viminfo", "shadow", "gshadow", "shadow-", "gshadow-", "sudoers",
]);
const SECRET_FILE_EXT = [
  ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".gpg", ".asc", ".p8", ".crt", ".cer", ".der", ".csr", ".p7b", ".jwk",
  ".ppk", ".ovpn", ".age", ".tfstate", ".tfvars", ".keychain", ".keychain-db", ".mobileprovision",
  // Datenbanken (Personendaten) und Sicherungen/Archive (enthalten oft .env/Schlüssel, nicht prüfbar).
  ".db", ".sqlite", ".sqlite3", ".sql", ".dump", ".bak", ".rdb", ".aof", ".tar", ".tgz", ".gz", ".zst", ".xz", ".bz2", ".zip", ".7z", ".rar",
  ".swp", ".swo",
  // pg_dump-Formate und NATS-Zugangsdaten.
  ".pgdump", ".backup", ".custom", ".creds", ".nk",
];
const SECRET_FILE_WORDS = [
  "secret", "credential", "password", "passwd", "private", "token", "apikey", "api_key", "api-key", "access_key", "accesskey", "authkey",
  "keystore", "keyring", "wallet", "service-account", "service_account", "serviceaccount", "firebase", "googleservice-info", "oauth", "cookies", "backup", "dump",
];
const SECRET_FILE_PATTERNS = [
  /(^|[._-])env($|[._-])/, // .env, .env.local, prod.env, env.production, docker-env.txt
  /^\.env/, // .envrc, .env-irgendwas
  /^id_(?!.*\.pub$)/, // private SSH-Schlüssel (id_ed25519) — id_ed25519.pub ist öffentlich
  /_key$/, // ssh_host_ed25519_key, deploy_key
  /^(docker-)?compose([._-].*)?\.ya?ml$/, // Umgebungs-Geheimnisse stehen oft inline
  /^caddyfile/, // basic_auth-Hashes
  /^wg[^/]*\.conf$/, // WireGuard-Schlüssel
  /^(?!.*\.pub$).*(^|[._-])key([._-]|$)/, // github_deploy_key_ro, deploy.key.txt — nicht keyboard.txt, nicht *.pub
  /(^|[._-])history([._-]|$)/, // fish_history, zsh/history, history.jsonl
  /^\..*hist/, // Shell-/Werkzeug-Verläufe (eingetippte Passwörter)
];

function secretDirName(name: string): boolean {
  return SECRET_DIRS.has(name) || name.endsWith(".git");
}

function secretFileName(name: string, parent: string | undefined): boolean {
  if (SECRET_FILE_NAMES.has(name)) return true;
  if (parent === ".ssh" && !name.endsWith(".pub") && !SSH_OPEN_FILES.has(name)) return true;
  if (SECRET_FILE_EXT.some((e) => name.endsWith(e))) return true;
  if (SECRET_FILE_PATTERNS.some((re) => re.test(name))) return true;
  return SECRET_FILE_WORDS.some((w) => name.includes(w));
}

/**
 * DIE Sperrregel des Server-Finders: Ist `rel` (relativ zur Wurzel) gesperrt? `isDir` sagt, ob der LETZTE Teil
 * ein Ordner ist. Gesperrt, wenn
 * - ein Ordner auf dem Weg (oder der Ordner selbst) ganz zu bleibt (.git, /proc, .gnupg, DB-Rohdaten …),
 * - es eine Datei in einem Sicherungs-/Geheimnis-Ordner ist (backups/, secrets/, private/, vault/ …),
 * - es in ~/.ssh etwas anderes ist als *.pub, known_hosts, config, authorized_keys,
 * - es eine Datei mit Geheimnis-Inhalt ist (.env, Schlüssel, Zugangsdaten, Compose, Datenbanken, Verläufe …).
 */
function isTranscriptPath(segs: string[]): boolean {
  const name = segs[segs.length - 1] ?? "";
  const under = (a: string, b: string) => segs.some((s, i) => s === a && segs[i + 1] === b);
  // Dateiverlauf (Kopien jeder bearbeiteten Datei, auch .env/Compose, Namen wie `<hash>@v2`) und
  // Einfüge-Speicher sind ohne Endung – dort ist JEDE Datei gesperrt.
  if (under(".claude", "file-history") || under(".claude", "paste-cache")) return true;
  return (under(".claude", "projects") || under(".codex", "sessions") || under(".codex", "archived_sessions") || under(".claude", "todos")) && /\.(jsonl|json|txt|md)$/.test(name);
}

export function isSecretPath(rel: string, isDir: boolean): boolean {
  const segs = rel.toLowerCase().split("/").filter((s) => s !== "");
  if (segs.length === 0) return false;
  const dirs = isDir ? segs : segs.slice(0, -1);
  if (dirs.some(secretDirName)) return true;
  if (isDir) return false;
  if (dirs.some((d) => FILES_LOCKED_BELOW_WORDS.some((w) => d.includes(w)))) return true;
  // Session-Mitschnitte (Claude/Codex) enthalten oft ausgegebene Geheimnisse (z. B. `cat .env`) –
  // die Ordner sind offen, die Mitschnitt-Dateien darin bleiben gesperrt.
  if (isTranscriptPath(segs)) return true;
  return secretFileName(segs[segs.length - 1] ?? "", dirs[dirs.length - 1]);
}

/** Gesperrt als Datei UND als Ordner — dann ohne jeden Dateizugriff ablehnen (kein Existenz-Orakel). */
function lockedEitherWay(rel: string): boolean {
  return isSecretPath(rel, false) && isSecretPath(rel, true);
}

/** Kurzform für Dateien (ältere Aufrufer/Tests). */
export function isLockedRel(rel: string): boolean {
  return isSecretPath(rel, false);
}

/** Pfad relativ zur Wurzel in /-Schreibweise. */
function relOf(rootReal: string, abs: string): string {
  return relative(rootReal, abs).split(sep).join("/");
}

function relOk(rel: string): boolean {
  if (rel === "") return true;
  if (rel.length > 4096 || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const TEXT = {
  badPath: "Dieser Pfad ist ungültig.",
  unknownRoot: "Diesen Server-Ordner gibt es nicht.",
  locked: "Gesperrt: Hier liegen Zugangsdaten oder geschützte Daten. Die zeigt NyxOS nie an.",
  outside: "Gesperrt: Dieser Link zeigt aus dem freigegebenen Ordner hinaus.",
  notFound: "Diese Datei oder dieser Ordner existiert nicht (mehr).",
  noAccess: "Keine Leserechte: Der NyxOS-Container darf diese Datei nicht lesen.",
  tooLarge: "Die Datei ist größer als 2 MB. Die Vorschau zeigt nur kleinere Dateien.",
  notText: "Das ist keine Textdatei.",
  notDir: "Das ist kein Ordner.",
  notFile: "Das ist ein Ordner, keine Datei.",
  badQuery: "Bitte einen Suchbegriff eingeben.",
  busy: "Es laufen gerade schon Suchen. Bitte kurz warten.",
};

type Failure = Extract<HostFsOutcome<never>, { ok: false }>;

function fail(status: Failure["status"], key: keyof typeof TEXT): Failure {
  return { ok: false, status, error: t(TEXT[key]), code: `hostfs_${key}` };
}

function fsFail(e: unknown): Failure {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return fail(404, "notFound");
  if (code === "EACCES" || code === "EPERM") return fail(403, "noAccess");
  return fail(500, "notFound");
}

interface Resolved {
  def: HostFsRootDef;
  rootReal: string;
  real: string;
  rel: string;
}

export class HostFs {
  constructor(private readonly defs: HostFsRootDef[]) {}

  get configured(): boolean {
    return this.defs.length > 0;
  }

  async roots(): Promise<HostFsRoot[]> {
    return Promise.all(
      this.defs.map(async (d) => ({
        id: d.id,
        label: t(d.label),
        hostPath: d.hostPath,
        exists: await stat(d.dir).then(
          (s) => s.isDirectory(),
          () => false,
        ),
      })),
    );
  }

  /** Prüft Pfad, Sperrliste und Symlink-Ziel; liefert den echten Pfad im Container. */
  private async resolve(rootId: string, rel: string): Promise<HostFsOutcome<Resolved>> {
    const def = this.defs.find((d) => d.id === rootId);
    if (!def) return fail(404, "unknownRoot");
    if (!relOk(rel)) return fail(400, "badPath");
    // Gesperrt, egal ob Datei oder Ordner (z. B. alles unter .git) → ohne Dateizugriff ablehnen.
    if (lockedEitherWay(rel)) return fail(403, "locked");
    let rootReal: string;
    let real: string;
    let isDir: boolean;
    try {
      rootReal = await realpath(def.dir);
      real = await realpath(rel === "" ? def.dir : join(def.dir, rel));
      isDir = (await stat(real)).isDirectory();
    } catch (e) {
      return fsFail(e);
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return fail(403, "outside");
    // Geprüft am angefragten UND am aufgelösten Pfad (ein Link auf ~/.ssh/id_ed25519 ist genauso gesperrt).
    if (isSecretPath(rel, isDir) || isSecretPath(relOf(rootReal, real), isDir)) return fail(403, "locked");
    return { ok: true, value: { def, rootReal, real, rel } };
  }

  async list(rootId: string, rel: string): Promise<HostFsOutcome<HostFsListResult>> {
    const r = await this.resolve(rootId, rel);
    if (!r.ok) return r;
    let names: string[];
    try {
      const s = await stat(r.value.real);
      if (!s.isDirectory()) return fail(400, "notDir");
      names = await readdir(r.value.real);
    } catch (e) {
      return fsFail(e);
    }
    names.sort((a, b) => a.localeCompare(b, "de"));
    const truncated = names.length > MAX_ENTRIES;
    const entries: HostFsEntry[] = [];
    for (const name of names.slice(0, MAX_ENTRIES)) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const abs = join(r.value.real, name);
      let link = false;
      let target = abs;
      try {
        link = (await lstat(abs)).isSymbolicLink();
        if (link) {
          target = await realpath(abs);
          // Links nach draußen erscheinen gar nicht erst.
          if (target !== r.value.rootReal && !target.startsWith(r.value.rootReal + sep)) continue;
        }
        const s = await stat(target);
        const locked = isSecretPath(childRel, s.isDirectory()) || (link && isSecretPath(relOf(r.value.rootReal, target), s.isDirectory()));
        // Gesperrtes: nur der Name, keine Größe/Zeit (verrät sonst, wann ein Schlüssel/eine .env zuletzt geändert wurde).
        const entry: HostFsEntry = { name, rel: childRel, isDir: s.isDirectory(), size: s.isDirectory() || locked ? 0 : s.size, mtimeMs: locked ? 0 : s.mtimeMs, locked, link };
        if (!locked) entry.mode = s.mode & 0o777;
        entries.push(entry);
      } catch {
        // kaputter Link oder keine Rechte: Eintrag ohne Größe, trotzdem sichtbar (außer Link)
        if (!link) entries.push({ name, rel: childRel, isDir: false, size: 0, mtimeMs: 0, locked: isSecretPath(childRel, false), link: false });
      }
    }
    return { ok: true, value: { root: rootId, rel, entries, truncated } };
  }

  /** Rekursive Namenssuche unterhalb von `rel` (Teilstring, ohne Groß/klein). Gesperrtes wird weder gefunden
   * noch betreten, Links nie verfolgt (auch nicht nach innen). Grenzen: Treffer, Ordnerzahl, Zeit. */
  async search(rootId: string, rel: string, qRaw: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<HostFsOutcome<HostFsSearchResult>> {
    const shown = qRaw.trim().slice(0, SEARCH_Q_MAX);
    const q = shown.toLowerCase();
    if (q === "" || q.includes("\0")) return fail(400, "badQuery");
    // höchstens SEARCH_PARALLEL Suchen gleichzeitig (langsames Tippen startet sonst viele volle Läufe).
    if (this.activeSearches >= SEARCH_PARALLEL) return fail(429, "busy");
    this.activeSearches++;
    try {
      return await this.searchWalk(rootId, rel, q, shown, opts);
    } finally {
      this.activeSearches--;
    }
  }

  private activeSearches = 0;

  private async searchWalk(rootId: string, rel: string, q: string, shown: string, opts: { limit?: number; signal?: AbortSignal }): Promise<HostFsOutcome<HostFsSearchResult>> {
    const r = await this.resolve(rootId, rel);
    if (!r.ok) return r;
    try {
      if (!(await stat(r.value.real)).isDirectory()) return fail(400, "notDir");
    } catch (e) {
      return fsFail(e);
    }
    const limit = Math.max(1, Math.min(HOSTFS_SEARCH_MAX, opts.limit ?? HOSTFS_SEARCH_MAX));
    const started = Date.now();
    const entries: HostFsEntry[] = [];
    const queue: Array<{ abs: string; rel: string }> = [{ abs: r.value.real, rel }];
    let dirs = 0;
    let truncated = false;
    search: while (queue.length > 0) {
      // Abgebrochene Anfrage (Browser hat weitergetippt) → sofort aufhören.
      if (opts.signal?.aborted || dirs >= SEARCH_MAX_DIRS || Date.now() - started > SEARCH_BUDGET_MS) {
        truncated = true;
        break;
      }
      const dir = queue.shift();
      if (!dir) break;
      dirs++;
      let children: Dirent[];
      let real: string;
      try {
        // Wie list(): der Ordner muss (noch) in der Wurzel liegen und darf nicht gesperrt sein — wurde er
        // inzwischen gegen einen Link getauscht, führt das nicht hinaus.
        real = await realpath(dir.abs);
        if (real !== r.value.rootReal && !real.startsWith(r.value.rootReal + sep)) continue;
        if (isSecretPath(relOf(r.value.rootReal, real), true)) continue;
        children = await readdir(real, { withFileTypes: true });
      } catch {
        continue; // keine Rechte o. Ä.: still überspringen
      }
      if (children.length > MAX_ENTRIES * 5) children = children.slice(0, MAX_ENTRIES * 5);
      children.sort((a, b) => NAME_ORDER.compare(a.name, b.name));
      for (const d of children) {
        // Gesperrtes zählt gar nicht: kein Treffer, kein Abstieg. Links: nie verfolgt, nie gezeigt.
        if (d.isSymbolicLink()) continue;
        const childRel = dir.rel === "" ? d.name : `${dir.rel}/${d.name}`;
        // Gesperrte Dateien nie als Treffer, gesperrte Ordner nie betreten (offene Ordner schon).
        if (isSecretPath(childRel, d.isDirectory())) continue;
        const abs = join(real, d.name);
        if (d.name.toLowerCase().includes(q)) {
          if (entries.length >= limit) {
            truncated = true;
            break search;
          }
          const s = await lstat(abs).catch(() => null);
          if (s && !s.isSymbolicLink()) {
            entries.push({ name: d.name, rel: childRel, isDir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtimeMs: s.mtimeMs, locked: false, link: false, mode: s.mode & 0o777 });
          }
        }
        if (d.isDirectory() && !SEARCH_SKIP_DESCEND.has(d.name)) queue.push({ abs, rel: childRel });
      }
    }
    return { ok: true, value: { root: rootId, rel, q: shown, entries, truncated } };
  }

  /** Öffnet eine Datei mit allen Sperren (nur reguläre Dateien, O_NOFOLLOW, Inode- und /proc-Abgleich) und
   * reicht sie an `use` weiter. Die EINZIGE Stelle, an der Host-Dateien geöffnet werden. */
  private async withCheckedFile<T>(rootId: string, rel: string, use: (fh: FileHandle, s: Stats) => Promise<HostFsOutcome<T>>): Promise<HostFsOutcome<T>> {
    if (rel === "") return fail(400, "notFile");
    const r = await this.resolve(rootId, rel);
    if (!r.ok) return r;
    try {
      // nur reguläre Dateien. Ein FIFO/Socket/Gerät würde `open` (bzw. das Lesen) auf ewig blockieren
      // und einen libuv-Faden belegen — vorher per stat aussortieren und zusätzlich O_NONBLOCK öffnen.
      const pre = await stat(r.value.real);
      if (pre.isDirectory()) return fail(400, "notFile");
      if (!pre.isFile()) return fail(415, "notText");
      // O_NOFOLLOW: `real` ist schon aufgelöst — ist die letzte Stelle jetzt doch ein Link, wurde sie
      // zwischen Prüfung und Öffnen getauscht (TOCTOU) → ELOOP → abgelehnt.
      const fh = await open(r.value.real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const s = await fh.stat();
        if (s.isDirectory()) return fail(400, "notFile");
        if (!s.isFile() || s.ino !== pre.ino || s.dev !== pre.dev) return fail(403, "outside");
        // (TOCTOU): Unter Linux zeigt /proc/self/fd/<n>, welche Datei WIRKLICH offen ist — wurde
        // zwischen realpath und open ein Ordner auf dem Weg gegen einen Link getauscht, fällt das hier auf.
        const opened = await realpath(`/proc/self/fd/${fh.fd}`).catch(() => null);
        if (opened !== null && !opened.startsWith("/proc/")) {
          if (opened !== r.value.rootReal && !opened.startsWith(r.value.rootReal + sep)) return fail(403, "outside");
          if (isSecretPath(relOf(r.value.rootReal, opened), false)) return fail(403, "locked");
        }
        return await use(fh, s);
      } finally {
        await fh.close();
      }
    } catch (e) {
      return fsFail(e);
    }
  }

  /** Datei (≤ 2 MB) als Bytes. */
  async readRaw(rootId: string, rel: string): Promise<HostFsOutcome<{ bytes: Buffer; mtimeMs: number; name: string }>> {
    return this.withCheckedFile(rootId, rel, async (fh, s) => {
      if (s.size > HOSTFS_MAX_BYTES) return fail(413, "tooLarge");
      const buf = Buffer.alloc(Math.min(s.size, HOSTFS_MAX_BYTES + 1));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > HOSTFS_MAX_BYTES) return fail(413, "tooLarge");
      return { ok: true, value: { bytes: buf.subarray(0, bytesRead), mtimeMs: s.mtimeMs, name: rel.split("/").pop() ?? rel } };
    });
  }

  /** Nur Anfang bzw. Ende (HOSTFS_PART_BYTES) einer großen Datei — auf ganze Zeilen gekürzt. */
  private async readPart(rootId: string, rel: string, part: HostFsPart): Promise<HostFsOutcome<{ bytes: Buffer; mtimeMs: number; name: string; totalSize: number }>> {
    return this.withCheckedFile(rootId, rel, async (fh, s) => {
      const len = Math.min(s.size, HOSTFS_PART_BYTES);
      const from = part === "tail" ? s.size - len : 0;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, from);
      let bytes = buf.subarray(0, bytesRead);
      if (part === "tail" && from > 0) {
        // Erste (angeschnittene) Zeile weg — das schneidet auch halbe UTF-8-Zeichen ab.
        const nl = bytes.indexOf(0x0a);
        if (nl >= 0 && nl < bytes.length - 1) bytes = bytes.subarray(nl + 1);
      } else if (part === "head" && bytesRead < s.size) {
        const nl = bytes.lastIndexOf(0x0a);
        if (nl > 0) bytes = bytes.subarray(0, nl + 1);
      }
      return { ok: true, value: { bytes, mtimeMs: s.mtimeMs, name: rel.split("/").pop() ?? rel, totalSize: s.size } };
    });
  }

  /** Textdatei. Größer als 2 MB: ohne `part` 413, mit `part` nur Anfang oder Ende (`partial`, `totalSize`). */
  async readText(rootId: string, rel: string, part?: HostFsPart): Promise<HostFsOutcome<HostFsTextResponse>> {
    const raw = await this.readRaw(rootId, rel);
    if (raw.ok) {
      const { bytes, mtimeMs, name } = raw.value;
      // NUL-Byte in den ersten 8 KB = Binärdatei (wie git/grep).
      if (bytes.subarray(0, 8192).includes(0)) return fail(415, "notText");
      return { ok: true, value: { root: rootId, rel, name, content: bytes.toString("utf8"), size: bytes.length, mtimeMs } };
    }
    if (raw.status !== 413 || !part) return raw;
    const cut = await this.readPart(rootId, rel, part);
    if (!cut.ok) return cut;
    const { bytes, mtimeMs, name, totalSize } = cut.value;
    if (bytes.subarray(0, 8192).includes(0)) return fail(415, "notText");
    return { ok: true, value: { root: rootId, rel, name, content: bytes.toString("utf8"), size: bytes.length, mtimeMs, partial: part, totalSize } };
  }
}
