// Ergebnis von „Session zusammenfassen & prüfen“ im Session-Vollbild (rechte Spalte, oben).
// Zeigt die jüngste Prüfung: läuft · fertig (Zusammenfassung, Gemacht/Erledigt/Offen, Qualität,
// Risiken) · Fehler (ein Satz). Ohne Prüfung: nichts — der Knopf steht im Kopf.
import { t, type AuditQuality, type SessionAudit } from "@nyxos/shared";
import { useState } from "react";
import { relativeTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { useSessionAudits } from "./api";
import { IconAudit } from "./icons";

const QUALITY: Record<AuditQuality, { label: string; cls: string }> = {
  gut: { label: t("Qualität gut"), cls: "border-a-ok/40 bg-a-ok/10 text-a-ok" },
  mittel: { label: t("Qualität mittel"), cls: "border-a-wait/40 bg-a-wait/10 text-a-wait" },
  schwach: { label: t("Qualität schwach"), cls: "border-a-bad/40 bg-a-bad/10 text-a-bad" },
};

function Section({ title, items, tone, dot }: { title: string; items: string[]; tone: string; dot: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h6 className={cn("mb-1 font-mono text-label font-semibold tracking-wide uppercase", tone)}>{title}</h6>
      <ul className="grid gap-0.5 text-caption leading-snug text-a-ink">
        {items.map((item, i) => (
          <li key={i} className="flex gap-1.5">
            <span className={cn("mt-[7px] h-1 w-1 shrink-0 rounded-full", dot)} />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Body({ audit }: { audit: SessionAudit }) {
  const [open, setOpen] = useState(false);
  if (audit.status === "running") {
    return (
      <p className="flex items-center gap-2 text-caption text-a-mut">
        <span className="h-2 w-2 rounded-full bg-a-acc motion-safe:animate-pulse" />
        {t("Nyx prüft die Session gerade – das dauert meist unter einer Minute.")}
      </p>
    );
  }
  if (audit.status === "error" || !audit.result) return <p className="text-caption text-a-wait">{audit.error ?? t("Die Prüfung ist nicht fertig geworden.")}</p>;
  const r = audit.result;
  const q = QUALITY[r.qualitaet.note];
  return (
    <div className="grid gap-2.5">
      <p className="text-caption leading-snug text-a-ink">{r.zusammenfassung}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-label">
        <span className={cn("rounded-full border px-2 py-0.5", q.cls)}>{q.label}</span>
        <span className="rounded-full border border-a-line px-2 py-0.5 text-a-mut">{t("{n} erledigt", { n: r.erledigt.length })}</span>
        <span className="rounded-full border border-a-line px-2 py-0.5 text-a-mut">{t("{n} offen", { n: r.offen.length })}</span>
        {r.risiken.length > 0 && <span className="rounded-full border border-a-wait/40 px-2 py-0.5 text-a-wait">{r.risiken.length === 1 ? t("1 Risiko") : t("{n} Risiken", { n: r.risiken.length })}</span>}
      </div>
      {/* Offen und Risiken sind das, was du entscheiden musst — immer sichtbar; der Rest aufklappbar. */}
      <Section title={t("Offen")} items={r.offen} tone="text-a-wait" dot="bg-a-wait" />
      <Section title={t("Risiken")} items={r.risiken} tone="text-a-bad" dot="bg-a-bad" />
      {open && (
        <div className="grid gap-2.5">
          <Section title={t("Gemacht")} items={r.gemacht} tone="text-a-done" dot="bg-a-done" />
          <Section title={t("Erledigt")} items={r.erledigt} tone="text-a-ok" dot="bg-a-ok" />
          {r.qualitaet.text && (
            <div>
              <h6 className="mb-1 font-mono text-label font-semibold tracking-wide text-a-violet uppercase">{t("Qualität")}</h6>
              <p className="text-caption leading-snug text-a-ink">{r.qualitaet.text}</p>
            </div>
          )}
        </div>
      )}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="justify-self-start text-caption font-medium text-a-acc hover:underline">
        {open ? t("Weniger zeigen") : t("Gemacht, erledigt, Qualität zeigen")}
      </button>
    </div>
  );
}

export function SessionAuditCard({ sessionId }: { sessionId: string }) {
  const audits = useSessionAudits(sessionId);
  const latest = audits.data?.audits[0];
  if (!latest) return null;
  const when = relativeTime(latest.finishedAt ?? latest.createdAt);
  return (
    <section data-testid="session-audit" aria-label={t("Prüfung der Session")} className="grid gap-2 rounded-lg border border-a-done/35 bg-a-done/5 p-3">
      <header className="flex items-center gap-2">
        <IconAudit size={15} className="text-a-done" />
        <h5 className="text-caption font-semibold text-a-ink">{t("Prüfung von Nyx")}</h5>
        {when && <span className="ml-auto font-mono text-label text-a-mut">{when}</span>}
      </header>
      <Body audit={latest} />
      {latest.status === "done" && latest.itemsRead !== null && latest.itemsTotal !== null && latest.itemsRead < latest.itemsTotal && (
        <p className="text-label text-a-mut">
          {t("Gelesen: {read} von {total} Einträgen (Anfang und Ende der Session).", { read: latest.itemsRead, total: latest.itemsTotal })}
        </p>
      )}
    </section>
  );
}
