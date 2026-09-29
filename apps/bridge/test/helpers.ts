import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeProjectDirName, type BridgeConfig } from "../src/config.js";
import { Outbox } from "../src/outbox.js";
import { openDb } from "../src/sqlite.js";

export const SHARED_FIX = join(import.meta.dirname, "..", "..", "..", "packages", "shared", "test", "fixtures");
/**
 * Projektordner der Tests: absichtlich ein Pfad, den es nicht gibt — Tests fassen nie echte Ordner an.
 * Die Verlaufs-Fixtures (packages/shared) werden beim Kopieren auf diesen Ordner umgeschrieben.
 */
export const ROOT = "/nyxos-test/projekt";
/** Ordnername, unter dem Claude die Sessions dieses Projektordners ablegt (`~/.claude/projects/<name>`). */
export const ROOT_DIR = claudeProjectDirName(ROOT);
/** Arbeitsordner, der in den Fixtures steht (`cwd` in sess-a.jsonl). */
const FIXTURE_CWD = (() => {
  const cwd = /"cwd":"([^"]+)"/.exec(readFileSync(join(SHARED_FIX, "claude", "sess-a.jsonl"), "utf8"))?.[1];
  if (!cwd) throw new Error("sess-a.jsonl ohne cwd");
  return cwd;
})();

/** Inhalt einer Fixture, mit dem Test-Projektordner statt des Fixture-Arbeitsordners. */
export function fixtureText(src: string): string {
  return readFileSync(src, "utf8").split(FIXTURE_CWD).join(ROOT);
}
export const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const CODEX_MAIN = "01a0c424-0000-7000-8000-00000000c0de";
export const CODEX_SUB = "01a0c40a-0000-7000-8000-00000000abcd";

export function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "nyxos-bruecke-"));
  const cfg: BridgeConfig = {
    serverUrl: "http://127.0.0.1:1",
    token: "test-token-123",
    tunnel: null,
    projectRoots: [ROOT],
    claudeDir: join(home, ".claude"),
    codexDir: join(home, ".codex"),
    terminal: null, // Terminal-Dienst in diesen Tests aus (eigene Tests in terminal.test.ts)
  };
  const proj = join(cfg.claudeDir, "projects", ROOT_DIR);
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(cfg.codexDir, "sessions", "2026", "09", "21"), { recursive: true });
  const put = (dest: string, src: string) => {
    mkdirSync(dirname(dest), { recursive: true });
    if (/\.jsonl?$/.test(src)) writeFileSync(dest, fixtureText(src));
    else copyFileSync(src, dest);
    return dest;
  };
  const claudeMain = () => put(join(proj, `${SID_A}.jsonl`), join(SHARED_FIX, "claude", "sess-a.jsonl"));
  const claudeSub = () => {
    const base = join(proj, SID_A, "subagents", "agent-a0000000000000001");
    put(`${base}.meta.json`, join(SHARED_FIX, "claude", "sess-a", "subagents", "agent-a0000000000000001.meta.json"));
    return put(`${base}.jsonl`, join(SHARED_FIX, "claude", "sess-a", "subagents", "agent-a0000000000000001.jsonl"));
  };
  const codexMain = () =>
    put(
      join(cfg.codexDir, "sessions", "2026", "09", "21", `rollout-2026-09-21T15-25-10-${CODEX_MAIN}.jsonl`),
      join(SHARED_FIX, "codex", `rollout-2026-09-21T15-25-10-${CODEX_MAIN}.jsonl`),
    );
  const codexSub = () =>
    put(
      join(cfg.codexDir, "sessions", "2026", "09", "21", `rollout-2026-09-21T14-56-55-${CODEX_SUB}.jsonl`),
      join(SHARED_FIX, "codex", `rollout-2026-09-21T14-56-55-${CODEX_SUB}.jsonl`),
    );
  const codexIndex = () => put(join(cfg.codexDir, "session_index.jsonl"), join(SHARED_FIX, "codex", "session_index.jsonl"));
  /** Schreibt eine Kopie einer Fixture mit ersetztem Text (z. B. anderem Arbeitsordner). */
  const variant = (dest: string, src: string, ...pairs: [string, string][]) => {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, pairs.reduce((text, [from, to]) => text.split(from).join(to), fixtureText(src)));
    return dest;
  };
  return { home, cfg, proj, claudeMain, claudeSub, codexMain, codexSub, codexIndex, variant };
}

export async function newOutbox(dir: string) {
  return new Outbox(await openDb(join(dir, "buffer.sqlite")));
}

export const noLog = () => {};
