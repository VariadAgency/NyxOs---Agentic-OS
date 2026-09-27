// „Neuer Skill“, „Verbessern“, „Vorschlag umsetzen“ – IMMER als sichtbare, temporäre Claude-Session mit
// Opus 5.5 (`skillJobModel()`, nie Haiku, egal was Einstellungen oder Anfrage sagen). Vor dem Start sichert die
// Brücke den Skill-Ordner; der Stand davor landet im Verlauf. Der Auftrag folgt den Anthropic-Skill-Regeln
// (agentskills.io, skill-creator) und den Schreibregeln der Hermes-Lernschleife (MIT, s. NOTICE).
import { SKILL_JOB_KIND_LABEL, skillJobModel, t, type SkillBackupResult, type SkillCreateTarget, type SkillJob, type SkillJobRequest, type StartResult } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, skillJobs, skillSuggestions, skillVersions, skills } from "../db/schema.js";
import { sessionHref } from "../haiku/sources.js";
import { recordStartedSession } from "../terminal/started.js";
import { SkillServiceError, type SkillService } from "./library.js";

/** Regeln für jeden Skill-Auftrag (Anthropic Agent Skills + Hermes `_LESSON_LAYER_BLOCK`/`_DO_NOT_CAPTURE_BLOCK`, übersetzt). */
const RULES = `So sieht ein guter Skill aus (Anthropic-Skill-Regeln, agentskills.io):
- Ordner mit SKILL.md. Kopf (YAML): \`name\` = Ordnername (klein, Bindestriche, höchstens 64 Zeichen) und \`description\`
  (höchstens 1024 Zeichen): WAS der Skill macht und WANN er greifen soll, mit typischen Sätzen vom Nutzer als Auslöser.
- SKILL.md kurz halten (unter 500 Zeilen): Ablauf zuerst, in der Reihenfolge der Arbeit, mit den konkreten Befehlen und Entscheidungen.
  Stolperfallen stehen beim Schritt, den sie betreffen: eine Regel plus ein kurzer Grund.
- Tiefe Details nach \`references/\`, wiederkehrende Hilfsskripte nach \`scripts/\` (statt sie jedes Mal neu zu schreiben).
- Am Ende ein Abschnitt „Prüfen“: woran man sieht, dass das Ergebnis stimmt.

Schreibregeln (Hermes-Lernschleife):
- Regeln statt Protokoll: keine Daten, Ticketnummern oder Nacherzählung einer Session. Die Regel muss ohne den Vorfall stehen.
- Dieselbe Lektion nur einmal: erst im Skill suchen, dann die vorhandene Regel schärfen statt eine zweite anzuhängen.
- Falsches an Ort und Stelle korrigieren (den irreführenden Satz ändern), nie „UPDATE: …“ darunter schreiben.
- Keine Umgebungs-Fehler als Regel (fehlendes Programm, fehlender Login) und keine Sätze wie „Werkzeug X geht nicht“.
- Nichts doppeln, was CLAUDE.md oder die Werkzeug-Beschreibungen schon sagen.

Vorgehen:
- Wenn der Skill \`anthropic-skills:skill-creator\` verfügbar ist, nutze sein Muster: 2–3 realistische Testanfragen, kurz mit und ohne
  Skill vergleichen, die Beschreibung auf gutes Auslösen prüfen. Halte es schlank – kein großer Testlauf.
- Schreib NUR in den genannten Skill-Ordner. Lösche nichts. Die Sicherung liegt schon bereit.
- Sag dem Nutzer zuerst in 3–5 einfachen Sätzen, was du vorhast, und setz es dann um.
- Zum Schluss: kurze Zusammenfassung auf Deutsch (was geändert wurde, warum) und die Frage, ob es so passt.`;

