// Leitplanken: erkennt gefährliche Shell-Befehle (Push, Merge auf main, Deploy, Migration,
// Löschen außerhalb der Worktree, Session schließen, Aufgabe „Erledigt"). Reine Funktion ohne
// Prozesse/Dateizugriffe. Eigener, kleiner Shell-Zerleger (Anführungszeichen, Escapes, Operatoren,
// `$(…)`, Backticks, Heredocs) — bewusst kein npm-Paket.
//
// Grundsatz: lieber einmal zu viel fragen als einmal zu wenig — aber nur bei den D6-Befehlen.
// Harmlose Ähnlichkeiten (`echo "git push"`, `git push --dry-run`, `git merge main` auf dem
// Auftrags-Zweig) bleiben frei.
// Zusätzlich: „nicht prüfbar → fragen“ (Regel `unchecked`) für Skript-
// Dateien, Interpreter-Code mit Systemzugriff, Makefiles, beliebige Paket-Skripte, git-Aliase/-Konfiguration
// im Aufruf, tmux/osascript/verschachtelte Agenten; schreibende GitHub-Zugriffe → `github_write`.
// Das ist eine LEITPLANKE, keine Sandbox.
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { t, type GuardRule } from "@nyxos/shared";
import { foldCase } from "../platform.js";

export interface GuardInput {
  /** Claude-Code-Werkzeug (`tool_name`). Geprüft wird nur `Bash`. */
  tool: string;
  command: string;
  cwd: string | null;
  worktreeRoot: string | null;
  currentBranch: string | null;
  env: Record<string, string | undefined>;
  /**
   * Produktionsserver (Host-Alias, Hostname, IP oder `*.domain`): ssh/scp/rsync/sftp dorthin gilt als Deploy.
   * Ohne Angabe: aus `NYXOS_PROD_HOSTS` (Komma-Liste) in `env`.
   */
  prodHosts?: readonly string[];
}

export interface GuardHit {
  rule: GuardRule;
  reason: string;
}

// ───────────────────────────── Zerleger ─────────────────────────────

interface Word {
  kind: "word";
  text: string;
  /** Enthält eine nicht auflösbare Variable/Ersetzung (`$X`, `$(…)`, Backticks). */
  dynamic: boolean;
  /** Enthält unquotierte Glob-Zeichen (`*`, `?`, `[`). */
  glob: boolean;
  /** Beginnt mit einem unquotierten `~`. */
  tilde: boolean;
  quoted: boolean;
}
interface Op {
  kind: "op";
  op: string;
}
interface Redir {
  kind: "redir";
  op: string;
}
interface Heredoc {
  kind: "heredoc";
  body: string;
}
type Token = Word | Op | Redir | Heredoc;

interface Lexed {
  tokens: Token[];
  /** Inhalte von `$(…)`, Backticks und `<(…)`: werden separat geprüft. */
  subs: string[];
}

/** Liest bis zur passenden schließenden Klammer (Anführungszeichen und Verschachtelung beachtet). */
function balanced(src: string, start: number): [string, number] {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (depth === 0) return [src.slice(start, i), i + 1];
    }
    i++;
  }
  return [src.slice(start), src.length];
}

const OP_CHARS = "&|;()";

export function lex(src: string, env: Record<string, string | undefined>): Lexed {
  const tokens: Token[] = [];
  const subs: string[] = [];
  const pending: { delim: string; strip: boolean; tok: Heredoc }[] = [];
  const n = src.length;
  let cur: Word | null = null;
  let i = 0;

  const word = (): Word => (cur ??= { kind: "word", text: "", dynamic: false, glob: false, tilde: false, quoted: false });
  const endWord = () => {
    if (cur) tokens.push(cur);
    cur = null;
  };

  /** `$…` ab Position i (src[i] === "$"); gibt die neue Position zurück. */
  const readDollar = (at: number): number => {
    const w = word();
    const next = src[at + 1];
    if (next === "(") {
      const [inner, end] = balanced(src, at + 2);
      // `$((…))` ist Rechnen, keine Befehlsersetzung — trotzdem prüfen schadet nicht.
      subs.push(inner.startsWith("(") && inner.endsWith(")") ? "" : inner);
      w.dynamic = true;
      w.text += "$(…)";
      return end;
    }
    if (next === "{") {
      const j = src.indexOf("}", at + 2);
      const end = j < 0 ? n : j;
      const name = src.slice(at + 2, end);
      if (name === "HOME" && env.HOME) w.text += env.HOME;
      else {
        w.dynamic = true;
        w.text += "${" + name + "}";
      }
      return end + 1;
    }
    if (next === "'") {
      // $'…' (ANSI-C): Inhalt ohne Escape-Auswertung übernehmen.
      const j = src.indexOf("'", at + 2);
      const end = j < 0 ? n : j;
      w.text += src.slice(at + 2, end).replace(/\\(.)/g, "$1");
      w.quoted = true;
      return end + 1;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9@*#?$!-]/.exec(src.slice(at + 1));
    if (!m) {
      w.text += "$";
      return at + 1;
    }
    if (m[0] === "HOME" && env.HOME) w.text += env.HOME;
    else {
      w.dynamic = true;
      w.text += "$" + m[0];
    }
    return at + 1 + m[0].length;
  };

  const readBacktick = (at: number): number => {
    let j = at + 1;
    while (j < n && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
    subs.push(src.slice(at + 1, Math.min(j, n)));
    const w = word();
    w.dynamic = true;
    w.text += "`…`";
    return j + 1;
  };

  while (i < n) {
    const c = src[i] as string;
    if (c === "\n") {
      endWord();
      tokens.push({ kind: "op", op: "\n" });
      i++;
      for (const h of pending) {
        const lines: string[] = [];
        while (i < n) {
          const nl = src.indexOf("\n", i);
          const lineEnd = nl < 0 ? n : nl;
          const line = src.slice(i, lineEnd);
          i = nl < 0 ? n : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
        }
        h.tok.body = lines.join("\n");
      }
      pending.length = 0;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    if (c === "#" && !cur) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      const w = word();
      if (i + 1 < n) w.text += src[i + 1];
      w.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const w = word();
      w.quoted = true;
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      w.text += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const w = word();
      w.quoted = true;
      i++;
      while (i < n && src[i] !== '"') {
        const d = src[i] as string;
        if (d === "\\" && i + 1 < n && '"\\$`\n'.includes(src[i + 1] as string)) {
          w.text += src[i + 1];
          i += 2;
        } else if (d === "$") i = readDollar(i);
        else if (d === "`") i = readBacktick(i);
        else {
          w.text += d;
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === "$") {
      i = readDollar(i);
      continue;
    }
    if (c === "`") {
      i = readBacktick(i);
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const [inner, end] = balanced(src, i + 2);
      subs.push(inner);
      const w = word();
      w.dynamic = true;
      w.text += "<(…)";
      i = end;
      continue;
    }
    if (c === "<" && src.startsWith("<<<", i)) {
      endWord();
      tokens.push({ kind: "redir", op: "<<<" });
      i += 3;
      continue;
    }
    if (c === "<" && src[i + 1] === "<") {
      endWord();
      i += 2;
      let strip = false;
      if (src[i] === "-") {
        strip = true;
        i++;
      }
      while (src[i] === " " || src[i] === "\t") i++;
      let delim = "";
      while (i < n && !" \t\n;&|<>()".includes(src[i] as string)) {
        const d = src[i] as string;
        if (d !== "'" && d !== '"' && d !== "\\") delim += d;
        i++;
      }
      const tok: Heredoc = { kind: "heredoc", body: "" };
      tokens.push(tok);
      pending.push({ delim, strip, tok });
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // Ein reines Zahlen-Wort davor ist die Dateinummer (`2>`), kein Argument.
      const w = cur as Word | null;
      if (w && !w.quoted && /^\d+$/.test(w.text)) cur = null;
      else endWord();
      let op = c;
      i++;
      if (c === "&") {
        op += ">";
        i++;
      }
      if (src[i] === ">" || src[i] === "&" || src[i] === "|") {
        op += src[i];
        i++;
      }
      if (op.endsWith("&")) {
        const m = /^[0-9-]+/.exec(src.slice(i));
        if (m) {
          i += m[0].length;
          continue;
        }
      }
      tokens.push({ kind: "redir", op });
      continue;
    }
    if (OP_CHARS.includes(c)) {
      endWord();
      const two = src.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === ";;" || two === "|&") {
        tokens.push({ kind: "op", op: two });
        i += 2;
      } else {
        tokens.push({ kind: "op", op: c });
        i++;
      }
      continue;
    }
    const w = word();
    if (w.text === "" && !w.quoted && c === "~") w.tilde = true;
    if (c === "*" || c === "?" || c === "[") w.glob = true;
    w.text += c;
    i++;
  }
  endWord();
  return { tokens, subs };
}

interface Simple {
  kind: "simple";
  words: Word[];
  heredoc: string | null;
  /** Vorgänger in einer Pipe (`echo … | bash`). */
  pipedFrom: Simple | null;
}
type Item = Simple | { kind: "push" } | { kind: "pop" };

function split(tokens: Token[]): Item[] {
  const items: Item[] = [];
  let cur: Simple = { kind: "simple", words: [], heredoc: null, pipedFrom: null };
  let skipNext = false;
  let hereNext = false;
  const flush = (pipe: boolean) => {
    const prev = cur;
    if (prev.words.length > 0 || prev.heredoc !== null) items.push(prev);
    cur = { kind: "simple", words: [], heredoc: null, pipedFrom: pipe && prev.words.length > 0 ? prev : null };
  };
  for (const tk of tokens) {
    if (tk.kind === "word") {
      if (hereNext) {
        cur.heredoc = tk.text;
        hereNext = false;
      } else if (skipNext) skipNext = false;
      else cur.words.push(tk);
    } else if (tk.kind === "redir") {
      if (tk.op === "<<<") hereNext = true;
      else skipNext = true;
    } else if (tk.kind === "heredoc") cur.heredoc = tk.body;
    else if (tk.op === "(" || tk.op === ")") {
      flush(false);
      items.push({ kind: tk.op === "(" ? "push" : "pop" });
    } else flush(tk.op === "|" || tk.op === "|&");
  }
  flush(false);
  return items;
}

// ───────────────────────────── Hilfen ─────────────────────────────

interface Ctx {
  cwd: string | null;
  /** `null` = unbekannt (z. B. nach `git checkout -`). */
  branch: string | null;
  branchKnown: boolean;
  worktreeRoot: string | null;
  env: Record<string, string | undefined>;
  auftrag: string | null;
  /** Befehl läuft auf dem Produktionsserver (ssh) bzw. in einem Container (docker exec). */
  remote: "ssh" | "container" | null;
  depth: number;
  /** Shell-Variablen aus `X=…` / `export X=…` früher in derselben Kette (für `$X push`). */
  vars: Record<string, string>;
  /** git-Aliase aus `git config alias.x …` früher in derselben Kette. */
  gitAliases: Record<string, string>;
  /** Produktionsserver (klein geschrieben), s. `GuardInput.prodHosts`. */
  prodHosts: readonly string[];
}

const MAX_DEPTH = 8;
const MAIN_NAMES = new Set(["main", "master", "refs/heads/main", "refs/heads/master"]);
const isMain = (b: string | null | undefined) => !!b && MAIN_NAMES.has(b.replace(/^\+/, ""));

const TMP_ROOTS = [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"])];

function norm(p: string): string {
  const x = foldCase(posix.normalize(p));
  return x.length > 1 ? x.replace(/\/+$/, "") : x;
}

/** Liegt `child` in `root`? `strict` = nicht der Ordner selbst. Groß/klein nur auf macOS egal. */
function inside(child: string, root: string, strict: boolean): boolean {
  const c = norm(child);
  const r = norm(root);
  if (c === r) return !strict;
  return c.startsWith(r === "/" ? "/" : r + "/");
}

/** Produktionsserver aus einer Komma-Liste (`NYXOS_PROD_HOSTS`). */
export function parseProdHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0 && h.length <= 255 && !/\s/.test(h));
}

/** Ist `target` (`host`, `user@host`, `host:pfad`) einer der Produktionsserver? `*.domain` passt auf Unter-Domains. */
function isProdHost(target: string, ctx: Ctx): boolean {
  if (ctx.prodHosts.length === 0) return false;
  const host = target.replace(/^[^@/\s]+@/, "").replace(/:.*$/, "").toLowerCase();
  if (!host) return false;
  return ctx.prodHosts.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) || host === p.slice(2) : host === p));
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

