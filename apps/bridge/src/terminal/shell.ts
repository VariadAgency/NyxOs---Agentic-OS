// Automatisch in tmux: Der Installer trägt einen markierten Block in `~/.zshrc` und/oder `~/.bashrc` ein,
// der nur eine von NyxOS erzeugte Datei lädt (`<nyxos>/bridge/shell/nyxos.zsh` bzw. `nyxos.bash`). So bleibt
// der Eingriff in die persönliche Shell drei Zeilen groß, und Updates ändern nur die eigenen Dateien.
//
// Tests arbeiten mit Wegwerf-Ordnern, nie mit den echten Shell-Dateien.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { t } from "@nyxos/shared";
import { findBin } from "../platform.js";

/** Eigene Marken: `# >>> nyxos >>>` gehört dem `nyxos`-Befehl (PATH-Eintrag) und bleibt unberührt. */
export const BLOCK_START = "# >>> nyxos shell >>>";
export const BLOCK_END = "# <<< nyxos shell <<<";
/** Block älterer Installationen (gleiche Marke wie der PATH-Block des `nyxos`-Befehls, aber mit `nyxos.zsh`). */
const LEGACY_START = "# >>> nyxos >>>";
const LEGACY_END = "# <<< nyxos <<<";
/** tmux-Socket von NyxOS (`tmux -L nyxos`) — die persönliche tmux-Nutzung bleibt unberührt. */
export const TMUX_SOCKET = "nyxos";

export type ShellKind = "zsh" | "bash";

export interface ShellPaths {
  /** Ordner mit den Shell-Funktionen und den Start-Helfern. */
  dir: string;
  zsh: string;
  bash: string;
  conf: string;
  /** Start-Helfer für zsh. */
  runner: string;
  /** Start-Helfer für bash. */
  bashRunner: string;
}

export function shellPaths(supportDir: string): ShellPaths {
  const dir = join(supportDir, "shell");
  return {
    dir,
    zsh: join(dir, "nyxos.zsh"),
    bash: join(dir, "nyxos.bash"),
    conf: join(supportDir, "tmux.conf"),
    runner: join(dir, "nyxos-tmux-run"),
    bashRunner: join(dir, "nyxos-tmux-run.bash"),
  };
}

/** Einfache Anführungszeichen für zsh/bash/sh — Pfade mit Leerzeichen. */
const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** tmux-Konfiguration: soll sich wie ein normales Terminal anfühlen. */
export function tmuxConf(): string {
  return [
    "# NyxOS: eigener tmux-Server (tmux -L nyxos). Von NyxOS erzeugt, wird bei jeder Installation überschrieben.",
    "# Ziel: fühlt sich an wie ein normales Terminal – keine Statusleiste, keine eigenen Tastenkürzel.",
    "set -g status off",
    "set -g prefix None",
    "set -g prefix2 None",
    "unbind-key C-b",
    "set -g mouse on",
    "set -g history-limit 50000",
    'set -g default-terminal "xterm-256color"',
    'set -as terminal-features ",xterm*:RGB"',
    "set -g escape-time 0",
    "set -g focus-events on",
    "set -g set-clipboard on",
    "set -g allow-passthrough on",
    // Mehrere Zuschauer (Terminal.app + Browser): die Größe folgt dem, der zuletzt getippt hat.
    "set -g window-size latest",
    "set -g aggressive-resize on",
    // Server nie wegen „keine Session mehr" beenden: sonst Wettlauf zwischen dem Ende der letzten und
    // dem Start der nächsten Session (neue Session verschwindet mit dem sterbenden Server).
    "set -g exit-empty off",
    'set -g set-titles on',
    'set -g set-titles-string "#{pane_title}"',
    "",
  ].join("\n");
}

/** Start-Helfer: übernimmt die Umgebung der aufrufenden Shell (tmux gibt sonst nur seine eigene weiter),
 * führt das Programm aus und legt den Exit-Code für die Shell-Funktion ab. */
