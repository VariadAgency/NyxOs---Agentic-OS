// Takt von Haiku: Briefing (Standard 07:00), Recap (21:30), Rundgang (alle 15 Min).
// Rundgang = erst deterministische Prüfungen (kostenlos). Haiku wird nur bei echtem Anlass gerufen
// (z. B. eine Auftrags-Session wartet auf eine Antwort → `onWaitingSession`).
import { createHash } from "node:crypto";
import { formatBuildCount, t } from "@nyxos/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { haikuNotes, inboxItems } from "../db/schema.js";
import { takeSnapshot } from "../overview/snapshot.js";
import { generateReport, hasReportForDay } from "./report.js";
import type { HaikuRuntime } from "./runtime.js";
import { localDay, localTime, loadHaikuSettings } from "./settings.js";
import { narrateBriefing } from "./speechNarrative.js";

export interface Finding {
  kind: "waiting" | "crashed" | "approval" | "build_red" | "escalation";
  ref: string;
  text: string;
  sessionKey: string | null;
}

export interface SchedulerDeps {
  runtime: HaikuRuntime;
  notify: (what: string) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Rundgang-Anlass „Session wartet“ → Haiku prüft, ob Regeln die Antwort belegen (P7 Schritt 3). */
  onWaitingSession?: (sessionKey: string) => Promise<boolean>;
  /** weitere Arbeit im selben Minutentakt (Nyx' geplante Aufgaben). */
  extraTick?: (now: Date) => Promise<void>;
}

const fp = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export class HaikuScheduler {
  private lastRundgangAt = 0;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly deps: SchedulerDeps) {}

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<{ briefing: boolean; recap: boolean; rundgang: boolean }> {
    const out = { briefing: false, recap: false, rundgang: false };
    if (this.busy) return out;
    this.busy = true;
    try {
      const db = this.deps.runtime.db;
      const s = await loadHaikuSettings(db);
      const day = localDay(now);
      const time = localTime(now);
      if (time >= s.briefingTime && time < s.recapTime && !(await hasReportForDay(db, "briefing", day))) {
        const briefing = await generateReport(this.deps.runtime, "briefing", now);
        void narrateBriefing({ runtime: this.deps.runtime }, briefing); // Sprechfassung vorbereiten
        this.deps.notify("report");
        out.briefing = true;
      }
      if (time >= s.recapTime && !(await hasReportForDay(db, "recap", day))) {
        const recap = await generateReport(this.deps.runtime, "recap", now);
        void narrateBriefing({ runtime: this.deps.runtime }, recap); // Sprechfassung vorbereiten
        this.deps.notify("report");
        out.recap = true;
      }
      if (now.getTime() - this.lastRundgangAt >= s.rundgangMinutes * 60_000) {
        await this.rundgang(now);
        out.rundgang = true;
      }
      // Begleitung der Auftrags-Sessions jede Minute (deterministisch; Haiku nur bei neuem Stop/Warten).
      if (this.deps.runtime.auftrag) await this.deps.runtime.auftrag.watch();
      if (this.deps.extraTick) await this.deps.extraTick(now);
    } catch (e) {
      this.deps.log?.("haiku-takt-fehler", { error: String(e) });
    } finally {
      this.busy = false;
    }
    return out;
  }

  /** Sammelt Anlässe, merkt sich nur NEUE (Fingerabdruck) und ruft Haiku nur für wartende Auftrags-Sessions. */
  async rundgang(now = new Date()): Promise<Finding[]> {
    this.lastRundgangAt = now.getTime();
    const db = this.deps.runtime.db;
    // dieselbe Lage wie Überblick und Briefing (Schnappschuss) — „abgestürzt“ also nur bis zur
    // Altersgrenze, Build-Fehler gebündelt und ohne die, deren Ordner wieder grün ist.
    const snap = await takeSnapshot(db, now);
    const findings: Finding[] = [];
    for (const w of snap.waiting.slice(0, 30)) findings.push({ kind: "waiting", ref: `session:${w.id}:${w.lastActivityAt}`, text: t("Wartet: {title}", { title: w.title ?? w.id }), sessionKey: w.id });
    for (const c of snap.crashed.slice(0, 30)) findings.push({ kind: "crashed", ref: `crashed:${c.id}:${c.lastActivityAt}`, text: t("Abgestürzt: {title}", { title: c.title ?? c.id }), sessionKey: c.id });
    for (const a of snap.pendingApprovals) findings.push({ kind: "approval", ref: `approval:${a.id}`, text: t("Freigabe offen: {command}", { command: a.command.slice(0, 80) }), sessionKey: null });
    // ein Anlass je Fehler (gebündelt), nicht je Lauf; Fingerabdruck am ersten Lauf der Gruppe.
    for (const g of snap.redBuilds.slice(0, 20)) findings.push({ kind: "build_red", ref: `build:${g.firstId}`, text: `${g.headline} (${formatBuildCount(g)})`, sessionKey: null });
    const esc = await db.select({ id: inboxItems.id, title: inboxItems.title }).from(inboxItems).where(and(eq(inboxItems.status, "open"), sql`${inboxItems.escalation} is not null`)).limit(20);
    for (const e of esc) findings.push({ kind: "escalation", ref: `inbox:${e.id}`, text: t("Eskalation: {title}", { title: e.title }), sessionKey: null });

    const prints = findings.map((f) => fp(f.ref));
    const known = prints.length ? new Set((await db.select({ f: haikuNotes.fingerprint }).from(haikuNotes).where(and(eq(haikuNotes.kind, "rundgang"), inArray(haikuNotes.fingerprint, prints)))).map((r) => r.f)) : new Set<string | null>();
    const fresh = findings.filter((_f, i) => !known.has(prints[i] ?? ""));
    let calledHaiku = false;
    for (const f of fresh) {
      await db.insert(haikuNotes).values({ kind: "rundgang", text: f.text, fingerprint: fp(f.ref), data: { kind: f.kind, ref: f.ref } });
      if (f.kind === "waiting" && f.sessionKey && this.deps.onWaitingSession) {
        try {
          calledHaiku = (await this.deps.onWaitingSession(f.sessionKey)) || calledHaiku;
        } catch (e) {
          this.deps.log?.("rundgang-antwort-fehler", { error: String(e) });
        }
      }
    }
    if (this.deps.runtime.auftrag) {
      try {
        await this.deps.runtime.auftrag.rundgangExtras();
      } catch (e) {
        this.deps.log?.("rundgang-zusatz-fehler", { error: String(e) });
      }
    }
    this.deps.runtime.lastRundgang = { at: now.toISOString(), findings: fresh.length, calledHaiku };
    this.deps.notify("status");
    return fresh;
  }
}