function join(...parts: (string | null | false | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}

export interface JobResult {
  job: SkillJob;
}

/** Arbeitsordner der Session: Projekt-Skills im jeweiligen Repo, persönliche Skills im Projektordner (+ `--add-dir`). */
function workDirFor(dir: string, projectRoot: string): string {
  const m = /^(.*)\/\.claude\/skills\/[^/]+$/.exec(dir);
  const repo = m?.[1];
  return repo && (repo === projectRoot || repo.startsWith(`${projectRoot}/`)) ? repo : projectRoot;
}

export async function startSkillJob(service: SkillService, db: Db, req: SkillJobRequest): Promise<JobResult> {
  const { bridgeHub } = service.d;
  if (service.bridgeState() === "offline") throw new SkillServiceError(t("Der Rechner ist gerade nicht verbunden. Sobald er online ist, geht es."), 503);
  if (service.bridgeState() === "zu_alt") throw new SkillServiceError(t("Die Brücke ist noch auf einem alten Stand. Nach dem nächsten Update geht es."), 503);
  if (!service.roots) await service.sync(true);
  const roots = service.roots;
  if (!roots) throw new SkillServiceError(t("Die Skills vom Mac ließen sich gerade nicht lesen. Bitte gleich noch einmal."), 502);
  const model = skillJobModel();

  let skillKey: string;
  let skillPath: string;
  let skillDir: string;
  let cwd: string;
  let suggestionId: number | null = null;
  let task: string;

  if (req.kind === "create") {
    skillKey = req.name;
    const [exists] = await db.select({ key: skills.key }).from(skills).where(eq(skills.key, req.name)).limit(1);
    if (exists) throw new SkillServiceError(t("Einen Skill „{name}“ gibt es schon. Nimm „Verbessern“ oder einen anderen Namen.", { name: req.name }), 409);
    const target: SkillCreateTarget = req.target;
    skillDir = `${roots.targets[target]}/${req.name}`;
    skillPath = `${skillDir}/SKILL.md`;
    cwd = target === "user" ? roots.projectRoot : workDirFor(skillDir, roots.projectRoot);
    task = join(
      `Aufgabe: Leg den neuen Skill „${req.name}“ an.`,
      `Datei: ${skillPath}`,
      `Was der Skill können soll (der Nutzer):\n${req.brief}`,
      "Prüf vorher, ob ein vorhandener Skill das schon fast abdeckt (Liste der Skills in deinem Kontext). Wenn ja: sag es dem Nutzer und schlag vor, stattdessen den vorhandenen zu verbessern.",
    );
  } else {
    let key: string;
    let suggestionText: string | null = null;
    if (req.kind === "apply") {
      const [s] = await db.select().from(skillSuggestions).where(eq(skillSuggestions.id, req.suggestionId)).limit(1);
      if (!s) throw new SkillServiceError(t("Diesen Vorschlag gibt es nicht mehr."), 404);
      if (s.status === "umgesetzt") throw new SkillServiceError(t("Dieser Vorschlag ist schon umgesetzt."), 409);
      key = s.skillKey;
      suggestionId = s.id;
      suggestionText = join(`Vorschlag von Nyx:`, `Problem: ${s.problem}`, `Beleg aus einer Session: ${s.evidence}`, `Idee: ${s.idea}`);
    } else {
      key = req.skillKey;
    }
    const [row] = await db.select().from(skills).where(eq(skills.key, key)).limit(1);
    if (!row) throw new SkillServiceError(t("Diesen Skill gibt es nicht mehr."), 404);
    if (!row.writable || !row.dir || !row.skillPath) {
      throw new SkillServiceError(row.source === "plugin" ? t("Plugin-Skills gehören dem Plugin und lassen sich hier nicht ändern.") : t("Diesen Skill kann NyxOS nicht ändern (Claude.ai oder eingebaut)."), 409);
    }
    if (row.missingSince) throw new SkillServiceError(t("Der Skill-Ordner fehlt inzwischen auf dem Rechner."), 409);
    skillKey = key;
    skillDir = row.dir;
    skillPath = row.skillPath;
    cwd = workDirFor(row.dir, roots.projectRoot);
    task = join(
      req.kind === "apply" ? `Aufgabe: Setz den Vorschlag von Nyx für den Skill „${key}“ um.` : `Aufgabe: Verbessere den Skill „${key}“.`,
      `Datei: ${skillPath} (Ordner ${skillDir})`,
      suggestionText,
      req.brief ? `Wunsch vom Nutzer:\n${req.brief}` : null,
      "Lies zuerst die ganze SKILL.md und die Dateien im Ordner. Ändere so wenig wie nötig und so viel wie sinnvoll.",
    );
  }

  // Vor jedem Überschreiben: Sicherung auf dem Rechner, Stand davor im Verlauf.
  let backupDir: string | null = null;
  if (req.kind !== "create") {
    const b = await bridgeHub.rpc("skill_backup", { dir: skillDir, label: "vor-opus" }, 20_000);
    if (!b.ok) throw new SkillServiceError(t("Die Sicherung des Skills hat nicht geklappt – darum startet nichts. Bitte gleich noch einmal."), 502);
    const backup = b.result as SkillBackupResult;
    backupDir = backup.backupDir;
    if (backup.content !== null && backup.sha256) {
      await db.insert(skillVersions).values({ skillKey, sha256: backup.sha256, content: backup.content, reason: "vor_aenderung", backupDir });
    }
  }

  const prompt = join(`Skill-Auftrag aus NyxOS (${SKILL_JOB_KIND_LABEL[req.kind]}, Modell Opus 5.5).`, task, backupDir ? `Sicherung: ${backupDir}` : null, RULES);
  const isUserSkill = skillDir.startsWith(`${roots.targets.user}/`);
  const r = await bridgeHub.rpc("start", { tool: "claude", model, cwd, prompt, cols: 160, rows: 48, addDirs: isUserSkill ? [roots.targets.user] : null }, 20_000);
  if (!r.ok) {
    await db.insert(skillJobs).values({ kind: req.kind, skillKey, suggestionId, model, brief: req.brief, backupDir, status: "error", error: r.error ?? null });
    throw new SkillServiceError(t("Die Session ließ sich gerade nicht starten. Bitte gleich noch einmal."), 502);
  }
  const started = r.result as StartResult;
  const key = await recordStartedSession(db, { started, cwd, machineId: bridgeHub.status().machineId, temporary: true });
  const [job] = await db.insert(skillJobs).values({ kind: req.kind, skillKey, suggestionId, model, brief: req.brief, sessionKey: key, tmuxName: started.tmuxName, backupDir, status: "running" }).returning();
  if (!job) throw new SkillServiceError(t("Der Auftrag ließ sich nicht speichern."), 502);
  if (suggestionId) await db.update(skillSuggestions).set({ status: "in_arbeit", jobId: job.id, updatedAt: new Date().toISOString() }).where(eq(skillSuggestions.id, suggestionId));
  const [s] = key ? await db.select().from(sessions).where(eq(sessions.id, key)).limit(1) : [];
  service.d.notify();
  return {
    job: {
      id: job.id,
      kind: req.kind,
      skillKey,
      model,
      status: "running",
      sessionKey: key,
      sessionHref: s ? sessionHref({ sessionId: s.sessionId, categoryArt: s.categoryArt, categoryBaustelleSlug: s.categoryBaustelleSlug }) : null,
      error: null,
      at: new Date(job.createdAt).toISOString(),
    },
  };
}