export function runnerScript(zshBin = "/bin/zsh"): string {
  return [
    `#!${zshBin} -f`,
    "# nyxos-tmux-run <exit-datei> <umgebungs-datei> <programm> [argumente …] — von NyxOS erzeugt.",
    'f=$1; envf=$2; shift 2',
    'if [[ -r $envf ]]; then',
    '  source -- $envf',
    '  command rm -f -- $envf',
    'fi',
    '"$@"',
    "rc=$?",
    "print -r -- $rc > $f",
    "exit $rc",
    "",
  ].join("\n");
}

/** Dasselbe für bash (die Umgebungs-Datei stammt aus bashs `export -p`). */
export function bashRunnerScript(bashBin = "/bin/bash"): string {
  return [
    `#!${bashBin}`,
    "# nyxos-tmux-run.bash <exit-datei> <umgebungs-datei> <programm> [argumente …] — von NyxOS erzeugt.",
    'f=$1; envf=$2; shift 2',
    'if [[ -r $envf ]]; then',
    '  source -- "$envf" 2>/dev/null',
    '  command rm -f -- "$envf"',
    'fi',
    '"$@"',
    "rc=$?",
    "printf '%s\\n' \"$rc\" > \"$f\"",
    'exit "$rc"',
    "",
  ].join("\n");
}

/** Projektordner als Shell-Array-Inhalt; leer = überall. */
const rootsWords = (roots: readonly string[]) => roots.map(sq).join(" ");

/**
 * zsh-Funktionen `claude` und `codex`: in einem Projektordner (ohne eingetragene Ordner: überall), außerhalb
 * von tmux und ohne `NYXOS_TMUX=0` startet das Werkzeug in einer eigenen tmux-Session `zc-<werkzeug>-<id>`;
 * sonst unverändert `command claude "$@"`. Argumente gehen als eigene Wörter an tmux (kein Shell-String).
 */
export function zshFunctions(o: { tmuxBin: string; projectRoots: readonly string[]; paths: ShellPaths; socket?: string }): string {
  const socket = o.socket ?? TMUX_SOCKET;
  return `# Von NyxOS erzeugt – nicht von Hand ändern (wird bei jeder Installation überschrieben).
# claude/codex in den Projektordnern laufen automatisch in tmux (-L ${socket}). Abschalten: NYXOS_TMUX=0
_nyxos_tmux_run() {
  emulate -L zsh
  local tool=$1; shift
  local -a roots=(${rootsWords(o.projectRoots)})
  local inroot=0 r
  (( \${#roots} == 0 )) && inroot=1
  for r in $roots; do [[ $PWD == $r || $PWD == $r/* ]] && inroot=1; done
  if [[ \${NYXOS_TMUX:-1} == 0 || -n \${TMUX:-} || ! -x ${sq(o.tmuxBin)} || $inroot == 0 ]]; then
    command $tool "$@"
    return $?
  fi
  local bin
  bin=$(whence -p $tool) || { command $tool "$@"; return $?; }
  local id
  id=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 8)
  local name="zc-$tool-$id"
  local rcfile="\${TMPDIR:-/tmp}/nyxos-$name.exit"
  local envfile="\${TMPDIR:-/tmp}/nyxos-$name.env"
  # Umgebung der aufrufenden Shell mitnehmen (nur für den Start-Helfer lesbar, danach gelöscht).
  ( umask 077; export -p | command grep -v -E '^(export |typeset -x )?(TMUX|TMUX_PANE|TERM)=' > "$envfile" )
  ${sq(o.tmuxBin)} -L ${sq(socket)} -f ${sq(o.paths.conf)} new-session -s "$name" -c "$PWD" \\
    -e "NYXOS_TMUX_NAME=$name" \\
    -- ${sq(o.paths.runner)} "$rcfile" "$envfile" "$bin" "$@"
  local rc=1
  [[ -r $rcfile ]] && rc=$(<$rcfile)
  command rm -f -- "$rcfile" "$envfile"
  return $rc
}
claude() { _nyxos_tmux_run claude "$@"; }
codex() { _nyxos_tmux_run codex "$@"; }
`;
}

