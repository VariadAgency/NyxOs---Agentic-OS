// Was Nyx gerade tut — `nyx.state`, `nyx.task`, `nyx.file` über die gemeinsame `/live`-Verbindung
// (liveBus), plus der Stand beim Öffnen (`GET /api/nyx/live`). Aufgaben werden je `taskId` zu einer Karte
// mit Schritt-Liste zusammengefasst (wie „Progress Drafts“ bei OpenClaw: eine Karte, die sich fortschreibt).
import { NyxStateEventSchema, NyxTaskEventSchema, type NyxFile, type NyxStateEvent, type NyxStepStatus, type NyxTaskEventOut } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { subscribeNyxLive } from "../../../lib/liveBus";
import { fetchNyxLive } from "./nyxTabApi";

export interface NyxTaskCard {
  taskId: string;
  title: string;
  status: "running" | "done" | "failed";
  where?: string;
  href?: string;
  tool?: string;
  text?: string;
  startedAt: string;
  updatedAt: string;
  steps: { index: number; label: string; status: NyxStepStatus; total?: number }[];
  images: { fileId: number; title?: string }[];
  links: { url: string; title?: string }[];
}

/** Ein Zustand vom Server gilt höchstens so lange (danach war die Meldung „fertig“ wohl verloren). */
const SERVER_STATE_TTL_MS = 120_000;

export function foldTasks(events: readonly NyxTaskEventOut[]): NyxTaskCard[] {
  const byId = new Map<string, NyxTaskCard>();
  for (const e of events) {
    let c = byId.get(e.taskId);
    if (!c) {
      c = { taskId: e.taskId, title: e.title, status: "running", startedAt: e.at, updatedAt: e.at, steps: [], images: [], links: [] };
      byId.set(e.taskId, c);
    }
    c.title = e.title || c.title;
    c.updatedAt = e.at;
    if (e.where) c.where = e.where;
    if (e.href) c.href = e.href;
    if (e.tool) c.tool = e.tool;
    if (e.text) c.text = e.text;
    if (e.phase === "done") c.status = "done";
    else if (e.phase === "failed") c.status = "failed";
    // Neuer Plan im selben Faden (gleiche Karte) → läuft wieder, alte Schritte weg.
    else if (e.phase === "started" && c.status !== "running") {
      c.status = "running";
      c.steps = [];
    }
    if (e.step) {
      const i = c.steps.findIndex((s) => s.index === e.step?.index);
      const step = { index: e.step.index, label: e.step.label, status: e.step.status, total: e.step.total };
      if (i >= 0) c.steps[i] = step;
      else c.steps.push(step);
      // Liste gekürzt (`total` kleiner): gestrichene Schritte fallen aus der Karte.
      const total = e.step.total;
      if (total !== undefined) c.steps = c.steps.filter((s) => s.index < total);
      c.steps.sort((a, b) => a.index - b.index);
    }
    if (e.image && !c.images.some((im) => im.fileId === e.image?.fileId)) c.images.push(e.image);
    if (e.link && !c.links.some((l) => l.url === e.link?.url)) c.links.push(e.link);
  }
  // Laufende zuerst, dann die jüngsten.
  return [...byId.values()].sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || b.updatedAt.localeCompare(a.updatedAt));
}

export interface NyxLive {
  serverState: (NyxStateEvent & { at: string }) | null;
  tasks: NyxTaskCard[];
  /** Zuletzt live gemeldete Datei (für „neues Bild“-Hinweis). */
  lastFile: NyxFile | null;
}

export function useNyxLive(): NyxLive {
  const [serverState, setServerState] = useState<(NyxStateEvent & { at: string }) | null>(null);
  const [events, setEvents] = useState<NyxTaskEventOut[]>([]);
  const [lastFile, setLastFile] = useState<NyxFile | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    fetchNyxLive()
      .then((snap) => {
        if (cancelled) return;
        setServerState(snap.state);
        setEvents((ev) => [...snap.tasks, ...ev]);
      })
      .catch(() => undefined);
    const off = subscribeNyxLive((msg) => {
      if (msg.type === "nyx.state") {
        const p = NyxStateEventSchema.safeParse(msg);
        if (p.success) setServerState({ ...p.data, at: typeof msg.at === "string" ? msg.at : new Date().toISOString() });
      } else if (msg.type === "nyx.task") {
        const p = NyxTaskEventSchema.safeParse(msg);
        if (p.success) setEvents((ev) => [...ev.slice(-199), { ...p.data, at: p.data.at ?? new Date().toISOString() }]);
      } else if (msg.type === "nyx.file") {
        const file = (msg as { file?: NyxFile }).file;
        if (file && typeof file.id === "number") {
          setLastFile(file);
          void qc.invalidateQueries({ queryKey: ["nyx", "files"] });
        }
      }
    });
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      cancelled = true;
      off();
      clearInterval(tick);
    };
  }, [qc]);

  const tasks = useMemo(() => foldTasks(events), [events]);
  const fresh = serverState && now - Date.parse(serverState.at) < SERVER_STATE_TTL_MS ? serverState : null;
  return { serverState: fresh, tasks, lastFile };
}
