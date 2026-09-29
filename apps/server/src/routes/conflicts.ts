// Routen des Konflikte-Tabs (Registrierung hier, Logik in ../conflicts/store.ts).
// Zusammenfassung (ETag), Details seitenweise, Entscheidungs-Knöpfe, Vergleich.
import { createHash } from "node:crypto";
import { DECISION_PREFER_LABEL, DECISION_RESERVE_LABEL, GitCompareRequestSchema, parseUnifiedDiff, queryConflictEntries, type GitCompareRawResult, type GitCompareResponse, t } from "@nyxos/shared";
import type { Context, Hono } from "hono";
import type { Db } from "../db/client.js";
import { sessionFileEdits } from "../conflicts/fileEdits.js";
import { clearDismissal, ConflictModelService, registerConflictModel, setDismissal, nyxosSessions } from "../conflicts/model.js";
import { checkReservationConflict, listReservations, releaseArea, reserveArea } from "../conflicts/store.js";
import { claimSend, releaseSend } from "../delivery/queue.js";
import type { RpcOutcome } from "../terminal/bridgeHub.js";
import { NOT_FOUND, parseSerialId } from "../ids.js";

type Env = { Variables: { machineId: string } };

/** Was die Konflikt-Routen von der Brücke brauchen (BridgeHub erfüllt das strukturell). */
export interface ConflictBridge {
  readonly online: boolean;
  rpc(method: "send_text" | "interrupt" | "git_compare", params: unknown, timeoutMs?: number): Promise<RpcOutcome>;
}

const MAX_KEY = 2000;

const PREFER_LABEL = DECISION_PREFER_LABEL;
const RESERVE_LABEL = DECISION_RESERVE_LABEL;

