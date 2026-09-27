// Reife-Check, eine getestete Funktion. Stufe "startklar" setzt NUR diese Funktion
// (nie ein Mensch oder Agent von Hand) — s. store.ts `applyMaturity`. Sechs feste Punkte.
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { docs, entries, links, sessionFiles, sessions } from "../db/schema.js";
import { visibleSession } from "../db/visible.js";
import type { EntryRow } from "./types.js";
import { t } from "@nyxos/shared";

export interface MaturityCheckPoint {
  key: "ziel_abnahme" | "dateibereich" | "keine_offene_entscheidung" | "vorgaenger_abgenommen" | "kein_konflikt" | "budget_passt";
  label: string;
  passed: boolean;
  reason: string;
}
export interface MaturityResult {
  points: MaturityCheckPoint[];
  passed: boolean;
  passedCount: number;
  totalCount: number;
}

/** Prüft, ob ein Dateibereich-Eintrag (Glob-artig, z. B. "App/backend/**") mit einem tatsächlichen
 * Dateipfad überlappt — bis P5 (echte Kollisionskarte) reicht ein einfacher Präfix-/Teilstring-Test. */
function scopeOverlapsPath(scopeEntry: string, path: string): boolean {
  const prefix = scopeEntry.replace(/\*+$/, "").replace(/\/+$/, "");
  if (prefix.length === 0) return false;
  return path.startsWith(prefix) || path.includes(prefix);
}

