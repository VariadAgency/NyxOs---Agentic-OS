// eigene Route-Datei für Aufgaben/Bugs/Audit/Ideen/Entscheidungen/Fragen. In app.ts nur
// eine Registrierungszeile (`app.route("/api/entries", entriesRoutes(deps))`).
import { realpathSync } from "node:fs";
import { CreateEntrySchema, EntryKindSchema, EntryStageSchema, LinkEntrySchema, MODEL_NAME_RE, t } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { applyCommitToEntries } from "../entries/gitWatcher.js";
import { getDoc, isMirrorable, mirrorDocs } from "../entries/docMirror.js";
import { importAudit, importGoals } from "../entries/import.js";
import type { EntriesImportService } from "../entries/importService.js";
import { computeStartPlan, executeStart, type BridgeRpc } from "../entries/start.js";
import { applyMaturity, applyMaturityToAllPlanned, completeSubtask, createEntry, getEntry, getEntryDetail, linkObjects, listEntries, reportProgress, updateEntryFields } from "../entries/store.js";
import { entries } from "../db/schema.js";
import type { Db } from "../db/client.js";
import type { GraphService } from "../graph/service.js";
import type { LiveHub } from "../live.js";
import { NOT_FOUND, parseSerialId } from "../ids.js";

/** Hinweis: `POST .../import/goals?root=` und `.../import/audit?path=` lasen
 * bisher jeden Pfad im Container/auf dem Server — auch mit dem Maschinen-Token. Feste Wurzel: nur
 * `NYXOS_IMPORT_ROOT` bzw. was darunter per realpath wirklich liegt (löst `..`/Symlinks auf — ein
 * naiver `startsWith`-Vergleich täte das nicht). Ist keine Wurzel gesetzt oder existiert sie auf diesem
 * Server nicht, lehnt das jede Anfrage sauber ab, statt abzustürzen. */
function importRoot(): string | null {
  return process.env.NYXOS_IMPORT_ROOT?.trim() || null;
}

function resolveUnderImportRoot(candidate: string): string | null {
  let root: string;
  let real: string;
  try {
    const configured = importRoot();
    if (!configured) return null;
    root = realpathSync(configured);
  } catch {
    return null; // Wurzel existiert auf diesem Server (noch) nicht
  }
  try {
    real = realpathSync(candidate);
  } catch {
    return null; // Pfad existiert nicht
  }
  if (real !== root && !real.startsWith(root + "/")) return null;
  return real;
}