/** Dieselben Funktionen für bash. */
export function bashFunctions(o: { tmuxBin: string; projectRoots: readonly string[]; paths: ShellPaths; socket?: string }): string {
  const socket = o.socket ?? TMUX_SOCKET;
  return `# Von NyxOS erzeugt – nicht von Hand ändern (wird bei jeder Installation überschrieben).
# claude/codex in den Projektordnern laufen automatisch in tmux (-L ${socket}). Abschalten: NYXOS_TMUX=0
_nyxos_tmux_run() {
  local tool=$1; shift
  local roots=(${rootsWords(o.projectRoots)})
  local inroot=0 r
  (( \${#roots[@]} == 0 )) && inroot=1
  for r in "\${roots[@]}"; do [[ $PWD == "$r" || $PWD == "$r"/* ]] && inroot=1; done
  if [[ \${NYXOS_TMUX:-1} == 0 || -n \${TMUX:-} || ! -x ${sq(o.tmuxBin)} || $inroot == 0 ]]; then
    command "$tool" "$@"
    return $?
  fi
  local bin
  bin=$(type -P "$tool") || { command "$tool" "$@"; return $?; }
  local id
  id=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 8)
  local name="zc-$tool-$id"
  local rcfile="\${TMPDIR:-/tmp}/nyxos-$name.exit"
  local envfile="\${TMPDIR:-/tmp}/nyxos-$name.env"
  # Umgebung der aufrufenden Shell mitnehmen (ohne schreibgeschützte Variablen; danach gelöscht).
  ( umask 077; export -p | command grep -v -E '^declare -[a-zA-Z]*r|^(declare -x |export )?(TMUX|TMUX_PANE|TERM)=' > "$envfile" )
  ${sq(o.tmuxBin)} -L ${sq(socket)} -f ${sq(o.paths.conf)} new-session -s "$name" -c "$PWD" \\
    -e "NYXOS_TMUX_NAME=$name" \\
    -- ${sq(o.paths.bashRunner)} "$rcfile" "$envfile" "$bin" "$@"
  local rc=1
  [[ -r $rcfile ]] && rc=$(<"$rcfile")
  command rm -f -- "$rcfile" "$envfile"
  return "$rc"
}
claude() { _nyxos_tmux_run claude "$@"; }
codex() { _nyxos_tmux_run codex "$@"; }
`;
}

/** Der markierte Block in der Shell-Startdatei: lädt nur die erzeugte Datei (falls vorhanden). */
export function rcBlock(file: string): string {
  return [BLOCK_START, "# NyxOS: claude/codex in den Projektordnern automatisch in tmux. Abschalten: NYXOS_TMUX=0", `[ -r ${sq(file)} ] && source ${sq(file)}`, BLOCK_END, ""].join("\n");
}

const BLOCK_RE = new RegExp(`\\n?${escapeRe(BLOCK_START)}\\n[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`);
const LEGACY_RE = new RegExp(`${escapeRe(LEGACY_START)}\\n(?:(?!${escapeRe(LEGACY_END)})[\\s\\S])*?nyxos\\.(?:zsh|bash)[\\s\\S]*?${escapeRe(LEGACY_END)}\\n?`);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Block einsetzen (idempotent: ein vorhandener Block wird ersetzt, nie verdoppelt). */
export function addBlock(content: string, block: string): string {
  const without = removeBlock(content);
  const sep = without.length === 0 ? "" : "\n";
  return without + sep + block;
}

/** Genau unseren Block entfernen (auch den älterer Installationen) — der Rest der Datei bleibt Byte für Byte gleich. */
export function removeBlock(content: string): string {
  return content.replace(BLOCK_RE, "").replace(LEGACY_RE, "");
}