export async function computeMaturity(db: Db, entry: EntryRow): Promise<MaturityResult> {
  const points: MaturityCheckPoint[] = [];

  // 1. Ziel + Abnahme vorhanden: bei importierten Aufträgen (Quelle "goal") muss das gespiegelte
  //    Dokument echte "ZIEL"/"ABNAHME"-Abschnitte haben (GOAL.md-Konvention dieses Repos), sonst
  //    genügt eine ausgefüllte Beschreibung.
  let zielAbnahme = (entry.description ?? "").trim().length > 0;
  let zielReason = zielAbnahme ? t("Beschreibung vorhanden") : t("Keine Beschreibung");
  if (entry.kind === "aufgabe" && entry.sourceType === "goal") {
    const linkedDocs = await db
      .select({ path: links.toId })
      .from(links)
      .where(and(eq(links.fromType, "entry"), eq(links.fromId, String(entry.id)), eq(links.toType, "doc")));
    if (linkedDocs.length === 0) {
      zielAbnahme = false;
      zielReason = t("Kein Planungsdokument verknüpft");
    } else {
      const rows = await db.select({ content: docs.content }).from(docs).where(
        inArray(
          docs.path,
          linkedDocs.map((d) => d.path),
        ),
      );
      const hasZiel = rows.some((r) => /##\s*ZIEL/i.test(r.content));
      const hasAbnahme = rows.some((r) => /##\s*ABNAHME/i.test(r.content));
      zielAbnahme = hasZiel && hasAbnahme;
      zielReason = zielAbnahme ? t("GOAL.md hat ZIEL und ABNAHME") : !hasZiel && !hasAbnahme ? t("GOAL.md fehlt: ZIEL und ABNAHME") : !hasZiel ? t("GOAL.md fehlt: ZIEL") : t("GOAL.md fehlt: ABNAHME");
    }
  }
  points.push({ key: "ziel_abnahme", label: t("Ziel + Abnahme vorhanden"), passed: zielAbnahme, reason: zielReason });

  // 2. Dateibereich angegeben
  const hasScope = entry.fileScope.length > 0;
  points.push({ key: "dateibereich", label: t("Dateibereich angegeben"), passed: hasScope, reason: hasScope ? t("{n} Pfad(e)/Muster", { n: entry.fileScope.length }) : t("Kein Dateibereich gesetzt") });

  // 3. Keine offene Entscheidung/Frage verweist darauf (eingehender Link von einem "entscheidung"-
  //    oder "frage"-Eintrag, dessen Stufe noch nicht "erledigt" ist).
  const incoming = await db
    .select({ fromId: links.fromId, relation: links.relation })
    .from(links)
    .where(and(eq(links.toType, "entry"), eq(links.toId, String(entry.id))));
  const blockingIds = incoming.filter((l) => l.relation === "blockiert" || l.relation === "entscheidung").map((l) => Number(l.fromId));
  let noOpenDecision = true;
  let decisionReason = t("Keine verweisende Entscheidung/Frage");
  if (blockingIds.length > 0) {
    const blockers = await db.select({ id: entries.id, kind: entries.kind, stage: entries.stage, title: entries.title }).from(entries).where(inArray(entries.id, blockingIds));
    const open = blockers.filter((b) => (b.kind === "entscheidung" || b.kind === "frage") && b.stage !== "erledigt");
    noOpenDecision = open.length === 0;
    decisionReason = noOpenDecision ? t("{n} verweisende Entscheidung(en), alle erledigt", { n: blockers.length }) : t("Offen: {list}", { list: open.map((o) => o.title).join(", ") });
  }
  points.push({ key: "keine_offene_entscheidung", label: t("Keine offene Entscheidung verweist darauf"), passed: noOpenDecision, reason: decisionReason });

  // 4. Vorgänger abgenommen (Link "vorgaenger" von diesem Eintrag auf einen anderen, dessen Stufe
  //    "erledigt" ist). Ohne Vorgänger-Link: besteht trivial.
  const predLinks = await db.select({ toId: links.toId }).from(links).where(and(eq(links.fromType, "entry"), eq(links.fromId, String(entry.id)), eq(links.relation, "vorgaenger")));
  let predecessorDone = true;
  let predReason = t("Kein Vorgänger");
  if (predLinks.length > 0) {
    const preds = await db.select({ id: entries.id, stage: entries.stage, title: entries.title }).from(entries).where(
      inArray(
        entries.id,
        predLinks.map((p) => Number(p.toId)),
      ),
    );
    const open = preds.filter((p) => p.stage !== "erledigt");
    predecessorDone = open.length === 0;
    predReason = predecessorDone ? t("Vorgänger erledigt: {list}", { list: preds.map((p) => p.title).join(", ") }) : t("Noch offen: {list}", { list: open.map((p) => p.title).join(", ") });
  }
  points.push({ key: "vorgaenger_abgenommen", label: t("Vorgänger abgenommen"), passed: predecessorDone, reason: predReason });

  // 5. Kein Konflikt mit laufenden Sessions (bis überlappender Dateibereich mit einer laufenden
  //    Session — grob über session_files der Sessions mit state='laeuft').
  let noConflict = true;
  let conflictReason = t("Kein Dateibereich oder keine laufende Session überschneidet sich");
  if (hasScope) {
    const runningFiles = await db
      .select({ path: sessionFiles.path, sessionKey: sessionFiles.sessionKey })
      .from(sessionFiles)
      .innerJoin(sessions, eq(sessions.id, sessionFiles.sessionKey))
      .where(and(eq(sessions.state, "laeuft"), visibleSession, ne(sessions.id, entry.startedSessionKey ?? "")));
    const hits = runningFiles.filter((f) => entry.fileScope.some((scope) => scopeOverlapsPath(scope, f.path)));
    noConflict = hits.length === 0;
    if (!noConflict) conflictReason = t("Überschneidung mit laufender Session bei {n} Datei(en)", { n: hits.length });
  }
  points.push({ key: "kein_konflikt", label: t("Kein Konflikt mit laufenden Sessions"), passed: noConflict, reason: conflictReason });

  // 6. Budget passt (bis Schätzung vorhanden)
  const hasEstimate = (entry.estimate ?? "").trim().length > 0;
  points.push({ key: "budget_passt", label: t("Budget passt (Schätzung vorhanden)"), passed: hasEstimate, reason: hasEstimate ? t("Schätzung: {estimate}", { estimate: entry.estimate }) : t("Keine Schätzung hinterlegt") });

  const passedCount = points.filter((p) => p.passed).length;
  return { points, passed: passedCount === points.length, passedCount, totalCount: points.length };
}