export function entriesRoutes(deps: { db: Db; hub?: LiveHub; graph?: GraphService; bridgeHub?: BridgeRpc; importer?: EntriesImportService }) {
  const { db } = deps;
  // jede Änderung geht auch über /live raus, damit die
  // Web-App ohne Klick/Neuladen nachzieht (wie bei Sessions, s. `useLiveSocket.ts`). Kein `hub` in
  // Tests, die nur die HTTP-Antwort prüfen — dann ist Broadcasting einfach ein No-op.
  // PG-Zusammenbau: dieselbe Stelle markiert die Graph-Quelle "entries" als veraltet — jede
  // schreibende Route hier ruft `notify`, das ist der eine Durchlass für beides.
  const notify = (entryId: number) => {
    deps.hub?.broadcast({ type: "entry", entryId });
    deps.graph?.markDirty(["entries"]);
  };
  const app = new Hono();

  app.get("/", async (c) => {
    const q = c.req.query("q") ?? undefined;
    const kindRaw = c.req.query("kind");
    const stageRaw = c.req.query("stage");
    const kind = kindRaw && EntryKindSchema.safeParse(kindRaw).success ? (kindRaw as never) : undefined;
    const stage = stageRaw && EntryStageSchema.safeParse(stageRaw).success ? (stageRaw as never) : undefined;
    return c.json({ entries: await listEntries(db, { q, kind, stage, limit: 1000 }) });
  });

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = CreateEntrySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültiger Körper"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const entry = await createEntry(db, { ...parsed.data, source: "api" });
    await applyMaturity(db, entry.id);
    notify(entry.id);
    return c.json({ entry: await getEntry(db, entry.id) }, 201);
  });

  // Start-Blatt: Schätzung/Modell/Priorität/Dateibereich von Hand nachtragen —
  // NIE stage/kind (die setzt nur die Automatik bzw. `promote`). Löst danach den Reife-Check neu aus.
  app.patch("/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const b = body as { estimate?: string; modelSuggestion?: string; priority?: string; fileScope?: string[] };
    // `modelSuggestion` landet ohne diese Prüfung später ungefiltert im Start-Befehl
    // (s. entries/start.ts) — Whitelist per Regex (bekannte Modell-Namen/Aliase, kein führendes `-`).
    if (b.modelSuggestion !== undefined && b.modelSuggestion !== null && !MODEL_NAME_RE.test(b.modelSuggestion)) {
      return c.json({ error: t("Ungültiger Modell-Name") }, 400);
    }
    const updated = await updateEntryFields(db, id, b);
    if (!updated) return c.json({ error: t("Nicht gefunden") }, 404);
    await applyMaturity(db, id);
    notify(id);
    return c.json({ entry: await getEntry(db, id) });
  });

  app.get("/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const detail = await getEntryDetail(db, id);
    if (!detail) return c.json({ error: t("Nicht gefunden") }, 404);
    return c.json(detail);
  });

  // Kein allgemeiner Lösch-Endpunkt (Löschen braucht sonst eine Freigabe) — NUR zum Aufräumen der
  // Playwright-Testdaten aus `p4-tasks-ideas.spec.ts` (der Test legt bei jedem Lauf einen Bug mit
  // festem Präfix an). Löscht ausschließlich Einträge, deren Titel exakt mit diesem Präfix beginnt —
  // jede andere ID gibt 403, damit dieser Weg nie für echte Daten nutzbar ist.
  const TEST_CLEANUP_PREFIX = "Live-Update-Beweis ";
  app.delete("/:id", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const entry = await getEntry(db, id);
    if (!entry) return c.json({ error: t("Nicht gefunden") }, 404);
    if (!entry.title.startsWith(TEST_CLEANUP_PREFIX)) {
      return c.json({ error: t("Nur Test-Einträge mit Präfix \"{prefix}\" löschbar", { prefix: TEST_CLEANUP_PREFIX }) }, 403);
    }
    await db.delete(entries).where(eq(entries.id, id));
    notify(id);
    return c.json({ ok: true });
  });

  app.post("/:id/maturity", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const result = await applyMaturity(db, id);
    if (!result) return c.json({ error: t("Nicht gefunden") }, 404);
    return c.json(result);
  });

  app.post("/maturity/recompute-all", async (c) => c.json({ results: (await applyMaturityToAllPlanned(db)).map((r) => ({ id: r.entry.id, stage: r.entry.stage, passed: r.maturity.passed })) }));

  app.post("/:id/subtasks/complete", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const b = (body ?? {}) as { subtaskId?: number; subtaskTitle?: string; sessionKey?: string };
    const entry = await completeSubtask(db, { entryId: id, subtaskId: b.subtaskId, subtaskTitle: b.subtaskTitle, sessionKey: b.sessionKey ?? null, source: "api" });
    if (!entry) return c.json({ error: t("Nicht gefunden") }, 404);
    notify(id);
    return c.json({ entry });
  });

  app.post("/:id/progress", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const b = body as { note?: string; sessionKey?: string };
    if (!b.note) return c.json({ error: t("Feld 'note' fehlt") }, 400);
    const entry = await reportProgress(db, { entryId: id, note: b.note, sessionKey: b.sessionKey ?? null, source: "api" });
    if (!entry) return c.json({ error: t("Nicht gefunden") }, 404);
    notify(id);
    return c.json({ entry });
  });

  app.post("/link", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const parsed = LinkEntrySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: t("Ungültiger Körper"), issues: parsed.error.issues.slice(0, 5) }, 400);
    const row = await linkObjects(db, { ...parsed.data, source: "api" });
    return c.json({ link: row });
  });

  // „In Aufgaben übernehmen" — nur bei Stufe "konzept_fertig", wechselt kind weg von "idee".
  app.post("/:id/promote", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const [row] = await db.select().from(entries).where(eq(entries.id, id));
    if (!row) return c.json({ error: t("Nicht gefunden") }, 404);
    if (row.kind !== "idee" || row.stage !== "konzept_fertig") return c.json({ error: t("Nur eine Idee mit fertigem Konzept kann übernommen werden") }, 409);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // ohne Körper: Standard-Zielart "aufgabe"
    }
    const targetKind = (body as { kind?: string })?.kind === "bug" ? "bug" : "aufgabe";
    await db.update(entries).set({ kind: targetKind, stage: "geplant", updatedAt: new Date().toISOString() }).where(eq(entries.id, id));
    await applyMaturity(db, id);
    notify(id);
    return c.json({ entry: await getEntry(db, id) });
  });

  app.get("/:id/start-plan", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const entry = await getEntry(db, id);
    if (!entry) return c.json({ error: t("Nicht gefunden") }, 404);
    return c.json(computeStartPlan(entry));
  });

  app.post("/:id/start", async (c) => {
    const id = parseSerialId(c.req.param("id"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const entry = await getEntry(db, id);
    if (!entry) return c.json({ error: t("Nicht gefunden") }, 404);
    if (entry.stage !== "startklar") return c.json({ error: t("Nur startklare Einträge können gestartet werden") }, 409);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // Standard-Werte unten
    }
    const b = (body ?? {}) as { model?: string; dryRun?: boolean };
    const model = b.model ?? entry.modelSuggestion ?? "sonnet";
    // Injektionsbeispiel der Kritik (`"x; touch /tmp/pwn"`) muss hier 400 geben,
    // bevor überhaupt eine Brücken-RPC versucht wird — nie erst bei der Ausführung merken.
    if (!MODEL_NAME_RE.test(model)) return c.json({ error: t("Ungültiger Modell-Name") }, 400);
    if (!deps.bridgeHub) return c.json({ error: t("Brücke nicht verbunden") }, 503);
    const result = await executeStart(db, entry, deps.bridgeHub, { model, dryRun: b.dryRun ?? false });
    notify(id);
    return c.json(result, result.ok ? 200 : 500);
  });

  // Git-Wächter-Grundform (Schritt 5): kann von einem Post-Commit-Hook aufgerufen werden (P5 baut den
  // echten `git log`-Feed dazu); hier schon voll funktionsfähig und getestet.
  app.post("/git/commit", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const b = body as { sha?: string; message?: string };
    if (!b.sha || !b.message) return c.json({ error: t("Felder 'sha'/'message' fehlen") }, 400);
    const matched = await applyCommitToEntries(db, { sha: b.sha, message: b.message });
    if (matched.length > 0) deps.graph?.markDirty(["entries"]);
    return c.json({ matched });
  });

  // Doku-Spiegel (Schritt 2): Server-Seite, s. entries/docMirror.ts.
  app.post("/docs/mirror", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: t("Kein gültiges JSON") }, 400);
    }
    const items = (body as { docs?: { path: string; content: string }[] })?.docs ?? [];
    return c.json(await mirrorDocs(db, items));
  });

  app.get("/docs/*", async (c) => {
    const path = c.req.path.replace(/^.*\/docs\//, "");
    if (!isMirrorable(path)) return c.json({ error: t("Nicht gefunden") }, 404);
    const doc = await getDoc(db, path);
    if (!doc) return c.json({ error: t("Nicht gefunden") }, 404);
    return c.json(doc);
  });

  // Stand des Imports (für Leer-Texte und die „Stand“-Zeile) und „Jetzt importieren“.
  // Schreibend → braucht die Anmeldung (auth.gate); liest die Dateien aus dem letzten Stand, den die
  // Brücke geliefert hat, und die Ideen frisch aus dem Postfach.
  app.get("/import/status", async (c) => {
    if (!deps.importer) return c.json({ error: t("Import nicht eingerichtet") }, 503);
    c.header("Cache-Control", "no-store");
    return c.json(await deps.importer.status());
  });

  app.post("/import/run", async (c) => {
    if (!deps.importer) return c.json({ error: t("Import nicht eingerichtet") }, 503);
    return c.json({ status: await deps.importer.runAll() });
  });

  // Import (Schritt 3): lesend gegen das Mac-Repo, damit ein Betreiber/CLI-Aufruf ihn manuell
  // auslösen kann (deploy-seitig läuft er später zeitgesteuert). `root` ist der Projekt-Ordner.
  app.post("/import/goals", async (c) => {
    const root = (c.req.query("root") ?? "").trim();
    if (!root) return c.json({ error: t("Query 'root' fehlt (Pfad zum Projekt-Ordner)") }, 400);
    const real = resolveUnderImportRoot(root);
    if (!real) return c.json({ error: t("Wurzel liegt nicht unter der erlaubten Import-Wurzel oder existiert nicht") }, 400);
    return c.json(await importGoals(db, { root: real }));
  });

  app.post("/import/audit", async (c) => {
    const path = (c.req.query("path") ?? "").trim();
    if (!path) return c.json({ error: t("Query 'path' fehlt (Pfad zu MASSNAHMENPLAN.md)") }, 400);
    const real = resolveUnderImportRoot(path);
    if (!real) return c.json({ error: t("Pfad liegt nicht unter der erlaubten Import-Wurzel oder existiert nicht") }, 400);
    return c.json(await importAudit(db, real));
  });

  return app;
}