const texts = (ws: Word[]) => ws.map((w) => w.text);
const baseName = (s: string) => posix.basename(s);

function hit(rule: GuardRule, reason: string): GuardHit {
  return { rule, reason };
}

/** Löst ein Pfad-Wort auf. `null` = nicht sicher auflösbar. */
function resolveWord(w: Word, cwd: string | null, env: Record<string, string | undefined>): string | null {
  if (w.dynamic) return null;
  let p = w.text;
  if (w.tilde) {
    if (!env.HOME) return null;
    if (p === "~" || p.startsWith("~/")) p = env.HOME + p.slice(1);
    else return null;
  }
  if (p.startsWith("/")) return posix.normalize(p);
  if (!cwd) return null;
  return posix.resolve(cwd, p);
}

/**
 * Prüft ein Lösch-Ziel. `allowRoot` = die Worktree selbst ist als Ordner ok (git clean, find -delete
 * löschen nur darin), sonst muss das Ziel echt darunter liegen. Gibt einen Grund zurück, wenn blockiert.
 */
function deleteTargetProblem(w: Word, ctx: Ctx, allowRoot: boolean): string | null {
  if (w.dynamic) return t("Ziel „{text}\" enthält eine Variable und ist nicht prüfbar", { text: w.text });
  let target: Word = w;
  let strict = !allowRoot;
  if (w.glob) {
    if (w.text.includes("..")) return t("Glob „{text}\" geht über „..“ hinaus", { text: w.text });
    const firstGlob = w.text.search(/[*?[]/);
    const dir = w.text.slice(0, w.text.lastIndexOf("/", firstGlob) + 1) || ".";
    target = { ...w, text: dir, glob: false };
    strict = false; // Glob trifft nur Einträge IN diesem Ordner
  }
  const abs = resolveWord(target, ctx.cwd, ctx.env);
  if (!abs) return t("Ziel „{text}\" ist nicht sicher auflösbar", { text: w.text });
  if (ctx.worktreeRoot && inside(abs, ctx.worktreeRoot, strict)) return null;
  if (TMP_ROOTS.some((r) => inside(abs, r, true))) return null;
  return ctx.worktreeRoot ? t("„{abs}\" liegt außerhalb der Worktree ({root})", { abs, root: ctx.worktreeRoot }) : t("„{abs}\" liegt außerhalb der Worktree", { abs });
}

// ───────────────────────────── Analyse ─────────────────────────────

function analyzeScript(src: string, ctx: Ctx): GuardHit | null {
  if (ctx.depth > MAX_DEPTH || !src.trim()) return null;
  const inner: Ctx = { ...ctx, depth: ctx.depth + 1 };
  const lexed = lex(src, ctx.env);
  for (const sub of lexed.subs) {
    const h = analyzeScript(sub, { ...inner });
    if (h) return h;
  }
  const stack: Pick<Ctx, "cwd" | "branch" | "branchKnown">[] = [];
  for (const item of split(lexed.tokens)) {
    if (item.kind === "push") stack.push({ cwd: inner.cwd, branch: inner.branch, branchKnown: inner.branchKnown });
    else if (item.kind === "pop") {
      const s = stack.pop();
      if (s) Object.assign(inner, s);
    } else {
      const h = analyzeSimple(item, inner);
      if (h) return h;
    }
  }
  return null;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "!", "{", "}", "time", "case", "esac", "in", "select", "function"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const NET = new Set(["curl", "wget", "http", "https", "xh", "httpie"]);
const CODE_RUNNERS = new Set(["node", "deno", "python", "python2", "python3", "ruby", "perl", "tsx", "ts-node"]);
const isCodeRunner = (b: string) => CODE_RUNNERS.has(b) || /^python\d+(?:\.\d+)*$/.test(b);

// ─── „nicht prüfbar → fragen“ ───
// Eine Leitplanke, keine Sandbox: Was die Regeln nicht lesen können (Skript-Datei, Makefile, Paket-Skript,
// Alias aus .git/config, Interpreter-Code mit Systemzugriff), verlangt eine Freigabe. Ausnahme ist eine
// kleine, begründete Erlaubt-Liste für normales Arbeiten (Tests, Typprüfung, Lint, Build, Installieren).

const unchecked = (reason: string): GuardHit => hit("unchecked", reason);

/** Paket-Skripte, die in einer Coding-Session ständig laufen (Tests/Typprüfung/Lint/Build/Dev-Server). */
const ALLOWED_SCRIPTS = new Set(["test", "lint", "typecheck", "build", "format", "check", "dev", "start", "probe", "e2e", "db:generate"]);
/** Bekannte Paket-Programme: werden wie ein normaler Befehl weiter geprüft (drizzle-kit migrate, tsx datei …). */
const KNOWN_TOOLS = new Set(["vitest", "tsc", "eslint", "prettier", "playwright", "drizzle-kit", "tsx", "ts-node", "vite", "node", "jest", "biome"]);
/** System-Programme mit Pfad (`/usr/bin/git`) sind keine Skripte des Auftrags. */
const SYSTEM_BIN = /^\/(?:usr\/(?:local\/)?)?s?bin\/|^\/opt\/homebrew\/s?bin\/|^\/usr\/libexec\//;
const TASK_RUNNERS = new Set(["make", "gmake", "bmake", "just", "rake", "fastlane", "invoke", "mage"]);
const DEPLOY_SCRIPT = /^deploy[\w.-]*\.sh$/;
/** Skripte, die eine Datenbank neu aufsetzen oder migrieren (z. B. `deploy_db.sh`, `reset-db.sh`). */
const DB_SCRIPT = /^(?:deploy|reset|migrate)[\w.-]*db[\w.-]*\.sh$/i;
const SAFE_PROGRAMS = new Set(["", "cat", "less", "more", "true", ":", "vi", "vim", "nvim", "nano", "less -R", "less -FRX"]);

/** Umgebungsvariablen, mit denen ein harmlos aussehender Befehl fremden Code oder fremde git-Konfiguration lädt. */
function riskyEnv(name: string, value: string): string | null {
  if (/^GIT_CONFIG(?:_COUNT|_KEY_\d+|_VALUE_\d+|_PARAMETERS|_GLOBAL|_SYSTEM|_NOSYSTEM)?$/.test(name)) return t("{name} schiebt git eine Konfiguration unter (z. B. Aliase) – nicht prüfbar", { name });
  if (["GIT_EXEC_PATH", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF", "BASH_ENV", "ENV", "PROMPT_COMMAND", "LD_PRELOAD", "PATH"].includes(name) || name.startsWith("DYLD_")) {
    return t("{name}=… lässt fremde Befehle oder fremden Code laden – nicht prüfbar", { name });
  }
  if (["GIT_PAGER", "PAGER", "GIT_EDITOR", "EDITOR", "VISUAL", "GIT_SEQUENCE_EDITOR"].includes(name) && !SAFE_PROGRAMS.has(value.trim())) return t("{name}={value} startet einen beliebigen Befehl", { name, value: value.slice(0, 60) });
  if (name === "NODE_OPTIONS" && /(?:^|\s)(?:-r|--require|--import|--loader|--experimental-loader)\b/.test(value)) return t("NODE_OPTIONS lädt vor jedem node-Aufruf fremden Code");
  return null;
}

/** Wort ist komplett variabel (`$X`, `${X}`, `$(…)`, Backticks): der Inhalt steht erst beim Ausführen fest. */
const wholeDynamic = (w: Word) => w.dynamic && /^(?:\$\{?[\w@*#?$!-]+\}?|\$\(…\)|`…`|<\(…\))$/.test(w.text);

/** Eine Datei wird als Programm ausgeführt (`bash x.sh`, `./x.sh`, `source x.sh`). */
function scriptFileHit(w: Word, ctx: Ctx, how: string): GuardHit {
  const b = baseName(w.text);
  if (DB_SCRIPT.test(b)) return hit("migration", t("{b} setzt eine Datenbank neu auf", { b }));
  if (DEPLOY_SCRIPT.test(b)) return hit("deploy", t("{text} startet einen Deploy", { text: w.text }));
  if (ctx.remote === "ssh") return hit("deploy", t("{how} {text} läuft auf dem Produktionsserver", { how, text: w.text }));
  return unchecked(t("{how} führt die Datei {text} aus – ihr Inhalt ist nicht prüfbar", { how, text: w.text.slice(0, 120) }));
}
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "srm"]);
const PSQL_LIKE = new Set(["psql", "pg_restore", "dropdb", "createdb"]);

interface Unwrapped {
  words: Word[];
  assign: Record<string, string>;
  fromXargs: boolean;
}

/** Entfernt Schlüsselwörter, Variablen-Zuweisungen und Hüllen wie sudo/env/timeout/xargs. */
function unwrap(words: Word[]): Unwrapped {
  const ws = words.slice();
  const assign: Record<string, string> = {};
  let fromXargs = false;
  const skipOpts = (valued: Set<string>) => {
    while (ws.length > 0 && (ws[0] as Word).text.startsWith("-") && (ws[0] as Word).text.length > 1) {
      const o = (ws.shift() as Word).text;
      if (o === "--") break;
      if (valued.has(o)) ws.shift();
    }
  };
  for (let guard = 0; guard < 50 && ws.length > 0; guard++) {
    const w = ws[0] as Word;
    const tk = w.text;
    if (!w.quoted && KEYWORDS.has(tk)) {
      ws.shift();
      continue;
    }
    // Auch `X="…"` (Wert in Anführungszeichen) ist eine Zuweisung – sonst rutscht z. B.
    // GIT_CONFIG_PARAMETERS="'alias.p=push'" als vermeintlicher Befehlsname durch.
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(tk);
    if (m) {
      assign[m[1] as string] = w.dynamic ? "$?" : (m[2] as string);
      ws.shift();
      continue;
    }
    const b = baseName(tk);
    if (b === "sudo" || b === "doas") {
      ws.shift();
      skipOpts(new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t"]));
      continue;
    }
    if (b === "env") {
      ws.shift();
      // `env -S 'git push'` zerlegt den Text selbst in einen Befehl.
      while (ws.length > 0 && (ws[0] as Word).text.startsWith("-") && (ws[0] as Word).text.length > 1) {
        const o = (ws.shift() as Word).text;
        if (o === "--") break;
        let split: string | null = null;
        if (o === "-S" || o === "--split-string") split = ws.shift()?.text ?? "";
        else if (o.startsWith("--split-string=")) split = o.slice(15);
        else if (o.startsWith("-S")) split = o.slice(2);
        else if (["-u", "-C", "--unset", "--chdir"].includes(o)) ws.shift();
        if (split !== null) {
          ws.unshift(...lex(split, {}).tokens.filter((tk): tk is Word => tk.kind === "word"));
          break;
        }
      }
      continue;
    }
    if (b === "command" || b === "builtin" || b === "exec" || b === "nohup" || b === "stdbuf" || b === "caffeinate" || b === "unbuffer") {
      ws.shift();
      skipOpts(new Set(["-a", "-t", "-w"]));
      continue;
    }
    if (b === "nice") {
      ws.shift();
      skipOpts(new Set(["-n"]));
      continue;
    }
    if (b === "timeout" || b === "gtimeout") {
      ws.shift();
      skipOpts(new Set(["-s", "-k", "--signal", "--kill-after"]));
      ws.shift(); // Dauer
      continue;
    }
    if (b === "xargs") {
      ws.shift();
      fromXargs = true;
      skipOpts(new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--delimiter", "--max-args", "--max-procs"]));
      continue;
    }
    break;
  }
  return { words: ws, assign, fromXargs };
}

function analyzeSimple(cmd: Simple, ctx: Ctx): GuardHit | null {
  const { words, assign, fromXargs } = unwrap(cmd.words);
  for (const [k, v] of Object.entries(assign)) {
    const risk = riskyEnv(k, v);
    if (risk) return unchecked(risk);
  }
  if (words.length === 0) {
    // `G=git;` allein: gilt für die folgenden Befehle der Kette.
    for (const [k, v] of Object.entries(assign)) if (v !== "$?") ctx.vars[k] = v;
    return null;
  }
  const head = words[0] as Word;
  const name = head.text;
  const b = baseName(name);
  const args = words.slice(1);
  const at = texts(args);

  if (["export", "declare", "typeset", "local", "readonly"].includes(b)) {
    for (const w of args) {
      if (w.text.startsWith("-")) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/s.exec(w.text);
      if (!m) continue;
      const risk = riskyEnv(m[1] as string, m[2] === undefined || w.dynamic ? "$?" : m[2]);
      if (risk) return unchecked(risk);
      if (m[2] !== undefined && !w.dynamic) ctx.vars[m[1] as string] = m[2];
    }
    return null;
  }

  // Befehlsname aus einer Variable: bekannte Zuweisung einsetzen, sonst nach dem Rest beurteilen.
  if (head.dynamic) {
    const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(name);
    const value = v ? ctx.vars[v[1] as string] : undefined;
    if (value !== undefined) return analyzeScript([value, ...at.map(shellQuote)].join(" "), ctx);
    return guessDynamicCommand(name, args, ctx);
  }

  // Verzeichniswechsel verfolgen (für Lösch-Ziele und „welcher Zweig").
  if (b === "cd" || b === "pushd") {
    const target = args.find((w) => !["-P", "-L", "-e", "-@"].includes(w.text));
    if (!target) ctx.cwd = ctx.env.HOME ?? null;
    else if (target.text === "-") ctx.cwd = null;
    else ctx.cwd = resolveWord(target, ctx.cwd, ctx.env);
    return null;
  }
  if (b === "popd") {
    ctx.cwd = null;
    return null;
  }

  // Shell-in-Shell: `bash -c "…"`, `bash <<EOF`, `echo … | bash`, eval sind lesbar; eine Skript-Datei
  // (`bash x.sh`, `source x.sh`) oder eine Eingabe aus Datei/Pipe (`bash < x.sh`, `curl … | sh`) nicht.
  if (SHELLS.has(b)) {
    for (let i = 0; i < args.length; i++) {
      const w = args[i] as Word;
      const a = w.text;
      if (a === "-o" || a === "-O" || a === "+o" || a === "+O") {
        i++;
        continue;
      }
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
        const script = args[i + 1];
        if (!script) return null;
        if (wholeDynamic(script)) return unchecked(t("{b} -c mit variablem Skript ({text}) ist nicht prüfbar", { b, text: script.text }));
        return analyzeScript(script.text, ctx);
      }
      if (a === "--version" || a === "--help") return null;
      if (a.startsWith("-") || a.startsWith("+")) continue;
      return scriptFileHit(w, ctx, b);
    }
    if (cmd.heredoc !== null) return analyzeScript(cmd.heredoc, ctx);
    if (fromXargs) return unchecked(t("xargs {b}: das Skript kommt aus einer Liste – nicht prüfbar", { b }));
    const prev = cmd.pipedFrom ? unwrap(cmd.pipedFrom.words).words : [];
    if (prev.length > 0 && ["echo", "printf"].includes(baseName((prev[0] as Word).text))) {
      const piped = texts(prev.slice(1).filter((w) => !w.text.startsWith("-"))).join(" ");
      return analyzeScript(piped.replace(/\\n/g, "\n").replace(/\\t/g, "\t"), ctx);
    }
    if (ctx.remote === "ssh") return hit("deploy", t("{b} auf dem Produktionsserver liest sein Skript aus einer Datei/Eingabe – nicht prüfbar", { b }));
    return unchecked(t("{b} liest sein Skript aus einer Datei oder Eingabe – Inhalt nicht prüfbar", { b }));
  }
  if (b === "eval") {
    if (args.some(wholeDynamic)) return unchecked(t("eval mit variablem Inhalt ist nicht prüfbar"));
    return analyzeScript(at.join(" "), ctx);
  }
  if (b === "source" || b === ".") return args[0] ? scriptFileHit(args[0], ctx, b) : null;
  // Befehlstexte, die die Shell später ausführt: Inhalt lesen (zsh expandiert Aliase auch ohne Terminal).
  if (b === "alias" || b === "trap" || b === "watch") {
    const bodies = b === "alias" ? args.map((w) => /^[^=]+=(.*)$/s.exec(w.text)?.[1]).filter((x): x is string => x !== undefined) : b === "trap" ? args.slice(0, 1).map((w) => w.text) : [texts(args.slice(skipValued(args, 0, new Set(["-n", "--interval", "-d"])))).join(" ")];
    for (const body of bodies) {
      const h = analyzeScript(body, ctx);
      if (h) return h;
    }
    return args.some(wholeDynamic) ? unchecked(t("{b} mit variablem Befehl – nicht prüfbar", { b })) : null;
  }
  if (b === "parallel") return unchecked(t("parallel liest die auszuführenden Befehle aus einer Liste – nicht prüfbar"));

  if (DB_SCRIPT.test(b)) return hit("migration", t("{b} setzt eine Datenbank neu auf", { b }));
  if (PSQL_LIKE.has(b)) return analyzePsql(b, args, assign, ctx);

  if (ctx.remote === "ssh") {
    if (b === "docker" || b === "docker-compose") {
      const h = analyzeDocker(b, args, ctx);
      if (h) return h;
    }
    if (isReadOnlyRemote(b, args)) return null;
    return hit("deploy", t("„{cmd}\" verändert etwas auf dem Produktionsserver", { cmd: [name, ...at].join(" ").slice(0, 120) }));
  }

  if (b === "git") return analyzeGit(args, ctx);
  if (b === "gh") return analyzeGh(args);
  if (DEPLOY_SCRIPT.test(b) || (b === "deploy" && name.includes("/"))) return hit("deploy", t("{name} startet einen Deploy", { name }));
  if (b === "docker" || b === "docker-compose" || b === "podman") return analyzeDocker(b, args, ctx);
  if (b === "ssh") return analyzeSsh(args, cmd, ctx);
  if (b === "ssh.sh") return remoteCommand(args, cmd, ctx, "scripts/ssh.sh");
  if (b === "sftp") {
    const host = args.find((w) => !w.text.startsWith("-"));
    return host && isProdHost(host.text, ctx) ? hit("deploy", t("sftp auf den Produktionsserver")) : null;
  }
  if (b === "rsync" || b === "scp") return analyzeCopy(b, args, ctx);
  if (b === "mv") return analyzeMove(args, ctx);
  if (b === "drizzle-kit") {
    const sub = at.find((tk) => !tk.startsWith("-"));
    return sub && ["migrate", "push", "drop", "up"].includes(sub) ? hit("migration", t("drizzle-kit {sub} verändert ein Datenbank-Schema", { sub })) : null;
  }
  if (["npx", "pnpx", "bunx", "pnpm", "npm", "yarn", "bun"].includes(b)) return analyzeRunner(b, args, cmd, ctx);

  // Eine Datei mit Pfad als Programm (`./p.sh`, `scripts/x`): Inhalt unbekannt.
  if (name.includes("/") && !SYSTEM_BIN.test(name) && !KNOWN_TOOLS.has(b) && !isCodeRunner(b)) return scriptFileHit(head, ctx, "Der Aufruf");

  if (TASK_RUNNERS.has(b)) return unchecked(t("{b} führt Befehle aus einer Datei aus (Makefile, Fastfile …) – Inhalt nicht prüfbar", { b }));
  if (b === "xcodebuild") return at.includes("-exportArchive") ? hit("deploy", t("xcodebuild -exportArchive kann die App zu App Store Connect hochladen")) : null;
  if (b === "xcrun") return analyzeXcrun(args, cmd, ctx);
  if (b === "osascript") return unchecked(t("osascript kann beliebige Programme und Shell-Befehle steuern – nicht prüfbar"));
  if (b === "tmux") return analyzeTmux(args);
  if (["script", "screen", "expect", "at", "batch", "unbuffer"].includes(b)) return unchecked(t("{b} startet Befehle in einer eigenen Sitzung – nicht prüfbar", { b }));
  if (b === "launchctl") {
    const sub = at.find((tk) => !tk.startsWith("-")) ?? "";
    return ["load", "bootstrap", "submit", "kickstart", "start", "enable", "asuser"].includes(sub) ? unchecked(t("launchctl {sub} startet einen Hintergrund-Dienst – nicht prüfbar", { sub })) : null;
  }
  if (b === "crontab") return at.includes("-l") ? null : unchecked(t("crontab richtet zeitgesteuerte Befehle ein – nicht prüfbar"));
  if (b === "claude" || b === "codex") {
    if (at.length > 0 && at.every((tk) => ["--version", "-v", "--help", "-h"].includes(tk))) return null;
    return unchecked(t("ein verschachteltes {b} arbeitet ohne diese Leitplanke – nicht prüfbar", { b }));
  }

  if (DELETERS.has(b)) return analyzeDelete(b, args, fromXargs, ctx);
  if (b === "find") return analyzeFind(args, cmd, ctx);

  if (NET.has(b)) return analyzeApiCall(at.join(" ")) ?? analyzeHttpWrite(b, args);
  if (isCodeRunner(b)) return analyzeInterpreter(b, args, cmd);
  if (b === "awk" || b === "gawk" || b === "mawk" || b === "nawk") return analyzeAwk(b, args);
  if (b === "sed" || b === "gsed") return analyzeSed(b, args);
  return null;
}

/** `xcrun altool --upload-app` lädt in den App Store; sonst das eigentliche Werkzeug prüfen. */
function analyzeXcrun(args: Word[], cmd: Simple, ctx: Ctx): GuardHit | null {
  const i = skipValued(args, 0, new Set(["--sdk", "-sdk", "--toolchain", "-toolchain"]));
  const tool = args[i]?.text ?? "";
  const rest = texts(args.slice(i + 1));
  if (tool === "altool" && rest.some((tk) => /^--upload-(?:app|package)$/.test(tk))) return hit("deploy", t("xcrun altool lädt die App zu App Store Connect hoch"));
  if (tool === "iTMSTransporter") return hit("deploy", t("iTMSTransporter lädt die App zu App Store Connect hoch"));
  return args.length > i ? analyzeSimple({ ...cmd, words: args.slice(i), heredoc: null }, ctx) : null;
}

const TMUX_READ = new Set(["ls", "list-sessions", "list-windows", "list-panes", "list-clients", "capture-pane", "has-session", "has", "display-message", "display", "show-options", "show", "show-environment", "info", "list-keys", "list-buffers", "show-buffer", "-V"]);
/** tmux: lesen ja; alles, was Befehle in einer Sitzung ausführt oder Tasten schickt, ist nicht prüfbar. */
function analyzeTmux(args: Word[]): GuardHit | null {
  for (let i = 0; i < args.length; i++) {
    const tk = (args[i] as Word).text;
    if (tk === "-c") return unchecked(t("tmux -c führt einen Shell-Befehl aus – nicht prüfbar"));
    if (["-L", "-S", "-f", "-T"].includes(tk)) {
      i++;
      continue;
    }
    if (tk === "-V") return null;
    if (tk.startsWith("-")) continue;
    return TMUX_READ.has(tk) ? null : unchecked(t("tmux {arg} kann Befehle in einem Terminal ausführen oder Tasten schicken – nicht prüfbar", { arg: tk }));
  }
  return unchecked(t("tmux ohne Unterbefehl öffnet eine Sitzung – nicht prüfbar"));
}

const PY_OK_MODULES = new Set(["json", "sys", "re", "math", "datetime", "collections", "itertools", "functools", "statistics", "textwrap", "string", "csv", "pprint", "decimal", "fractions", "random", "operator", "time", "base64", "hashlib", "uuid", "unicodedata"]);
const PY_BAD = /__|\b(?:exec|eval|compile|open|getattr|setattr|delattr|globals|locals|vars|breakpoint|input|importlib|subprocess|os|shutil|socket|urllib|requests|http|pty|ctypes|pickle|marshal|builtins|system|popen|spawn|pathlib|tempfile|signal|threading|multiprocessing|asyncio|modules)\b/;
const JS_BAD = /\b(?:require|import|process|global|globalThis|eval|Function|constructor|prototype|__proto__|fetch|Bun|Deno|Reflect|Proxy|WebAssembly|setTimeout|setInterval|setImmediate|module|exports|XMLHttpRequest|WebSocket|Worker|child_process)\b|\[\s*['"`]|\\u|\\x/;
const PERL_BAD = /[`]|\b(?:system|exec|qx|open|sysopen|eval|require|use|do|fork|kill|unlink|rename|syscall|pipe|readpipe|chdir|mkdir|rmdir|socket|glob|symlink|link|chmod|chown)\b|%ENV|\/[msixpodualngcr]*e[msixpodualngcr]*\s*(?:;|$|\})/;
const PY_MODULE_OK = new Set(["json.tool", "pytest", "unittest", "pip", "venv", "py_compile", "doctest", "timeit"]);

/** Reiner Rechen-/Text-Einzeiler ohne Systemzugriff? (sonst: nicht prüfbar → fragen) */
function simpleCode(lang: "python" | "js" | "perl" | "other", code: string): boolean {
  if (lang === "python") {
    if (PY_BAD.test(code)) return false;
    for (const m of code.matchAll(/\bimport\s+([\w.]+(?:\s*,\s*[\w.]+)*)|\bfrom\s+([\w.]+)\s+import\b/g)) {
      const mods = (m[1] ?? m[2] ?? "").split(",").map((s) => s.trim().split(".")[0] ?? "");
      if (mods.some((x) => !PY_OK_MODULES.has(x))) return false;
    }
    return true;
  }
  if (lang === "js") return !JS_BAD.test(code);
  if (lang === "perl") return !PERL_BAD.test(code);
  return false;
}

/** node/python/ruby/perl/tsx: Datei oder Code von der Eingabe = nicht prüfbar; Einzeiler nur ohne Systemzugriff. */
function analyzeInterpreter(b: string, args: Word[], cmd: Simple): GuardHit | null {
  const lang = b.startsWith("python") ? "python" : b === "perl" ? "perl" : ["node", "tsx", "ts-node"].includes(b) ? "js" : "other";
  let code: string | null = null;
  let file: Word | null = null;
  let mod: string | null = null;
  let fromStdin = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as Word;
    const tk = w.text;
    if (tk === "--") {
      file = args[i + 1] ?? null;
      break;
    }
    if (tk === "-") {
      fromStdin = true;
      break;
    }
    if (!tk.startsWith("-")) {
      file = w;
      break;
    }
    if (["--version", "-v", "-V", "--help", "-h"].includes(tk)) return null;
    if (lang === "python" && tk === "-c") {
      code = args[i + 1]?.text ?? "";
      break;
    }
    if (lang === "python" && /^-c./.test(tk)) {
      code = tk.slice(2);
      break;
    }
    if (lang === "python" && tk === "-m") {
      mod = args[i + 1]?.text ?? "";
      break;
    }
    if (lang === "js" && ["-e", "--eval", "-p", "--print"].includes(tk)) {
      code = args[i + 1]?.text ?? "";
      break;
    }
    if (lang === "js" && /^--(?:eval|print)=/.test(tk)) {
      code = tk.slice(tk.indexOf("=") + 1);
      break;
    }
    if (lang === "js" && ["-r", "--require", "--import", "--loader", "--experimental-loader"].includes(tk)) return unchecked(t("{b} {arg} lädt vorab eine Code-Datei – nicht prüfbar", { b, arg: tk }));
    if ((lang === "perl" || b === "ruby") && /^-[A-Za-z0-9]*[eE]$/.test(tk)) {
      code = args[i + 1]?.text ?? "";
      break;
    }
    if (lang === "python" && ["-W", "-X", "-Q"].includes(tk)) i++;
  }
  if (mod !== null) return PY_MODULE_OK.has(mod) ? null : unchecked(t("{b} -m {mod} führt ein Modul aus – nicht geprüft", { b, mod }));
  if (code === null && file === null) {
    if (cmd.heredoc === null) return unchecked(t("{b} liest sein Programm von der Eingabe – nicht prüfbar", { b }));
    code = cmd.heredoc;
    fromStdin = true;
  }
  if (code === null) return unchecked(t("{b} führt die Datei {text} aus – ihr Inhalt ist nicht prüfbar", { b, text: (file as Word).text.slice(0, 120) }));
  const specific = analyzeCode(code);
  if (specific) return specific;
  if (b === "ruby" || lang === "other") return unchecked(t("{b}-Code ist nicht prüfbar", { b }));
  return simpleCode(lang, code) ? null : unchecked(fromStdin ? t("{b}-Programm mit Systemzugriff oder unklarem Code – nicht prüfbar", { b }) : t("{b}-Einzeiler mit Systemzugriff oder unklarem Code – nicht prüfbar", { b }));
}

/** awk: `system()`, Pipes (`print | "sh"`, `"cmd" | getline`), `@load` oder Programm aus Datei = nicht prüfbar. */
function analyzeAwk(b: string, args: Word[]): GuardHit | null {
  for (let i = 0; i < args.length; i++) {
    const tk = (args[i] as Word).text;
    if (tk === "-f" || tk === "--file" || tk.startsWith("--file=") || /^-f./.test(tk) || tk === "-E" || tk === "--exec") return unchecked(t("{b} liest sein Programm aus einer Datei – nicht prüfbar", { b }));
    if (tk === "-v" || tk === "-F" || tk === "--assign" || tk === "--field-separator") {
      i++;
      continue;
    }
    if (tk === "--") continue;
    if (tk.startsWith("-")) continue;
    if (/\bsystem\s*\(|(?:^|[^|])\|(?!\|)|@load|\bgetline\b.*\|/.test(tk)) return analyzeCode(tk) ?? unchecked(t("{b}-Programm startet Befehle (system/Pipe) – nicht prüfbar", { b }));
    return null;
  }
  return null;
}

/** GNU sed kann mit dem Befehl `e` bzw. dem s-Schalter `e` Befehle ausführen. */
function analyzeSed(b: string, args: Word[]): GuardHit | null {
  const scripts: string[] = [];
  let explicit = false;
  let firstPos: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const tk = (args[i] as Word).text;
    if (tk === "-e" || tk === "--expression") {
      scripts.push(args[++i]?.text ?? "");
      explicit = true;
    } else if (tk.startsWith("--expression=")) {
      scripts.push(tk.slice(13));
      explicit = true;
    } else if (tk === "-f" || tk === "--file" || tk.startsWith("--file=")) return unchecked(t("{b} liest sein Programm aus einer Datei – nicht prüfbar", { b }));
    else if (tk === "-i" && args[i + 1]?.text === "") i++;
    else if (!tk.startsWith("-") && firstPos === null) firstPos = tk;
  }
  if (!explicit && firstPos !== null) scripts.push(firstPos);
  for (const s of scripts) {
    const eCommand = /(?:^|[;\n{}])\s*(?:\d+|\$|\/[^/]*\/)?(?:,(?:\d+|\$|\/[^/]*\/))?\s*!?\s*e(?:\s|;|\}|$)/.test(s);
    let eFlag = false;
    for (const m of s.matchAll(/s([^\s\w\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1([A-Za-z0-9]*)/g)) if ((m[2] ?? "").includes("e")) eFlag = true;
    if (eCommand || eFlag) return unchecked(t("{b} mit „e“ führt Befehle aus – nicht prüfbar", { b }));
  }
  return null;
}

/** Schreibende HTTP-Anfrage (Methode ≠ GET oder mit Körper) an GitHub. */
function analyzeHttpWrite(b: string, args: Word[]): GuardHit | null {
  const at = texts(args);
  if (b === "curl" && at.some((tk) => tk === "-K" || tk === "--config" || /^-K./.test(tk) || tk.startsWith("--config="))) return unchecked(t("curl -K liest Adresse und Methode aus einer Datei – nicht prüfbar"));
  let method: string | null = null;
  let body = false;
  const urls: string[] = [];
  const CURL_VALUED = /^(?:-H|--header|-u|--user|-o|--output|-A|--user-agent|-e|--referer|-b|--cookie|-c|--cookie-jar|-w|--write-out|--connect-timeout|-m|--max-time|--retry|-x|--proxy|--resolve|--cacert|-E|--cert|--key|-r|--range|-U|--proxy-user)$/;
  for (let i = 0; i < at.length; i++) {
    const tk = at[i] as string;
    if (b === "curl") {
      if (tk === "-X" || tk === "--request") {
        method = (at[++i] ?? "").toUpperCase();
        continue;
      }
      if (/^-X./.test(tk)) {
        method = tk.slice(2).toUpperCase();
        continue;
      }
      if (tk.startsWith("--request=")) {
        method = tk.slice(10).toUpperCase();
        continue;
      }
      if (/^(?:-d|--data(?:-binary|-raw|-urlencode|-ascii)?|--json|-F|--form(?:-string)?|-T|--upload-file)$/.test(tk)) {
        body = true;
        i++;
        continue;
      }
      if (/^-[dFT]./.test(tk) || /^--(?:data[\w-]*|json|form[\w-]*|upload-file)=/.test(tk)) {
        body = true;
        continue;
      }
      if (CURL_VALUED.test(tk)) {
        i++;
        continue;
      }
    } else if (b === "wget") {
      if (tk === "--method") {
        method = (at[++i] ?? "").toUpperCase();
        continue;
      }
      if (tk.startsWith("--method=")) {
        method = tk.slice(9).toUpperCase();
        continue;
      }
      if (/^--(?:post|body|put)-(?:data|file)(?:=|$)/.test(tk)) {
        body = true;
        if (!tk.includes("=")) i++;
        continue;
      }
      if (["-O", "-o", "-P", "--header", "-U", "--user-agent", "-e"].includes(tk)) {
        i++;
        continue;
      }
    } else {
      if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(tk)) {
        method = tk;
        continue;
      }
      if (/^[^-=:/][^=:]*(?:=|:=|@)/.test(tk) && !/^https?:/.test(tk)) body = true;
    }
    if (!tk.startsWith("-")) urls.push(tk);
  }
  const writes = method ? !["GET", "HEAD", "OPTIONS"].includes(method) : body;
  if (!writes) return null;
  const gh = urls.find((u) => /^(?:https?:\/\/)?(?:[\w-]+\.)*github(?:usercontent)?\.com(?:[:/]|$)/i.test(u));
  if (!gh) return null;
  if (MERGE_API.test(gh)) return hit("merge_main", t("{b} {method} {gh} führt auf GitHub zusammen bzw. verändert main", { b, method: method ?? "POST", gh: gh.slice(0, 100) }));
  return hit("github_write", t("{b} {method} an GitHub ({gh}) verändert etwas auf GitHub", { b, method: method ?? "POST", gh: gh.slice(0, 100) }));
}
const MERGE_API = /\/pulls\/[^/]+\/merge\b|\/merges\b|git\/refs\/heads\/(?:main|master)\b/;

/** Prozent-Kodierung auflösen (`%63lose` → `close`), kaputte Folgen stehen lassen. */
function percentDecode(text: string): string {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function analyzeApiCall(raw: string): GuardHit | null {
  const text = percentDecode(raw);
  if (/\/api\/sessions\/[^\s"'?]+\/close\b/.test(text)) return hit("session_close", t("Session wird über die NyxOS-API endgültig geschlossen"));
  if (/["']?stage["']?\s*[:=]\s*["']?erledigt/i.test(text)) return hit("entry_done", t("Aufgabe wird über die NyxOS-API auf „Erledigt“ gesetzt"));
  if (/\/api\/entries\b/.test(text) && /(?:^|\s)(?:-d|--data(?:-binary|-raw|-urlencode|-ascii)?|--json|-F|--form)\s*=?\s*@|(?:^|\s)(?:-T|--upload-file|--post-file|--body-file)\b/.test(text)) {
    return hit("entry_done", t("Änderung an einer Aufgabe mit Inhalt aus einer Datei – die Stufe ist nicht prüfbar"));
  }
  return null;
}

/** Code-Einzeiler (`python3 -c`, `node -e`, …): nach verdächtigen Aufrufen im Text suchen. */
function analyzeCode(raw: string): GuardHit | null {
  const api = analyzeApiCall(raw);
  if (api) return api;
  const tk = raw.replace(/[[\]'"(),;{}`]/g, " ").replace(/\s+/g, " ");
  if (/\bgit (?:\S+ )*?(?:push|send-pack)\b/.test(tk)) return hit("git_push", t("Code-Einzeiler ruft git push auf"));
  if (/\bgit (?:\S+ )*?(?:merge|rebase|reset|cherry-pick|update-ref|pull)\b/.test(tk)) return hit("merge_main", t("Code-Einzeiler ruft git merge/rebase/reset auf (Zweig nicht prüfbar)"));
  if (/\b(?:psql|pg_restore|dropdb|drizzle-kit)\b|\b(?:deploy|reset|migrate)[\w.-]*db[\w.-]*\.sh\b/i.test(tk)) return hit("migration", t("Code-Einzeiler greift auf eine Datenbank zu"));
  if (/\b(?:docker|docker-compose|ssh|scp|deploy\.sh)\b/.test(tk)) return hit("deploy", t("Code-Einzeiler ruft docker/ssh auf"));
  if (/\b(?:rmtree|rmSync|rmdirSync|unlinkSync|unlink|rmdir|remove_dir_all|remove_file|os\.remove|fs\.rm|FileUtils\.rm\w*)\b|\brm -|\brm \//.test(tk)) {
    return hit("delete_outside_worktree", t("Code-Einzeiler löscht Dateien – Ziel nicht prüfbar"));
  }
  return null;
}

const shellQuote = (tk: string) => (/^[\w./:@%+=,-]+$/.test(tk) ? tk : `'${tk.replace(/'/g, `'\\''`)}'`);

const PUSH_WORDS = new Set(["push", "send-pack"]);
const MERGE_WORDS = new Set(["merge", "rebase", "reset", "cherry-pick", "update-ref", "pull", "am", "revert"]);

/** Befehlsname aus unbekannter Variable (`$GIT push`): nach dem Rest beurteilen. */
function guessDynamicCommand(name: string, args: Word[], ctx: Ctx): GuardHit | null {
  const at = texts(args);
  const first = at.find((tk) => !tk.startsWith("-")) ?? "";
  const why = t("der Befehl kommt aus der Variable {name} und ist nicht prüfbar", { name });
  if (PUSH_WORDS.has(first) || (first === "subtree" && at.includes("push"))) return hit("git_push", t("„{first}“: {why}", { first, why }));
  if (MERGE_WORDS.has(first)) return hit("merge_main", t("„{first}“: {why}", { first, why }));
  if (["compose", "up", "down", "restart", "stop", "rm"].includes(first) && at.some((x) => ["up", "down", "restart", "stop", "rm", "run", "kill"].includes(x))) return hit("deploy", t("„{first}“: {why}", { first, why }));
  if (at.some((x) => /^-[A-Za-z]*[rRf]/.test(x))) {
    const h = analyzeDelete(name, args, false, ctx);
    if (h) return h;
  }
  return null;
}

const GH_KNOWN = new Set(["auth", "browse", "codespace", "cs", "gist", "issue", "org", "pr", "project", "release", "repo", "cache", "run", "workflow", "alias", "api", "attestation", "completion", "config", "extension", "ext", "extensions", "gpg-key", "label", "ruleset", "rs", "search", "secret", "ssh-key", "status", "variable", "help", "version", "co", "copilot", "agent-task", "preview"]);

/**
 * gh: Merge (`gh pr merge`, Merge-API) → merge_main; andere schreibende GitHub-Zugriffe (`gh api` mit
 * Methode ≠ GET oder Feldern, GraphQL-`mutation`, Releases, Workflows, Repo-Einstellungen) → github_write;
 * Aliase/Erweiterungen (unbekannter Unterbefehl) → nicht prüfbar.
 */
function analyzeGh(args: Word[]): GuardHit | null {
  const at = texts(args);
  const pos: string[] = [];
  for (let i = 0; i < at.length; i++) {
    const tk = at[i] as string;
    if (tk === "-R" || tk === "--repo" || tk === "--hostname") i++;
    else if (!tk.startsWith("-")) pos.push(tk);
  }
  const [sub, action] = pos;
  if (!sub) return null;
  if (!GH_KNOWN.has(sub)) return unchecked(t("„gh {sub}“ ist kein bekannter gh-Befehl (Alias oder Erweiterung) – Inhalt nicht prüfbar", { sub }));
  if (sub === "api") return analyzeGhApi(at);
  if (sub === "pr" && action === "merge") return hit("merge_main", t("gh pr merge führt einen Pull-Request zusammen"));
  if (sub === "alias" && (action === "set" || action === "import")) return unchecked(t("gh alias {action} legt einen eigenen gh-Befehl an – nicht prüfbar", { action }));
  if (["extension", "ext", "extensions"].includes(sub) && ["install", "exec", "upgrade", "create"].includes(action ?? "")) return unchecked(t("gh extension {action} startet fremden Code – nicht prüfbar", { action }));
  const w = (what: string) => hit("github_write", `gh ${sub} ${action} ${what}`);
  if (sub === "repo" && ["delete", "edit", "rename", "archive", "unarchive", "sync", "deploy-key"].includes(action ?? "")) return w(t("ändert das Repository auf GitHub"));
  if (sub === "release" && ["create", "delete", "upload", "edit", "delete-asset"].includes(action ?? "")) return w(t("ändert Releases auf GitHub"));
  if ((sub === "secret" || sub === "variable") && ["set", "delete", "remove"].includes(action ?? "")) return w(t("ändert Einstellungen auf GitHub"));
  if (sub === "workflow" && ["run", "enable", "disable"].includes(action ?? "")) return w(t("startet oder ändert einen GitHub-Workflow (evtl. Deploy)"));
  if (sub === "run" && ["rerun", "cancel", "delete"].includes(action ?? "")) return w(t("ändert einen GitHub-Workflow-Lauf"));
  return null;
}

function analyzeGhApi(at: string[]): GuardHit | null {
  let method: string | null = null;
  let fields = false;
  let input = false;
  let path: string | null = null;
  const values: string[] = [];
  for (let i = 0; i < at.length; i++) {
    const tk = at[i] as string;
    if (tk === "-X" || tk === "--method") method = (at[++i] ?? "").toUpperCase();
    else if (tk.startsWith("--method=")) method = tk.slice(9).toUpperCase();
    else if (/^-X./.test(tk)) method = tk.slice(2).toUpperCase();
    else if (["-f", "-F", "--field", "--raw-field"].includes(tk)) {
      fields = true;
      values.push(at[++i] ?? "");
    } else if (/^-[fF]./.test(tk)) {
      fields = true;
      values.push(tk.slice(2));
    } else if (/^--(?:raw-)?field=/.test(tk)) {
      fields = true;
      values.push(tk.slice(tk.indexOf("=") + 1));
    } else if (tk === "--input" || tk.startsWith("--input=")) {
      input = true;
      if (tk === "--input") i++;
    } else if (["-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache", "-R", "--repo"].includes(tk)) i++;
    else if (!tk.startsWith("-") && tk !== "api" && path === null) path = tk;
  }
  if (path === "graphql") {
    if (input || values.some((v) => /^[\w-]+=@/.test(v))) return hit("github_write", t("gh api graphql mit Abfrage aus einer Datei – nicht prüfbar"));
    const q = values.join(" ");
    if (!/\bmutation\b/.test(q)) return null;
    if (/\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/.test(q)) return hit("merge_main", t("gh api graphql führt auf GitHub zusammen"));
    return hit("github_write", t("gh api graphql mit mutation verändert etwas auf GitHub"));
  }
  const writes = method ? method !== "GET" && method !== "HEAD" : fields || input;
  if (!writes) return null;
  if (path && MERGE_API.test(path)) return hit("merge_main", t("gh api {method} {path} verändert main", { method: method ?? "POST", path }));
  return hit("github_write", t("gh api {method} {path} verändert etwas auf GitHub", { method: method ?? "POST", path: path ?? t("(ohne Pfad)") }));
}

/** mv: eine Quelle außerhalb der Worktree verschwindet dort = Löschen außerhalb. */
function analyzeMove(args: Word[], ctx: Ctx): GuardHit | null {
  const pos: Word[] = [];
  let targetDirGiven = false;
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as Word;
    if (opts && w.text === "--") {
      opts = false;
      continue;
    }
    if (opts && (w.text === "-t" || w.text === "--target-directory")) {
      targetDirGiven = true;
      i++;
      continue;
    }
    if (opts && w.text.startsWith("--target-directory=")) {
      targetDirGiven = true;
      continue;
    }
    if (opts && w.text.startsWith("-") && w.text.length > 1) continue;
    pos.push(w);
  }
  const sources = targetDirGiven ? pos : pos.slice(0, -1);
  for (const src of sources) {
    const problem = deleteTargetProblem(src, ctx, false);
    if (problem) return hit("delete_outside_worktree", t("mv verschiebt weg: {problem}", { problem }));
  }
  return null;
}

const DANGEROUS_ALIAS: [RegExp, GuardRule][] = [
  [/\b(?:push|send-pack)\b/, "git_push"],
  [/\b(?:merge|rebase|reset|cherry-pick|update-ref|pull|am|revert)\b/, "merge_main"],
  [/\b(?:clean|rm|worktree)\b/, "delete_outside_worktree"],
];

/** git-Alias mit gefährlichem Inhalt? (`alias.p=push`, `alias.x='!git push'`) */
function aliasProblem(value: string, ctx: Ctx): GuardHit | null {
  if (value.startsWith("!")) {
    const h = analyzeScript(value.slice(1), { ...ctx, depth: ctx.depth + 1 });
    if (h) return h;
  }
  for (const [re, rule] of DANGEROUS_ALIAS) if (re.test(value)) return hit(rule, t("git-Alias „{value}“ würde {what} ausführen", { value, what: t(GUARD_ALIAS_WHAT[rule] ?? "") }));
  return null;
}
const GUARD_ALIAS_WHAT: Partial<Record<GuardRule, string>> = { git_push: "git push", merge_main: "Merge/Rebase/Reset", delete_outside_worktree: "Löschen" };

/** Eingebaute git-Befehle. Alles andere ist ein Alias (`.git/config`) oder ein Zusatzprogramm `git-<name>`. */
const KNOWN_GIT = new Set(
  "add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep hash-object help hook index-pack init instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree write-tree".split(" "),
);

/** git-Einstellungen, die Befehle ausführen oder weitere Konfiguration nachladen. */
function riskyGitKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    /^(?:include\.|includeif\.|core\.(?:fsmonitor|sshcommand|hookspath|pager|editor|askpass|gitproxy|alternaterefscommand|worktree)$|sequence\.editor$|pager\.|diff\.external$|credential\.|gpg\.|uploadpack\.|protocol\.|hook\.|submodule\.|sendemail\.|web\.browser$|browser\.|man\.|difftool\.|mergetool\.|filter\.|url\.)/.test(k) ||
    /\.(?:command|cmd|textconv|driver|clean|smudge|process|helper|program|uploadpack|receivepack|proxycommand|path)$/.test(k) ||
    /^remote\..*\.(?:uploadpack|receivepack|vcs|proxy)$/.test(k)
  );
}

function analyzeGit(args: Word[], ctx: Ctx): GuardHit | null {
  if (ctx.depth > MAX_DEPTH) return null;
  let i = 0;
  let dir = ctx.cwd;
  let foreign = false;
  const aliases: Record<string, string> = { ...ctx.gitAliases };
  const inlineAliases = new Set<string>();
  while (i < args.length && (args[i] as Word).text.startsWith("-")) {
    const a = (args[i] as Word).text;
    if (a === "-c") {
      const kv = args[i + 1]?.text ?? "";
      const m = /^alias\.([^=]+)=(.*)$/s.exec(kv);
      if (m) {
        aliases[m[1] as string] = m[2] as string;
        inlineAliases.add(m[1] as string);
      } else if (riskyGitKey(kv.split("=")[0] ?? "")) return unchecked(t("git -c {kv} kann fremde Befehle oder Konfiguration laden – nicht prüfbar", { kv: kv.slice(0, 80) }));
    }
    if (a === "--config-env" || a.startsWith("--config-env=")) return unchecked(t("git --config-env holt Konfiguration aus einer Umgebungsvariable – nicht prüfbar"));
    if (a.startsWith("--exec-path=")) return unchecked(t("git --exec-path=… ersetzt git-Befehle durch fremde Programme – nicht prüfbar"));
    if (a === "-C") {
      const w = args[i + 1];
      dir = w ? resolveWord(w, dir, ctx.env) : dir;
      i += 2;
      continue;
    }
    if (a === "--git-dir" || a === "--work-tree") foreign = true;
    if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) foreign = true;
    if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace" || a === "--super-prefix" || a === "--config-env") i += 2;
    else i++;
  }
  const sub = args[i]?.text;
  if (!sub) return null;
  const rest = args.slice(i + 1);
  const rt = texts(rest);
  const positionals = rt.filter((tk) => !tk.startsWith("-"));

  // Alias einsetzen (aus `-c alias.x=…` oder `git config alias.x …` früher in der Kette).
  const alias = aliases[sub];
  if (alias !== undefined) {
    const deeper: Ctx = { ...ctx, depth: ctx.depth + 1 };
    let h: GuardHit | null;
    if (alias.startsWith("!")) h = analyzeScript(`${alias.slice(1)} ${rt.map(shellQuote).join(" ")}`, deeper) ?? aliasProblem(alias, deeper);
    else {
      const expanded = lex(alias, {}).tokens.filter((tk): tk is Word => tk.kind === "word");
      const before = args.slice(0, i).filter((w, k, all) => !(w.text === "-c" || all[k - 1]?.text === "-c"));
      h = analyzeGit([...before, ...expanded, ...rest], deeper);
    }
    // `-c alias.x=…` im Aufruf selbst: auch ein harmlos wirkender Alias gilt als nicht prüfbar.
    return h ?? (inlineAliases.has(sub) ? unchecked(t("git -c alias.{sub}=… definiert einen Befehl im Aufruf – nicht prüfbar", { sub })) : null);
  }

  // Unbekannter Unterbefehl = Alias aus .git/config/~/.gitconfig oder Zusatzprogramm `git-<name>`.
  if (sub === "lfs") return positionals[0] === "push" ? hit("git_push", t("git lfs push lädt Dateien hoch")) : null;
  if (!KNOWN_GIT.has(sub)) return unchecked(t("„git {sub}“ ist kein bekannter git-Befehl – vermutlich ein Alias aus der git-Konfiguration oder ein Zusatzprogramm; Inhalt nicht prüfbar", { sub }));
  if (["filter-branch", "send-email", "instaweb", "hook"].includes(sub)) return unchecked(t("git {sub} führt eigene Befehle/Skripte aus – nicht prüfbar", { sub }));
  if (rt.some((tk) => /^--(?:upload-pack|receive-pack|exec)(?:=|$)/.test(tk)) || (["clone", "ls-remote"].includes(sub) && rt.includes("-u"))) {
    return unchecked(t("git {sub} mit eigenem Programm für die Gegenseite (--upload-pack/--exec) – nicht prüfbar", { sub }));
  }
  if (sub === "bisect" && positionals[0] === "run") {
    const k = rest.findIndex((w) => w.text === "run");
    return analyzeSimple({ kind: "simple", words: rest.slice(k + 1), heredoc: null, pipedFrom: null }, ctx);
  }
  if (sub === "submodule" && positionals[0] === "foreach") {
    const k = rest.findIndex((w) => w.text === "foreach");
    const script = texts(rest.slice(k + 1).filter((w) => !["--recursive", "-q", "--quiet"].includes(w.text))).join(" ");
    return analyzeScript(script, ctx) ?? (/\$/.test(script) ? unchecked(t("git submodule foreach mit variablem Befehl – nicht prüfbar")) : null);
  }
  if (sub === "difftool" || sub === "mergetool") {
    const k = rt.findIndex((tk) => tk === "-x" || tk === "--extcmd");
    const inline = rt.find((tk) => tk.startsWith("--extcmd="));
    const extcmd = k >= 0 ? (rt[k + 1] ?? "") : inline ? inline.slice(9) : null;
    if (extcmd !== null) return analyzeScript(extcmd, ctx);
  }

  // Arbeitet git in der eigenen Worktree? Sonst ist der Zweig unbekannt (evtl. main).
  const own = !foreign && !!dir && (!ctx.worktreeRoot || inside(dir, ctx.worktreeRoot, false));
  const onMain = !own || !ctx.branchKnown || isMain(ctx.branch);
  const where = own
    ? t("auf dem Zweig {branch}", { branch: ctx.branchKnown ? (ctx.branch ?? "?") : t("(unbekannt)") })
    : t("in einem fremden Checkout ({dir}, evtl. main)", { dir: dir ?? t("unbekannt") });

  switch (sub) {
    case "send-pack":
      return hit("git_push", t("git send-pack lädt Commits hoch"));
    case "subtree":
      return positionals[0] === "push" ? hit("git_push", t("git subtree push lädt Commits hoch")) : null;
    case "config": {
      const valued = new Set(["--file", "-f", "--blob", "--type", "--default", "--comment"]);
      const pos: string[] = [];
      for (let k = 0; k < rt.length; k++) {
        const tk = rt[k] as string;
        if (valued.has(tk)) k++;
        else if (!tk.startsWith("-")) pos.push(tk);
      }
      if (pos[0] === "set") pos.shift();
      const m = /^alias\.(.+)$/.exec(pos[0] ?? "");
      const reading = pos[1] === undefined || rt.some((tk) => /^--(?:get|unset|list|remove)/.test(tk)) || ["get", "list", "unset", "remove-section", "rename-section"].includes(pos[0] ?? "");
      if (!m && !reading && riskyGitKey(pos[0] ?? "")) return unchecked(t("git config {key} kann fremde Befehle oder Konfiguration laden – nicht prüfbar", { key: pos[0] }));
      if (rt.includes("--edit") || rt.includes("-e")) return unchecked(t("git config --edit öffnet einen Editor – nicht prüfbar"));
      const value = pos[1];
      if (!m || reading || value === undefined) return null;
      ctx.gitAliases[m[1] as string] = value;
      return aliasProblem(value, ctx);
    }
    case "push":
      if (rt.includes("--dry-run") || rt.includes("-n")) return null;
      return hit("git_push", positionals.length ? t("git push lädt Commits auf GitHub hoch ({target})", { target: positionals.join(" ") }) : t("git push lädt Commits auf GitHub hoch"));
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "reset":
    case "pull":
    case "am":
    case "revert": {
      if (rt.includes("--abort") || rt.includes("--quit")) return null;
      if (onMain) return hit("merge_main", t("git {sub} {where} verändert main", { sub, where }));
      if (sub === "rebase") {
        for (let k = 0; k < rt.length; k++) {
          const tk = rt[k] as string;
          const exec = tk === "-x" || tk === "--exec" ? (rt[k + 1] ?? "") : tk.startsWith("--exec=") ? tk.slice(7) : null;
          if (exec !== null) {
            const h = analyzeScript(exec, ctx);
            if (h) return h;
          }
        }
        const valued = new Set(["--onto", "-s", "--strategy", "-X", "--strategy-option", "-x", "--exec"]);
        const pos: string[] = [];
        for (let k = 0; k < rt.length; k++) {
          const tk = rt[k] as string;
          if (valued.has(tk)) k++;
          else if (!tk.startsWith("-")) pos.push(tk);
        }
        if (pos.length >= 2 && isMain(pos[1])) return hit("merge_main", t("git rebase schreibt den Zweig main um"));
      }
      return null;
    }
    case "checkout":
    case "switch": {
      const force = rt.findIndex((tk) => tk === "-B" || tk === "-C" || tk === "--force-create");
      if (force >= 0 && isMain(rt[force + 1])) return hit("merge_main", t("git {sub} {flag} main setzt main zurück", { sub, flag: rt[force] }));
      if (!own) return null;
      const create = rt.findIndex((tk) => tk === "-b" || tk === "-c" || tk === "--create" || tk === "-B" || tk === "-C" || tk === "--force-create" || tk === "--orphan");
      if (create >= 0) {
        ctx.branch = rt[create + 1] ?? null;
        ctx.branchKnown = true;
      } else if (!rt.includes("--")) {
        const target = positionals[0];
        if (target === "-") ctx.branchKnown = false;
        else if (target) {
          ctx.branch = target;
          ctx.branchKnown = true;
        }
      }
      return null;
    }
    case "update-ref":
      if (positionals.some((p) => isMain(p))) return hit("merge_main", t("git update-ref verändert den Zweig main direkt"));
      return null;
    case "branch": {
      const changing = rt.some((tk) => /^-[A-Za-z]*[fMmCcDd]/.test(tk) || ["--force", "--delete", "--move", "--copy"].includes(tk));
      if (changing && positionals.some((p) => isMain(p))) return hit("merge_main", t("git branch verändert oder löscht den Zweig main"));
      const deleting = rt.some((tk) => /^-[A-Za-z]*[Dd]/.test(tk) || tk === "--delete");
      if (deleting) {
        const mine = (ctx.auftrag ?? "").toLowerCase();
        const foreignBranch = positionals.find((p) => !mine || !p.toLowerCase().includes(mine));
        if (foreignBranch) return hit("delete_outside_worktree", t("git branch löscht den fremden Zweig {foreignBranch}", { foreignBranch }));
      }
      return null;
    }
    case "fetch":
      if (positionals.some((p) => p.includes(":") && isMain(p.slice(p.lastIndexOf(":") + 1)))) return hit("merge_main", t("git fetch schreibt direkt in den Zweig main"));
      return null;
    case "clean": {
      if (rt.some((tk) => tk === "--dry-run" || /^-[A-Za-z]*n/.test(tk))) return null;
      const paths: Word[] = [];
      for (let k = 0; k < rest.length; k++) {
        const tk = (rest[k] as Word).text;
        if (tk === "-e" || tk === "--exclude") k++;
        else if (!tk.startsWith("-")) paths.push(rest[k] as Word);
      }
      const gctx = { ...ctx, cwd: dir };
      for (const p of paths.length ? paths : [{ kind: "word", text: ".", dynamic: false, glob: false, tilde: false, quoted: false } as Word]) {
        const problem = deleteTargetProblem(p, gctx, true);
        if (problem) return hit("delete_outside_worktree", `git clean: ${problem}`);
      }
      return null;
    }
    case "worktree": {
      if (rest[0]?.text !== "remove") return null;
      const target = rest.slice(1).find((w) => !w.text.startsWith("-"));
      if (!target) return null;
      const abs = resolveWord(target, dir, ctx.env);
      if (abs && ctx.worktreeRoot && inside(abs, ctx.worktreeRoot, true)) return null;
      return hit("delete_outside_worktree", t("git worktree remove löscht die Worktree {abs}", { abs: abs ?? target.text }));
    }
    default:
      return null;
  }
}

const DOCKER_WRITE = new Set(["rm", "rmi", "stop", "kill", "restart", "run", "start", "create", "pause", "unpause", "update", "rename", "commit", "push", "load", "import", "cp"]);
const DOCKER_READ = new Set(["ps", "logs", "inspect", "stats", "images", "top", "version", "info", "port", "events", "diff", "history"]);
const COMPOSE_WRITE = new Set(["up", "down", "build", "restart", "rm", "stop", "start", "pull", "create", "kill", "run", "push", "pause", "unpause", "scale", "watch", "cp"]);
const COMPOSE_READ = new Set(["ps", "logs", "config", "images", "top", "ls", "version", "port", "events"]);

function skipValued(ws: Word[], start: number, valued: Set<string>): number {
  let i = start;
  while (i < ws.length && (ws[i] as Word).text.startsWith("-")) {
    const tk = (ws[i] as Word).text;
    i += valued.has(tk) ? 2 : 1;
  }
  return i;
}

function containerCommand(inner: Word[], ctx: Ctx): GuardHit | null {
  if (inner.length === 0) return null;
  return analyzeSimple({ kind: "simple", words: inner, heredoc: null, pipedFrom: null }, { ...ctx, remote: "container", cwd: null });
}

function analyzeCompose(args: Word[], ctx: Ctx): GuardHit | null {
  const i = skipValued(args, 0, new Set(["-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory", "--ansi", "--progress", "--parallel"]));
  const sub = args[i]?.text;
  if (!sub) return null;
  if (COMPOSE_WRITE.has(sub)) return hit("deploy", t("docker compose {sub} verändert laufende Container", { sub }));
  if (sub === "exec") {
    const j = skipValued(args, i + 1, new Set(["-e", "--env", "-u", "--user", "-w", "--workdir", "--index"]));
    return containerCommand(args.slice(j + 1), ctx);
  }
  return null;
}

function analyzeDocker(b: string, args: Word[], ctx: Ctx): GuardHit | null {
  if (b === "docker-compose") return analyzeCompose(args, ctx);
  const i = skipValued(args, 0, new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"]));
  const sub = args[i]?.text;
  if (!sub) return null;
  const rest = args.slice(i + 1);
  if (sub === "compose") return analyzeCompose(rest, ctx);
  if (sub === "exec" || (sub === "container" && rest[0]?.text === "exec")) {
    const from = sub === "exec" ? rest : rest.slice(1);
    const j = skipValued(from, 0, new Set(["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--detach-keys"]));
    return containerCommand(from.slice(j + 1), ctx);
  }
  if (DOCKER_WRITE.has(sub)) return hit("deploy", t("docker {sub} verändert Container", { sub }));
  if (sub === "container" && rest[0] && DOCKER_WRITE.has(rest[0].text)) return hit("deploy", t("docker container {text} verändert Container", { text: rest[0].text }));
  if (["volume", "network", "image", "system", "builder", "container"].includes(sub) && rest[0] && ["rm", "prune", "remove", "create"].includes(rest[0].text)) {
    return hit("deploy", t("docker {sub} {text} verändert Docker-Daten", { sub, text: rest[0].text }));
  }
  return null;
}

function isReadOnlyDocker(args: Word[]): boolean {
  const i = skipValued(args, 0, new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"]));
  const sub = args[i]?.text;
  if (!sub) return true;
  const rest = args.slice(i + 1);
  if (DOCKER_READ.has(sub)) return true;
  if (sub === "compose") {
    const j = skipValued(rest, 0, new Set(["-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory"]));
    return COMPOSE_READ.has(rest[j]?.text ?? "");
  }
  if (["container", "volume", "network", "image", "system"].includes(sub)) return ["ls", "list", "ps", "inspect", "logs", "top", "stats", "port", "df", "info", "history"].includes(rest[0]?.text ?? "");
  return false;
}

const READONLY_REMOTE = new Set(["cat", "ls", "ll", "tail", "head", "grep", "egrep", "zgrep", "zcat", "less", "more", "df", "du", "free", "uptime", "whoami", "hostname", "uname", "echo", "pwd", "stat", "wc", "date", "ps", "id", "printenv", "which", "file", "sort", "uniq", "cut", "jq", "journalctl", "test", "true", "[", "md5sum", "sha256sum", "sha1sum", "ss", "netstat", "lsof", "nproc", "lscpu", "vmstat", "iostat", "w", "last", "cd", "tree", "realpath", "readlink", "basename", "dirname"]);

function isReadOnlyRemote(b: string, args: Word[]): boolean {
  if (READONLY_REMOTE.has(b)) return true;
  if (b === "docker") return isReadOnlyDocker(args);
  if (b === "docker-compose") return COMPOSE_READ.has(args.find((w) => !w.text.startsWith("-"))?.text ?? "");
  if (b === "git") {
    const sub = args.find((w) => !w.text.startsWith("-"))?.text ?? "";
    return ["status", "log", "diff", "show", "rev-parse", "describe", "ls-files", "blame", "shortlog"].includes(sub);
  }
  if (b === "systemctl") return ["status", "is-active", "is-enabled", "list-units", "show"].includes(args[0]?.text ?? "");
  if (b === "find") return !args.some((w) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(w.text));
  return false;
}

function remoteCommand(remote: Word[], cmd: Simple, ctx: Ctx, via: string): GuardHit | null {
  const rctx: Ctx = { ...ctx, remote: "ssh", cwd: null };
  if (remote.length === 0) {
    if (cmd.heredoc !== null) return analyzeScript(cmd.heredoc, rctx) ?? null;
    return hit("deploy", t("{via} ohne festen Befehl öffnet eine Sitzung auf dem Produktionsserver", { via }));
  }
  // ssh fügt die Argumente mit Leerzeichen zusammen und lässt die Server-Shell sie lesen.
  return analyzeScript(texts(remote).join(" "), rctx);
}

function analyzeSsh(args: Word[], cmd: Simple, ctx: Ctx): GuardHit | null {
  const valued = "bcDEeFIiJLlmOoPpQRSWw";
  const options: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const tk = (args[i] as Word).text;
    if (tk === "--") {
      i++;
      break;
    }
    if (!tk.startsWith("-") || tk.length < 2) break;
    for (let k = 1; k < tk.length; k++) {
      const c = tk[k] as string;
      if (valued.includes(c)) {
        const value = k === tk.length - 1 ? (args[++i]?.text ?? "") : tk.slice(k + 1);
        if (c === "o") options.push(value);
        break;
      }
    }
  }
  const host = args[i];
  if (!host) return null;
  // Host aus Variable oder per `-o HostName=…` umgelenkt: nicht prüfbar → wie Produktion behandeln.
  const redirected = options.some((o) => /^hostname[=\s]/i.test(o));
  if (!host.dynamic && !redirected && !isProdHost(host.text, ctx)) return null;
  return remoteCommand(args.slice(i + 1), cmd, ctx, "ssh");
}

function analyzeCopy(b: string, args: Word[], ctx: Ctx): GuardHit | null {
  const valued = new Set(b === "scp" ? ["-P", "-i", "-o", "-F", "-c", "-l", "-S", "-J"] : ["-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--exclude-from", "--include-from", "--files-from", "--rsync-path", "-T", "--temp-dir", "--log-file", "-B", "--password-file"]);
  const posWords: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const tk = (args[i] as Word).text;
    if (valued.has(tk)) i++;
    else if (!tk.startsWith("-")) posWords.push(args[i] as Word);
  }
  const pos = texts(posWords);
  const target = pos[pos.length - 1];
  if (pos.length >= 2 && target && isProdHost(target, ctx)) return hit("deploy", t("{b} kopiert Dateien auf den Produktionsserver ({target})", { b, target }));
  if (b !== "rsync" || pos.length < 2) return null;
  const at = texts(args);
  const isRemote = (p: string) => /^[^/]*:/.test(p) || p.startsWith("rsync://");
  // --delete* löscht im Ziel alles, was in der Quelle fehlt.
  if (at.some((tk) => tk.startsWith("--del"))) {
    const tw = posWords[posWords.length - 1] as Word;
    if (isRemote(tw.text)) return hit("delete_outside_worktree", t("rsync --delete löscht auf einem anderen Rechner ({text})", { text: tw.text }));
    const problem = deleteTargetProblem(tw, ctx, true);
    if (problem) return hit("delete_outside_worktree", `rsync --delete: ${problem}`);
  }
  if (at.includes("--remove-source-files")) {
    for (const src of posWords.slice(0, -1)) {
      const problem = isRemote(src.text) ? t("Quelle {text} liegt auf einem anderen Rechner", { text: src.text }) : deleteTargetProblem(src, ctx, true);
      if (problem) return hit("delete_outside_worktree", `rsync --remove-source-files: ${problem}`);
    }
  }
  return null;
}

function analyzePsql(b: string, args: Word[], assign: Record<string, string>, ctx: Ctx): GuardHit | null {
  if (ctx.remote) return hit("migration", t("{b} läuft direkt auf dem Server bzw. im Datenbank-Container", { b }));
  let host: string | null = assign.PGHOST ?? ctx.env.PGHOST ?? null;
  for (let i = 0; i < args.length; i++) {
    const tk = (args[i] as Word).text;
    let value: string | undefined;
    if (tk === "-h" || tk === "--host") value = args[++i]?.text ?? "";
    else if (tk.startsWith("--host=")) value = tk.slice(7);
    else if (/^-h./.test(tk)) value = tk.slice(2);
    if (value !== undefined) {
      host = value;
      continue;
    }
    const uri = /^postgres(?:ql)?:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/?]*)/.exec(tk.replace(/^--dbname=/, ""));
    if (uri) host = uri[1] ?? "";
    const kv = /(?:^|\s)host=([^\s]+)/.exec(tk);
    if (kv) host = kv[1] ?? "";
  }
  // Nur der Host-Teil zählt: `postgres://u@localhost/$DB` bleibt lokal, `-h $DBHOST` ist unklar.
  if (host !== null && /[$`]/.test(host) && !host.startsWith("/")) return hit("migration", t("{b} mit variablem Datenbank-Host ({host}) ist nicht prüfbar", { b, host }));
  if (host === null || host.startsWith("/") || LOCAL_HOSTS.has(host.toLowerCase())) return null;
  return hit("migration", t("{b} gegen die Datenbank auf {host} (nicht lokal)", { b, host }));
}

function analyzeRunner(b: string, args: Word[], cmd: Simple, ctx: Ctx): GuardHit | null {
  const rerun = (ws: Word[]) => (ws.length ? analyzeSimple({ ...cmd, words: ws, heredoc: null }, ctx) : null);
  /** Paket-Programm starten (`npx x`, `pnpm exec x`, `pnpm dlx x`): nur bekannte Werkzeuge weiter prüfen. */
  const tool = (label: string, ws: Word[]) => {
    const first = ws[0];
    if (!first) return null;
    const tb = baseName(first.text);
    if (first.text.includes("/") || KNOWN_TOOLS.has(tb) || isCodeRunner(tb) || tb === "drizzle-kit") return rerun(ws);
    return unchecked(t("{label} {tb} startet ein Paket-Programm mit unbekanntem Inhalt – nicht prüfbar", { label, tb }));
  };
  if (b === "npx" || b === "pnpx" || b === "bunx") {
    const i = skipValued(args, 0, new Set(["-p", "--package", "-c", "--call"]));
    if (args.slice(0, i).some((w) => w.text === "-c" || w.text === "--call")) return unchecked(t("{b} -c führt einen Befehlstext aus – nicht prüfbar", { b }));
    return tool(b, args.slice(i));
  }
  const i = skipValued(args, 0, new Set(["--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--cwd"]));
  const sub = args[i]?.text;
  if (!sub) return null;
  if (sub === "exec" || sub === "dlx" || sub === "x") {
    const j = skipValued(args, i + 1, new Set(["-c", "--package"]));
    if (args.slice(i + 1, j).some((w) => w.text === "-c")) return unchecked(t("{b} {sub} -c führt einen Befehlstext aus – nicht prüfbar", { b, sub }));
    return tool(`${b} ${sub}`, args.slice(j));
  }
  const viaRun = sub === "run" || sub === "run-script";
  // pnpm/yarn/bun starten auch ohne `run`/`exec` ein Skript oder Programm (`pnpm drizzle-kit migrate`).
  const bare = !viaRun && b !== "npm" && !(b === "pnpm" ? PNPM_BUILTINS : RUNNER_BUILTINS).has(sub);
  const script = viaRun ? args[skipValued(args, i + 1, new Set())]?.text : bare ? sub : null;
  if (script) {
    if (/migrat|db:push/i.test(script)) return hit("migration", t("{cmd} führt eine Migration aus", { cmd: `${b} ${viaRun ? "run " : ""}${script}` }));
    if (/^deploy/i.test(script)) return hit("deploy", t("{cmd} startet einen Deploy", { cmd: `${b} ${viaRun ? "run " : ""}${script}` }));
  }
  if (sub === "publish") return hit("deploy", t("{b} publish veröffentlicht ein Paket", { b }));
  // Paket-Skripte: Inhalt steht in package.json (vom Auftrag änderbar) → nur die Erlaubt-Liste läuft ohne Frage.
  if (viaRun) return !script || ALLOWED_SCRIPTS.has(script) ? null : unchecked(t("{b} run {script} führt ein Paket-Skript mit unbekanntem Inhalt aus – nicht prüfbar", { b, script }));
  if (bare) return ALLOWED_SCRIPTS.has(sub) ? null : tool(b, args.slice(i));
  return null;
}

const RUNNER_BUILTINS = new Set(["install", "i", "add", "remove", "rm", "update", "up", "upgrade", "list", "ls", "why", "outdated", "test", "t", "start", "publish", "pack", "link", "unlink", "store", "audit", "init", "create", "import", "rebuild", "prune", "patch", "config", "root", "bin", "licenses", "info", "cache", "global", "workspace", "workspaces", "help", "version", "--version", "-v", "dedupe", "fetch", "env", "setup", "server", "recursive", "-r", "build", "pm"]);
const PNPM_BUILTINS = new Set([...RUNNER_BUILTINS, "deploy"]);

function analyzeDelete(b: string, args: Word[], fromXargs: boolean, ctx: Ctx): GuardHit | null {
  const targets: Word[] = [];
  let opts = true;
  for (const w of args) {
    if (opts && w.text === "--") {
      opts = false;
      continue;
    }
    if (opts && w.text.startsWith("-") && w.text.length > 1) continue;
    targets.push(w);
  }
  if (targets.length === 0) return fromXargs ? hit("delete_outside_worktree", t("{b} über xargs: die Ziele kommen aus einer Liste und sind nicht prüfbar", { b })) : null;
  for (const tk of targets) {
    const problem = deleteTargetProblem(tk, ctx, false);
    if (problem) return hit("delete_outside_worktree", `${b}: ${problem}`);
  }
  return null;
}

function analyzeFind(args: Word[], cmd: Simple, ctx: Ctx): GuardHit | null {
  const starts: Word[] = [];
  let k = 0;
  // Führende Optionen (GNU: -H -L -P -O3 -D x; BSD/macOS: -E -X -d -s -x, -f <start>) sind keine Startpfade.
  while (k < args.length) {
    const tk = (args[k] as Word).text;
    if (/^-[HLPEXdsx]+$/.test(tk) || /^-O\d*$/.test(tk)) k++;
    else if (tk === "-D") k += 2;
    else if (tk === "-f" && args[k + 1]) {
      starts.push(args[k + 1] as Word);
      k += 2;
    } else break;
  }
  while (k < args.length && !/^[-(!]/.test((args[k] as Word).text)) starts.push(args[k++] as Word);
  let deletes = args.some((w) => w.text === "-delete");
  for (let i = k; i < args.length; i++) {
    const tk = (args[i] as Word).text;
    if (tk === "-exec" || tk === "-execdir" || tk === "-ok" || tk === "-okdir") {
      const inner: Word[] = [];
      let j = i + 1;
      for (; j < args.length && (args[j] as Word).text !== ";" && (args[j] as Word).text !== "+"; j++) inner.push(args[j] as Word);
      i = j;
      const ib = inner[0] ? baseName(inner[0].text) : "";
      if (DELETERS.has(ib)) deletes = true;
      else {
        const h = analyzeSimple({ ...cmd, words: inner.filter((w) => w.text !== "{}"), heredoc: null }, ctx);
        if (h) return h;
      }
    }
  }
  if (!deletes) return null;
  const list = starts.length ? starts : [{ kind: "word", text: ".", dynamic: false, glob: false, tilde: false, quoted: false } as Word];
  for (const s of list) {
    const problem = deleteTargetProblem(s, ctx, true);
    if (problem) return hit("delete_outside_worktree", t("find löscht: {problem}", { problem }));
  }
  return null;
}

/**
 * Prüft einen Befehl gegen die D6-Leitplanken. `null` = erlaubt.
 * Fehler im Zerleger führen nie zum Absturz: dann gilt der Befehl als harmlos, außer er enthält
 * sichtbar `git push` (fail closed nur für das Offensichtliche).
 */
export function classifyCommand(input: GuardInput): GuardHit | null {
  if (input.tool !== "Bash" || !input.command) return null;
  try {
    const ctx: Ctx = {
      cwd: input.cwd ?? input.worktreeRoot,
      branch: input.currentBranch,
      branchKnown: true,
      worktreeRoot: input.worktreeRoot,
      env: input.env,
      auftrag: input.env.NYXOS_AUFTRAG ?? null,
      remote: null,
      depth: 0,
      vars: {},
      gitAliases: {},
      prodHosts: (input.prodHosts ?? parseProdHosts(input.env.NYXOS_PROD_HOSTS)).map((h) => h.toLowerCase()),
    };
    return analyzeScript(input.command, ctx);
  } catch {
    return /\bgit\b[^\n]*\bpush\b/.test(input.command) ? hit("git_push", t("Befehl enthält git push (nicht vollständig lesbar)")) : null;
  }
}
