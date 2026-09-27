import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { IngestItem, SessionEvent, Tool } from "@nyxos/shared";
import { inProjects } from "./config.js";
import type { Outbox } from "./outbox.js";
import type { Log } from "./tracker.js";

/**
 * Der Hook (ein Shell-Skript, < 10 ms) legt je Aufruf eine Datei
 * `<pid>-<zufall>-<Event>-<werkzeug>.json` in den Spool-Ordner. Hier wird sie
 * zum Event, landet im Puffer und wird danach gelöscht.
 */
const NAME = /^(\d+-\d*)-([A-Za-z]+)-(claude|codex)\.json$/;

const s = (v: unknown, max = 300): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);

export function hookEvent(fileName: string, payload: Record<string, unknown>, receivedAt: Date, projectRoots: readonly string[]): SessionEvent | null {
  const m = NAME.exec(fileName);
  if (!m) return null;
  const [, nonce, event, tool] = m as unknown as [string, string, string, Tool];
  const sessionId = s(payload.session_id, 100);
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  if (!inProjects(s(payload.cwd, 2000), projectRoots)) return null;
  const input = typeof payload.tool_input === "object" && payload.tool_input ? (payload.tool_input as Record<string, unknown>) : {};
  const data: Record<string, unknown> = { event, cwd: s(payload.cwd, 2000) };
  const extra: Record<string, string | null> = {
    source: s(payload.source),
    reason: s(payload.reason),
    toolName: s(payload.tool_name),
    target: s(input.file_path) ?? s(input.command, 200) ?? s(input.pattern) ?? null,
    prompt: s(payload.prompt, 500),
    agentType: s(payload.agent_type),
    model: s(payload.model),
    transcriptPath: s(payload.transcript_path, 2000),
  };
  for (const [k, v] of Object.entries(extra)) if (v !== null) data[k] = v;
  return {
    id: `hook:${tool}:${sessionId}:${nonce}-${event}`,
    tool,
    sessionId,
    ts: receivedAt.toISOString(),
    kind: "hook",
    source: "hook",
    data,
  };
}

export async function drainSpool(
  dir: string,
  outbox: Outbox,
  projectRoots: readonly string[],
  log: Log,
): Promise<{ events: SessionEvent[]; files: number }> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  const events: SessionEvent[] = [];
  const done: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const [text, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {
        log("hook-kaputt", { name });
      }
      if (payload && typeof payload === "object") {
        // Manche Linux-Dateisysteme kennen keine Erstellzeit (0) — dann gilt die Schreibzeit.
        const e = hookEvent(name, payload as Record<string, unknown>, st.birthtimeMs > 0 ? st.birthtime : st.mtime, projectRoots);
        if (e) events.push(e);
      }
      done.push(path);
    } catch {
      // Datei inzwischen weg oder unlesbar: beim nächsten Durchlauf erneut.
    }
  }
  if (events.length > 0) outbox.enqueue(events.map((event): IngestItem => ({ type: "event", event })));
  // Erst nach dem Speichern im Puffer löschen: stürzt die Brücke vorher ab, bleibt die Datei liegen.
  await Promise.all(done.map((p) => unlink(p).catch(() => {})));
  return { events, files: done.length };
}

/**
 * Das Hook-Skript. Muss schnell sein (reines sh, < 50 ms), darf nie etwas ausgeben und endet bei `hook`
 * immer mit 0. Nur die Leitplanke einer Auftrags-Session (`guard` mit NYXOS_AUFTRAG) startet node.
 */
export function hookScript(spoolDir: string, node: string, entry: string): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# NyxOS-Brücke. Schneller Pfad für Hooks: stdin in eine Spool-Datei, sonst nichts.
# Leitplanke: ohne NYXOS_AUFTRAG (eigene Sessions des Nutzers) sofort erlauben, ohne Programmstart.
if [ "$1" = "guard" ] && [ -z "\${NYXOS_AUFTRAG:-}" ]; then
  cat >/dev/null 2>&1
  exit 0
fi
if [ "$1" = "hook" ]; then
  # dash (Linux-/bin/sh) kennt kein $RANDOM: dann eine Zufallszahl aus /dev/urandom.
  r="\${RANDOM:-}\${RANDOM:-}"
  [ -n "$r" ] || r=$(od -An -N4 -tu4 /dev/urandom 2>/dev/null | tr -dc 0-9)
  f=${q(spoolDir)}/"$$-$r-\${2:-Unbekannt}-\${3:-claude}"
  { cat > "$f.tmp" && mv -f "$f.tmp" "$f.json"; } >/dev/null 2>&1
  exit 0
fi
exec ${q(node)} --disable-warning=ExperimentalWarning ${q(entry)} "$@"
`;
}