export function hasBlock(file: string): boolean {
  try {
    return BLOCK_RE.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

function backup(file: string): string | null {
  if (!existsSync(file)) return null;
  const b = `${file}.vor-nyxos-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, b);
  return b;
}

export interface ShellTarget {
  kind: ShellKind;
  rc: string;
}

/**
 * In welche Startdateien der Block gehört: jede vorhandene `~/.zshrc`/`~/.bashrc`, dazu die der Login-Shell
 * (`$SHELL`) auch dann, wenn sie noch fehlt. Ohne beides: die übliche Shell des Systems.
 */
export function shellTargets(rc: { zshrc: string; bashrc: string }, loginShell = process.env.SHELL ?? "", platform: NodeJS.Platform = process.platform): ShellTarget[] {
  const out: ShellTarget[] = [];
  const shellName = basename(loginShell);
  if (existsSync(rc.zshrc) || shellName === "zsh") out.push({ kind: "zsh", rc: rc.zshrc });
  if (existsSync(rc.bashrc) || shellName === "bash") out.push({ kind: "bash", rc: rc.bashrc });
  if (out.length === 0) out.push(platform === "darwin" ? { kind: "zsh", rc: rc.zshrc } : { kind: "bash", rc: rc.bashrc });
  return out;
}

export interface ShellFilesOptions {
  supportDir: string;
  tmuxBin: string;
  projectRoots: readonly string[];
  /** Tests: eigener tmux-Socket. */
  socket?: string;
}

/**
 * tmux-Konfiguration, Start-Helfer und Shell-Funktionen schreiben (ohne die Startdateien anzufassen) — auch
 * nach einer Änderung der Projektordner, damit die Funktionen die neue Liste kennen.
 */
export function writeShellFiles(o: ShellFilesOptions): string[] {
  const p = shellPaths(o.supportDir);
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.conf, tmuxConf());
  const zsh = findBin("zsh");
  const bash = findBin("bash");
  writeFileSync(p.runner, runnerScript(zsh ?? "/bin/zsh"));
  chmodSync(p.runner, 0o755);
  writeFileSync(p.bashRunner, bashRunnerScript(bash ?? "/bin/bash"));
  chmodSync(p.bashRunner, 0o755);
  const fn = { tmuxBin: o.tmuxBin, projectRoots: o.projectRoots, paths: p, ...(o.socket ? { socket: o.socket } : {}) };
  writeFileSync(p.zsh, zshFunctions(fn));
  writeFileSync(p.bash, bashFunctions(fn));
  return [t("tmux-Konfiguration → {file}", { file: p.conf }), t("Shell-Funktionen → {dir}", { dir: p.dir })];
}

/** Installer-Schritt: Dateien schreiben + Block in die Startdateien. */
export function installShell(o: ShellFilesOptions & { targets: ShellTarget[] }): string[] {
  const p = shellPaths(o.supportDir);
  const report = writeShellFiles(o);
  for (const target of o.targets) {
    const file = target.kind === "zsh" ? p.zsh : p.bash;
    const before = existsSync(target.rc) ? readFileSync(target.rc, "utf8") : "";
    const after = addBlock(before, rcBlock(file));
    if (after !== before) {
      const b = backup(target.rc);
      mkdirSync(dirname(target.rc), { recursive: true });
      writeFileSync(target.rc, after);
      report.push(b ? t("{file}: Block „nyxos“ eingetragen (Sicherung: {backup})", { file: target.rc, backup: b }) : t("{file}: Block „nyxos“ eingetragen (Datei war neu)", { file: target.rc }));
    } else report.push(t("{file}: Block „nyxos“ schon aktuell", { file: target.rc }));
  }
  return report;
}

export function uninstallShell(o: { rcFiles: readonly string[] }): string[] {
  const report: string[] = [];
  for (const rc of o.rcFiles) {
    if (!existsSync(rc)) continue;
    const before = readFileSync(rc, "utf8");
    const after = removeBlock(before);
    if (after === before) continue;
    const b = backup(rc);
    writeFileSync(rc, after);
    report.push(t("{file}: Block „nyxos“ entfernt (Sicherung: {backup})", { file: rc, backup: b ?? "" }));
  }
  return report;
}