/** Text für tmux: keine Steuerzeichen/Zeilenumbrüche (ein \n würde vorzeitig abschicken), gekürzt. */
function plain(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier genau das, was raus soll
  return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Grund, warum eine Brücken-Aktion nicht ging — die Web-App macht daraus einen verständlichen Satz. */
function bridgeReason(outcome: RpcOutcome): string {
  if (outcome.code === "bridge_offline" || outcome.code === "timeout") return "bridge_offline";
  if ((outcome.error ?? "").startsWith("Unbekannter Befehl")) return "bridge_outdated";
  if (outcome.code === "not_found") return "not_running";
  return "failed";
}

function etagMatches(header: string | undefined, etag: string): boolean {
  return (header ?? "").split(",").some((t) => t.trim() === etag || t.trim() === `W/${etag}`);
}

export function registerConflictRoutes(app: Hono<Env>, ctx: { db: Db; bridge?: ConflictBridge; model?: ConflictModelService }): void {
  const { db, bridge } = ctx;
  const model = ctx.model ?? new ConflictModelService(db, () => bridge?.online ?? false);
  registerConflictModel(db, model);

  // Alte Form (ganze Karte) — nur noch für Werkzeuge/Skripte; die Web-App nutzt `summary` + `entries`.
  app.get("/api/conflicts", async (c) => {
    const m = await model.get();
    return c.json({ collisionMap: m.all, reservations: m.summary.reservations, generatedAt: m.summary.generatedAt });
  });

  // klein (Gruppen + Entscheidungen), mit ETag — unverändert = 304 ohne Inhalt.
  app.get("/api/conflicts/summary", async (c) => {
    const version = await model.version();
    const etag = `"${version}"`;
    c.header("cache-control", "no-cache");
    if (etagMatches(c.req.header("if-none-match"), etag)) {
      c.header("etag", etag);
      return c.body(null, 304);
    }
    const m = await model.get();
    c.header("etag", `"${m.summary.version}"`);
    return c.json(m.summary);
  });

  // Details erst beim Aufklappen, seitenweise (Gruppe, Suche oder genau ein Pfad).
  app.get("/api/conflicts/entries", async (c) => {
    const q = c.req.query();
    const version = await model.version();
    const etag = `"${createHash("sha1").update(`${version}|${new URL(c.req.url).search}`).digest("hex").slice(0, 20)}"`;
    c.header("cache-control", "no-cache");
    if (etagMatches(c.req.header("if-none-match"), etag)) {
      c.header("etag", etag);
      return c.body(null, 304);
    }
    const m = await model.get();
    const page = queryConflictEntries(m, { group: q.group ?? null, q: q.q ?? null, path: q.path ?? null, offset: Number(q.offset ?? 0) || 0, limit: Number(q.limit ?? 50) || 50 });
    if (m.summary.version === version) c.header("etag", etag);
    return c.json(page);
  });

  // „Ignorieren“ / „Erledigt“ — additiver Zustand je Entscheidung.
  app.post("/api/conflicts/decisions/dismiss", async (c) => {
    const b = await readBody(c);
    const key = typeof b?.key === "string" ? b.key : "";
    const status = b?.status === "done" ? "done" : b?.status === "ignored" ? "ignored" : null;
    if (!key || key.length > MAX_KEY || !status) return c.json({ error: t("Felder 'key' und 'status' (ignored|done) fehlen") }, 400);
    await setDismissal(db, key, status);
    model.invalidate();
    return c.json({ ok: true });
  });

  app.post("/api/conflicts/decisions/reopen", async (c) => {
    const b = await readBody(c);
    const key = typeof b?.key === "string" ? b.key : "";
    if (!key || key.length > MAX_KEY) return c.json({ error: t("Feld 'key' fehlt") }, 400);
    const removed = await clearDismissal(db, key);
    model.invalidate();
    return c.json({ ok: true, removed });
  });

  // „Bereich reservieren“: den Bereich des Konflikts sperren (ohne Vorrang für eine Session) —
  // dieselbe Reservierung wie `POST /api/reservations`, nur mit dem Bereich aus der Entscheidung.
  app.post("/api/conflicts/decisions/reserve", async (c) => {
    const b = await readBody(c);
    const key = typeof b?.key === "string" ? b.key : "";
    if (!key) return c.json({ error: t("Feld 'key' fehlt") }, 400);
    const decision = (await model.get()).summary.decisions.find((d) => d.key === key);
    if (!decision) return c.json({ error: t("Diesen Konflikt gibt es nicht mehr.") }, 404);
    if (!decision.areaGlob) return c.json({ error: t("Die Dateien liegen zu verstreut, um sie gemeinsam zu reservieren.") }, 422);
    const reserved = await reserveArea(db, { pathGlob: decision.areaGlob, label: `${RESERVE_LABEL}${plain(decision.folder, 150)}`.slice(0, 200) }, { skipLearnedRules: true });
    if (!reserved.ok) return c.json({ error: reserved.check.reason, conflictingReservation: reserved.check.conflictingReservation }, 409);
    model.invalidate();
    return c.json({ reservation: reserved.reservation });
  });

  // „Session A zuerst“: Bereich für A reservieren + den anderen einen Hinweis schicken (nur wenn
  // sie in der NyxOS laufen — sonst ehrlich „nicht zugestellt“).
  app.post("/api/conflicts/decisions/prefer", async (c) => {
    const b = await readBody(c);
    const key = typeof b?.key === "string" ? b.key : "";
    const sessionKey = typeof b?.sessionKey === "string" ? b.sessionKey : "";
    if (!key || !sessionKey) return c.json({ error: t("Felder 'key' und 'sessionKey' fehlen") }, 400);
    const decision = (await model.get()).summary.decisions.find((d) => d.key === key);
    if (!decision) return c.json({ error: t("Diesen Konflikt gibt es nicht mehr.") }, 404);
    const winner = decision.sessions.find((s) => s.sessionKey === sessionKey);
    if (!winner) return c.json({ error: t("Diese Session gehört nicht zu diesem Konflikt.") }, 400);
    if (!decision.areaGlob) return c.json({ error: t("Die Dateien liegen zu verstreut, um sie gemeinsam zu reservieren.") }, 422);
    const winnerName = plain(winner.title ?? winner.sessionKey, 120);
    const reserved = await reserveArea(db, { pathGlob: decision.areaGlob, label: `${PREFER_LABEL}${winnerName}`.slice(0, 200), sessionKey }, { skipLearnedRules: true });
    if (!reserved.ok) return c.json({ error: reserved.check.reason, conflictingReservation: reserved.check.conflictingReservation }, 409);
    model.invalidate();

    const others = decision.sessions.filter((s) => s.sessionKey !== sessionKey);
    const live = await nyxosSessions(
      db,
      others.map((s) => s.sessionKey),
    );
    const text = t("Hinweis aus NyxOS: Der Nutzer hat entschieden, dass die Session „{winner}“ im Bereich {area} Vorrang hat. Bitte ändere dort vorerst keine Dateien, mach mit etwas anderem weiter und sag Bescheid, wenn du dort etwas brauchst.", { winner: winnerName, area: plain(decision.areaGlob, 300) });
    const notified: { sessionKey: string; sent: boolean; reason: string | null }[] = [];
    for (const s of others) {
      const row = live.get(s.sessionKey);
      if (!row?.tmuxName || !row.attachable || !bridge) {
        notified.push({ sessionKey: s.sessionKey, sent: false, reason: "not_in_nyxos" });
        continue;
      }
      // Nur wenn die Session gerade auf Eingabe wartet: sonst könnten die getippten Zeichen + Enter in
      // einer offenen Rückfrage landen (Erlaubnis erteilen/ablehnen).
      // Hook-Zustand als zweite Quelle — die Brücke sendet nur, wenn Hooks UND Bildschirm „wartet“ sagen.
      // nie gleichzeitig mit einer Zustellung aus der Warteschlange (20-s-Sperre je Session).
      if (!claimSend(bridge, s.sessionKey, Date.now())) {
        notified.push({ sessionKey: s.sessionKey, sent: false, reason: "busy" });
        continue;
      }
      const outcome = await bridge.rpc("send_text", { tmuxName: row.tmuxName, text, submit: true, onlyWhenWaiting: true, hookWaiting: row.state === "waiting" });
      releaseSend(bridge, s.sessionKey, (outcome.ok && (outcome.result as { sent?: boolean } | undefined)?.sent !== false) || (!outcome.ok && outcome.code === "timeout"), Date.now());
      const delivered = outcome.ok && (outcome.result as { sent?: boolean } | undefined)?.sent !== false;
      notified.push(delivered ? { sessionKey: s.sessionKey, sent: true, reason: null } : { sessionKey: s.sessionKey, sent: false, reason: outcome.ok ? "busy" : bridgeReason(outcome) });
    }
    return c.json({ reservation: reserved.reservation, notified });
  });

  // „Beide pausieren“: Esc in die tmux-Session (bricht die laufende Runde ab). Nur Sessions in der NyxOS.
  app.post("/api/conflicts/pause", async (c) => {
    const b = await readBody(c);
    const keys = Array.isArray(b?.sessionKeys) ? b.sessionKeys.filter((k): k is string => typeof k === "string").slice(0, 8) : [];
    if (keys.length === 0) return c.json({ error: t("Feld 'sessionKeys' fehlt") }, 400);
    const live = await nyxosSessions(db, keys);
    const results: { sessionKey: string; paused: boolean; reason: string | null }[] = [];
    for (const key of keys) {
      const row = live.get(key);
      if (!row?.tmuxName || !row.attachable || !bridge) {
        results.push({ sessionKey: key, paused: false, reason: "not_in_nyxos" });
        continue;
      }
      const outcome = await bridge.rpc("interrupt", { tmuxName: row.tmuxName });
      // Die Brücke drückt Esc nur bei arbeitender Session (nie in eine Freigabe-Frage/in Getipptes).
      const refused = outcome.ok ? (outcome.result as { interrupted?: boolean; reason?: string } | undefined) : undefined;
      if (refused?.interrupted === false) results.push({ sessionKey: key, paused: false, reason: refused.reason ?? "busy" });
      else results.push(outcome.ok ? { sessionKey: key, paused: true, reason: null } : { sessionKey: key, paused: false, reason: bridgeReason(outcome) });
    }
    return c.json({ results });
  });

  // Änderungen der Sessions an EINER Datei (aus dem Verlauf).
  app.get("/api/conflicts/file-changes", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: t("Query 'path' fehlt") }, 400);
    let keys = (c.req.query("sessions") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (keys.length === 0) {
      const entry = (await model.get()).all.find((e) => e.path === path);
      keys = (entry?.writers ?? []).map((w) => w.sessionKey).slice(0, 6);
    }
    return c.json({ path, sessions: await sessionFileEdits(db, keys, path) });
  });

  // zwei Stände vergleichen — NUR LESEND über die Brücke (`git log`/`git diff`).
  app.get("/api/conflicts/compare", async (c) => {
    const q = c.req.query();
    const parsed = GitCompareRequestSchema.safeParse({ path: q.path, from: q.from || undefined, to: q.to || undefined, limit: q.limit ? Number(q.limit) : undefined });
    if (!parsed.success) return c.json({ error: t("Ungültiger Pfad oder Stand.") }, 400);
    if (!bridge?.online) return c.json({ error: t("Der Rechner ist gerade nicht verbunden – der Vergleich braucht die Brücke.") }, 503);
    const outcome = await bridge.rpc("git_compare", parsed.data, 20_000);
    if (!outcome.ok) {
      const reason = bridgeReason(outcome);
      if (reason === "bridge_outdated") return c.json({ error: t("Die Brücke ist noch nicht aktualisiert – nach dem Update geht der Vergleich.") }, 503);
      if (reason === "bridge_offline") return c.json({ error: t("Der Rechner ist gerade nicht verbunden – der Vergleich braucht die Brücke.") }, 503);
      if (outcome.code === "not_in_repo") return c.json({ error: t("Diese Datei liegt in keinem Git-Ordner.") }, 404);
      if (outcome.code === "bad_ref") return c.json({ error: t("Diesen Stand gibt es in diesem Ordner nicht.") }, 400);
      if (outcome.code === "bad_folder") return c.json({ error: t("Diese Datei wird aus Sicherheitsgründen nicht verglichen (außerhalb der Projektordner, von Git ausgeblendet oder eine Verknüpfung).") }, 403);
      return c.json({ error: t("Der Vergleich hat nicht geklappt.") }, 502);
    }
    const raw = outcome.result as GitCompareRawResult;
    const body: GitCompareResponse = {
      repoRoot: raw.repoRoot,
      relPath: raw.relPath,
      commits: raw.commits,
      from: parsed.data.from ?? null,
      to: parsed.data.to ?? null,
      files: raw.diff ? parseUnifiedDiff(raw.diff) : [],
      truncated: raw.truncated,
      untracked: raw.untracked ?? false,
    };
    return c.json(body);
  });

  app.get("/api/reservations", async (c) => c.json({ reservations: await listReservations(db) }));

  // "bereich_reservieren" — REST, bis der MCP-Anschluss steht.
  app.post("/api/reservations", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const b = body as Record<string, unknown>;
    if (typeof b.pathGlob !== "string" || !b.pathGlob || typeof b.label !== "string" || !b.label) {
      return c.json({ error: t("Felder 'pathGlob' und 'label' fehlen") }, 400);
    }
    const untilMinutes = typeof b.untilMinutes === "number" ? b.untilMinutes : null;
    const sessionKey = typeof b.sessionKey === "string" ? b.sessionKey : null;
    const result = await reserveArea(db, { pathGlob: b.pathGlob, label: b.label, sessionKey, untilMinutes });
    if (!result.ok) return c.json({ error: result.check.reason, conflictingReservation: result.check.conflictingReservation }, 409);
    model.invalidate();
    return c.json({ reservation: result.reservation });
  });

  // "bereich_freigeben".
  app.delete("/api/reservations/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const ok = await releaseArea(db, id);
    model.invalidate();
    return ok ? c.json({ ok: true }) : c.json({ error: t("Nicht gefunden") }, 404);
  });

  // Reife-Check-Vorschau (der Reife-Check ruft das auf, bevor ein Auftrag "startklar" wird).
  app.get("/api/reservations/check", async (c) => {
    const pathGlob = c.req.query("pathGlob");
    if (!pathGlob) return c.json({ error: t("Query 'pathGlob' fehlt") }, 400);
    return c.json(await checkReservationConflict(db, pathGlob));
  });
}
