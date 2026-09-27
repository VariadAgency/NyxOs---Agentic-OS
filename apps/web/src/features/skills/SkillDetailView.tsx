// Großansicht eines Skills – von oben nach unten: Kopf mit Knöpfen, Inhalt (SKILL.md formatiert),
// Nutzung (30 Tage + Sessions), Vorschläge von Nyx (Inbox), Verlauf der Verbesserungen (Vergleich, Rückgängig),
// Dateien. Reiter-Idee nach ClawHub `SkillDetailTabs.tsx`/`SkillDiffCard.tsx` (MIT, s. NOTICE), hier als
// Abschnitte untereinander (alles scrollbar, keine gequetschten Spalten).
import {
  SKILL_SIGNAL_LABEL,
  SKILL_VERSION_REASON_LABEL,
  SKILL_JOB_KIND_LABEL,
  lineDiff,
  locale,
  parseSkillFrontmatter,
  t,
  tc,
  type SkillDetail,
  type SkillSuggestion,
  type SkillVersion,
  type SkillVersionReason,
} from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { PageShell } from "../../components/PageShell";
import { BarChart } from "../../components/charts";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/friendlyError";
import { Markdown } from "../../lib/markdown";
import { DiffView } from "../conflicts/DiffView";
import { SOURCE_COLOR, fetchSkill, fetchSkillFile, fetchSkillVersion, pinSkill, restoreSkillVersion, setSuggestionStatus, skillKey as detailKey, tint } from "./api";
import { SkillJobDialog, type JobDialogMode } from "./SkillJobDialog";
import { SourceChip, usageLine } from "./SkillsView";

const numberFmt = new Intl.NumberFormat(locale());
const DAY_MS = 86_400_000;

const REASON_COLOR: Record<SkillVersionReason, string> = {
  erfasst: "var(--a-done)",
  geaendert: "var(--a-acc)",
  vor_aenderung: "var(--a-wait)",
  verbessert: "var(--a-ok)",
  erstellt: "var(--a-ok)",
  zurueckgesetzt: "var(--a-violet)",
};

const STATUS_LABEL: Record<SkillSuggestion["status"], { label: string; color: string }> = {
  open: { label: t("offen"), color: "var(--a-wait)" },
  in_arbeit: { label: t("Opus arbeitet daran"), color: "var(--a-claude)" },
  umgesetzt: { label: t("umgesetzt"), color: "var(--a-ok)" },
  verworfen: { label: t("verworfen"), color: "var(--a-idle)" },
};

function Pill({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-label font-medium" style={{ color, background: tint(color) }} title={title}>
      {children}
    </span>
  );
}

function Section({ id, title, count, children, action }: { id: string; title: string; count?: number; children: ReactNode; action?: ReactNode }) {
  return (
    <section id={id} aria-label={title} className="cc-card-deep grid min-w-0 scroll-mt-4 content-start gap-3 rounded-xl border border-a-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-mono text-label font-semibold uppercase tracking-wider text-a-mut">
          {title}
          {count !== undefined && <span className="rounded-full bg-a-p3 px-1.5 py-0.5 text-label tabular-nums text-a-mut">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="grid min-h-[72px] place-items-center text-center text-callout text-a-mut">{children}</p>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const one = (v: number) => v.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (n < 1024 * 1024) return `${one(n / 1024)} KB`;
  return `${one(n / 1024 / 1024)} MB`;
}

function dayLabels(): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) out.push(new Date(today.getTime() - i * DAY_MS).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" }));
  return out;
}

function SuggestionCard({ s, writable, onApply }: { s: SkillSuggestion; writable: boolean; onApply: () => void }) {
  const queryClient = useQueryClient();
  const status = STATUS_LABEL[s.status];
  const change = useMutation({
    mutationFn: (next: "open" | "verworfen") => setSuggestionStatus(s.id, next),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });
  return (
    <article data-suggestion={s.id} className={cn("grid gap-2 rounded-lg border p-3", s.status === "open" ? "border-a-wait/40 bg-a-wait/5" : "border-a-line bg-a-p2/40")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill color="var(--a-conf)">{SKILL_SIGNAL_LABEL[s.signal]}</Pill>
        <Pill color={status.color}>{status.label}</Pill>
        <Pill color={s.author === "nyx" ? "var(--a-acc)" : "var(--a-indigo)"} title={s.author === "nyx" ? t("Nyx (Haiku) hat den Vorschlag geschrieben") : t("Nyx war nicht erreichbar – Text aus der Regel")}>
          {s.author === "nyx" ? t("von Nyx") : t("aus der Regel")}
        </Pill>
        <span className="ml-auto text-caption tabular-nums text-a-mut" title={formatDateTime(s.at)}>
          {relativeTime(s.at)}
        </span>
      </div>
      <p className="text-callout font-medium text-a-ink">{s.problem}</p>
      <blockquote className="border-l-2 border-a-conf/60 pl-2.5 text-caption italic text-a-mut">{s.evidence}</blockquote>
      <p className="text-callout text-a-ink">
        <span className="text-a-mut">{t("Idee:")} </span>
        {s.idea}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {s.sessionHref ? (
          <Link to={s.sessionHref} className="text-caption text-a-acc underline decoration-a-acc/40 underline-offset-2 hover:decoration-a-acc">
            {s.sessionTitle ? t("Zur Session: {title} →", { title: s.sessionTitle }) : t("Zur Session →")}
          </Link>
        ) : null}
        <span className="ml-auto flex gap-2">
          {s.status === "open" && (
            <>
              <Button variant="ghost" onClick={() => change.mutate("verworfen")} disabled={change.isPending}>
                {t("Verwerfen")}
              </Button>
              {writable && (
                <Button variant="primary" onClick={onApply} data-nyx={`skill-suggestion-apply-${s.id}`}>
                  {t("Mit Opus 5.5 umsetzen")}
                </Button>
              )}
            </>
          )}
          {s.status === "verworfen" && (
            <Button variant="ghost" onClick={() => change.mutate("open")} disabled={change.isPending}>
              {t("Wieder öffnen")}
            </Button>
          )}
        </span>
      </div>
    </article>
  );
}

function VersionRow({ skill, v, isLatest, writable }: { skill: string; v: SkillVersion; isLatest: boolean; writable: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const diff = useQuery({ queryKey: ["skills", "version", skill, v.id], queryFn: () => fetchSkillVersion(skill, v.id), enabled: open, staleTime: Infinity });
  const lines = useMemo(() => (diff.data ? lineDiff(diff.data.previous ?? "", diff.data.content) : []), [diff.data]);
  const restore = useMutation({
    mutationFn: () => restoreSkillVersion(skill, v.id),
    onSuccess: () => {
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const color = REASON_COLOR[v.reason];
  return (
    <li className="grid gap-2 rounded-lg border border-a-line bg-a-p2/40">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left text-callout hover:bg-a-p2">
        <Pill color={color}>{SKILL_VERSION_REASON_LABEL[v.reason]}</Pill>
        <span className="truncate text-a-mut">
          <span className="tabular-nums text-a-ink">{formatDateTime(v.at)}</span> · {formatBytes(v.bytes)}
          {isLatest && <span className="text-a-ok"> · {t("aktueller Stand")}</span>}
        </span>
        <span className="text-caption text-a-mut">{open ? t("Vergleich schließen") : t("Vergleich zeigen")}</span>
      </button>
      {open && (
        <div className="grid gap-2 px-3 pb-3">
          {diff.isPending ? (
            <Skeleton className="h-24" />
          ) : diff.isError ? (
            <p className="text-caption text-a-bad">{friendlyError(diff.error)}</p>
          ) : diff.data?.previous === null ? (
            <p className="text-caption text-a-mut">{t("Erster Stand im Verlauf – nichts zum Vergleichen.")}</p>
          ) : (
            <DiffView lines={lines} mode="unified" emptyText={t("Gleicher Inhalt wie der Stand davor.")} />
          )}
          {writable && !isLatest && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {restore.isError && <span className="text-caption text-a-bad">{friendlyError(restore.error)}</span>}
              {confirm ? (
                <>
                  <span className="text-caption text-a-ink">{t("Aktuellen Stand sichern und diesen zurückholen?")}</span>
                  <Button variant="ghost" onClick={() => setConfirm(false)}>
                    {t("Nein")}
                  </Button>
                  <Button variant="warn" onClick={() => restore.mutate()} disabled={restore.isPending}>
                    {restore.isPending ? t("Setze zurück …") : t("Ja, zurücksetzen")}
                  </Button>
                </>
              ) : (
                <Button variant="default" onClick={() => setConfirm(true)}>
                  {t("Diesen Stand wiederherstellen")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function FileRow({ skill, rel, bytes }: { skill: string; rel: string; bytes: number }) {
  const [open, setOpen] = useState(false);
  const file = useQuery({ queryKey: ["skills", "file", skill, rel], queryFn: () => fetchSkillFile(skill, rel), enabled: open });
  return (
    <li className="grid rounded-lg border border-a-line bg-a-p2/40">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center justify-between gap-3 px-3 py-2 text-left text-callout hover:bg-a-p2">
        <span className="truncate font-mono text-a-ink">{rel}</span>
        <span className="shrink-0 text-caption tabular-nums text-a-mut">{formatBytes(bytes)}</span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {file.isPending ? (
            <Skeleton className="h-16" />
          ) : file.isError ? (
            <p className="text-caption text-a-bad">{friendlyError(file.error)}</p>
          ) : file.data?.content === null ? (
            <p className="text-caption text-a-mut">{t("Diese Datei lässt sich nicht als Text anzeigen.")}</p>
          ) : (
            <pre className="cc-scroll max-h-[420px] overflow-auto rounded-md border border-a-line bg-a-bg p-2.5 font-mono text-caption leading-[17px] whitespace-pre-wrap text-a-ink">{file.data?.content}</pre>
          )}
        </div>
      )}
    </li>
  );
}

function Body({ d }: { d: SkillDetail }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<JobDialogMode | null>(null);
  const now = Date.now();
  const s = d.skill;
  const color = SOURCE_COLOR[s.source];
  const fm = useMemo(() => (d.content ? parseSkillFrontmatter(d.content) : null), [d.content]);
  const labels = useMemo(dayLabels, []);
  const usage = usageLine(s, now);
  const open = d.suggestions.filter((x) => x.status === "open");
  const pin = useMutation({ mutationFn: () => pinSkill(s.key, !s.pinned), onSettled: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }) });
  const runningJob = d.jobs.find((j) => j.status === "running");

  return (
    <>
      <div className="relative grid gap-3 overflow-hidden rounded-xl border border-a-line bg-a-p p-5" style={{ borderColor: `color-mix(in srgb, ${color} 45%, var(--a-line))` }}>
        <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color }} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <SourceChip source={s.source} plugin={s.plugin} />
              {s.pinned && <Pill color="var(--a-violet)">{t("angepinnt")}</Pill>}
              {s.missing && <Pill color="var(--a-bad)">{t("fehlt auf deinem Rechner")}</Pill>}
            </div>
            <h1 className="truncate font-mono text-title2 font-semibold text-a-ink">/{s.key}</h1>
            {s.description && <p className="max-w-[780px] text-callout leading-5 text-a-mut">{s.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {s.writable && (
              <Button variant="ghost" onClick={() => pin.mutate()} disabled={pin.isPending} title={t("Angepinnt = Nyx macht zu diesem Skill keine Vorschläge")}>
                {s.pinned ? t("Lösen") : t("Anpinnen")}
              </Button>
            )}
            {s.writable ? (
              <Button variant="primary" onClick={() => setDialog({ kind: "improve", skillKey: s.key })} data-nyx="skill-improve">
                {t("Mit Opus 5.5 verbessern")}
              </Button>
            ) : (
              <span className="max-w-[260px] text-right text-caption text-a-mut">
                {s.source === "builtin" ? t("In Claude Code eingebaut – hier nur zum Anschauen.") : t("Gehört einem Plugin bzw. Claude.ai – hier nur zum Lesen.")}
              </span>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 border-t border-a-line pt-3 text-caption sm:grid-cols-4">
          <div className="grid gap-0.5">
            <dt className="font-mono text-label uppercase tracking-wider text-a-mut">{t("Genutzt")}</dt>
            <dd className={cn("tabular-nums", usage.tone === "wait" ? "text-a-wait" : "text-a-ink")}>{usage.text}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="font-mono text-label uppercase tracking-wider text-a-mut">{t("Vorschläge offen")}</dt>
            <dd className={cn("tabular-nums", open.length > 0 ? "text-a-wait" : "text-a-ink")}>{open.length}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="font-mono text-label uppercase tracking-wider text-a-mut">{t("Zuletzt verbessert")}</dt>
            <dd className="text-a-ink">{s.lastImprovedAt ? relativeTime(s.lastImprovedAt, now) : t("noch nie")}</dd>
          </div>
          <div className="grid min-w-0 gap-0.5">
            <dt className="font-mono text-label uppercase tracking-wider text-a-mut">{t("Ort")}</dt>
            <dd className="truncate font-mono text-caption text-a-ink" title={s.dir ?? undefined}>
              {s.dir ?? "–"}
            </dd>
          </div>
        </dl>
        {runningJob && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-callout" style={{ background: tint("var(--a-claude)"), color: "var(--a-claude)" }}>
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="cc-pulse h-2 w-2 rounded-full" style={{ background: "var(--a-claude)" }} />
              {t("Opus 5.5 arbeitet gerade daran ({kind}).", { kind: SKILL_JOB_KIND_LABEL[runningJob.kind] })}
            </span>
            {runningJob.sessionHref && (
              <Link to={runningJob.sessionHref} className="font-medium underline underline-offset-2">
                {t("Session öffnen →")}
              </Link>
            )}
          </div>
        )}
        <nav aria-label={t("Abschnitte")} className="flex flex-wrap gap-1.5">
          {[
            ["inhalt", t("Inhalt")],
            ["nutzung", `${t("Nutzung")} · ${s.uses}`],
            ["vorschlaege", `${t("Vorschläge")} · ${open.length}`],
            ["verlauf", `${t("Verlauf")} · ${d.versions.length}`],
            ["dateien", `${t("Dateien")} · ${s.fileList.length}`],
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-full border border-a-line px-2.5 py-1 text-caption text-a-mut transition-colors hover:border-a-acc/60 hover:text-a-ink">
              {label}
            </a>
          ))}
        </nav>
      </div>

      <Section id="inhalt" title={t("Inhalt (SKILL.md)")}>
        {d.content === null ? (
          <Empty>{s.source === "builtin" ? t("Eingebaute Skills haben keine Datei auf deinem Rechner.") : t("Der Inhalt wird beim nächsten Einlesen geholt, sobald dein Rechner verbunden ist.")}</Empty>
        ) : (
          <div className="w-full min-w-0 rounded-lg bg-a-bg/50 px-5 py-4 text-callout leading-6 text-a-ink">
            {/* Volle Breite wie alle Tabs (keine leeren Ränder), keine Mittelspalte. */}
            <Markdown text={fm?.body ?? d.content} />
          </div>
        )}
      </Section>

      <Section id="nutzung" title={t("Nutzung · 30 Tage")} count={s.uses}>
        {s.uses === 0 ? (
          <Empty>{t("Noch nie genutzt. Wenn er nie greift, lohnt sich oft eine bessere Beschreibung – „Mit Opus 5.5 verbessern“ kann das.")}</Empty>
        ) : (
          <>
            <BarChart data={s.daily.map((value, i) => ({ x: labels[i] ?? "", value }))} height={150} ariaLabel={t("Aufrufe je Tag, letzte 30 Tage")} unit={t("Aufrufe")} formatTick={(x) => x} formatTooltipX={(x) => t("am {day}", { day: x })} />
            <ul className="grid gap-0.5">
              {d.uses.slice(0, 30).map((u, i) => (
                <li key={`${u.sessionKey}-${u.at}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2.5 py-1.5 text-callout hover:bg-a-p2">
                  <span className="flex min-w-0 items-center gap-2">
                    <Pill color={u.via === "tool" ? "var(--a-acc)" : "var(--a-indigo)"}>{u.via === "tool" ? t("von Claude") : t("/getippt")}</Pill>
                    {u.sessionHref ? (
                      <Link to={u.sessionHref} className="truncate text-a-ink hover:underline">
                        {u.sessionTitle ?? t("Session nicht mehr da")}
                      </Link>
                    ) : (
                      <span className="truncate text-a-mut">{u.sessionTitle ?? t("Session nicht mehr da")}</span>
                    )}
                    {u.signal && <Pill color="var(--a-conf)">{SKILL_SIGNAL_LABEL[u.signal]}</Pill>}
                  </span>
                  <span className="text-caption tabular-nums text-a-mut" title={formatDateTime(u.at)}>
                    {relativeTime(u.at, now)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section id="vorschlaege" title={t("Vorschläge von Nyx")} count={d.suggestions.length}>
        <p className="text-caption text-a-mut">
          {t(
            "Nyx liest die Sessions nach jedem Aufruf: Ging etwas schief, hast du abgebrochen oder korrigiert, schreibt Nyx hier einen kurzen Vorschlag. Nyx ändert nie selbst etwas – umgesetzt wird nur mit Opus 5.5, wenn du es willst.",
          )}
        </p>
        {d.suggestions.length === 0 ? (
          <Empty>{s.pinned ? t("Angepinnt – Nyx macht zu diesem Skill keine Vorschläge.") : t("Keine Vorschläge. Der Skill lief bisher ohne Auffälligkeiten.")}</Empty>
        ) : (
          <div className="grid gap-2">
            {d.suggestions.map((x) => (
              <SuggestionCard key={x.id} s={x} writable={s.writable} onApply={() => setDialog({ kind: "apply", suggestion: x })} />
            ))}
          </div>
        )}
      </Section>

      <Section id="verlauf" title={t("Verlauf der Verbesserungen")} count={d.versions.length}>
        {d.versions.length === 0 ? (
          <Empty>{t("Noch kein Stand gespeichert. Beim nächsten Einlesen wird der aktuelle Stand festgehalten.")}</Empty>
        ) : (
          <ul className="grid gap-1.5">
            {d.versions.map((v, i) => (
              <VersionRow key={v.id} skill={s.key} v={v} isLatest={i === 0} writable={s.writable} />
            ))}
          </ul>
        )}
        {d.jobs.length > 0 && (
          <div className="grid gap-1">
            <h3 className="font-mono text-label uppercase tracking-wider text-a-mut">{t("Opus-Aufträge")}</h3>
            <ul className="grid gap-0.5">
              {d.jobs.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2.5 py-1.5 text-callout">
                  <Pill color={j.status === "running" ? "var(--a-claude)" : j.status === "error" ? "var(--a-bad)" : "var(--a-ok)"}>{j.status === "running" ? t("läuft") : j.status === "error" ? t("nicht gestartet") : tc("skills", "beendet")}</Pill>
                  <span className="text-a-ink">{SKILL_JOB_KIND_LABEL[j.kind]}</span>
                  <span className="text-a-mut">· Opus 5.5 · {relativeTime(j.at, now)}</span>
                  {j.sessionHref && (
                    <Link to={j.sessionHref} className="ml-auto text-caption text-a-acc hover:underline">
                      {t("Session →")}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section id="dateien" title={t("Dateien")} count={s.fileList.length}>
        {s.fileList.length === 0 ? (
          <Empty>{t("Keine Dateien bekannt.")}</Empty>
        ) : (
          <ul className="grid gap-1.5">
            {s.fileList.map((f) => (
              <FileRow key={f.rel} skill={s.key} rel={f.rel} bytes={f.bytes} />
            ))}
          </ul>
        )}
        {s.bytes > 0 && <p className="text-caption text-a-mut">{t("SKILL.md: {size} · etwa {tokens} Tokens, wenn der Skill geladen wird.", { size: formatBytes(s.bytes), tokens: numberFmt.format(Math.round(s.bytes / 4)) })}</p>}
      </Section>

      {dialog && <SkillJobDialog mode={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

export function SkillDetailView() {
  const { key = "" } = useParams();
  const q = useQuery({ queryKey: detailKey(key), queryFn: () => fetchSkill(key), enabled: key.length > 0 });
  return (
    <PageShell gap="gap-4">
      <Link to="/skills" className="w-fit text-caption text-a-mut hover:text-a-ink">
        ← {t("Alle Skills")}
      </Link>
      {q.isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-[180px] rounded-xl" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      ) : q.isError || !q.data ? (
        <div className="grid min-h-[160px] place-items-center gap-2 rounded-xl border border-a-line text-center text-callout text-a-mut">
          <span>{friendlyError(q.error, t("Diesen Skill gibt es nicht (mehr)."))}</span>
          <Link to="/skills" className="text-a-acc hover:underline">
            {t("Zur Skill-Übersicht")}
          </Link>
        </div>
      ) : (
        <Body d={q.data} />
      )}
    </PageShell>
  );
}
