// Audit-Detail in der Großansicht: nicht nur der lokale Graph, sondern auch der komplette Inhalt und der
// Text als Vorschau. Oben: Werte (Datei, Datum, Schwere, Status …) und der Befund-Text formatiert, darunter Verwandte, Aufträge und
// Sessions; ganz unten die ganze Audit-Datei als Dokument. Alles anklickbar (Befund/Auftrag → Großansicht,
// Session → Session, Datei → Reiter „Dateien“).
import type { AuditDetail, EntryStage } from "@nyxos/shared";
import { FINDER_ROOTS, t } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { Link } from "react-router";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { STAGE_META } from "../entries/meta";
import { finderHref, parentOf } from "../finder/api";
import { extractToc, MarkdownDocument } from "../finder/MarkdownDocument";
import { sessionLabel } from "../../lib/sessionLabel";

async function fetchAudit(id: number): Promise<AuditDetail> {
  const res = await fetch(`/api/audits/${id}`);
  if (!res.ok) throw new ApiError(t("Server antwortet mit {status}", { status: res.status }), res.status);
  return (await res.json()) as AuditDetail;
}

export function useAuditDetail(id: number) {
  return useQuery({ queryKey: ["audit", id], queryFn: () => fetchAudit(id), staleTime: 30_000 });
}

/** Schwere → Farbe aus den Tokens (bunt, nie grau). */
function severityColor(s: string | null): string {
  const v = (s ?? "").toLowerCase();
  if (v.startsWith("krit")) return "var(--a-bad)";
  if (v.startsWith("hoch")) return "var(--a-claude)";
  if (v.startsWith("mittel")) return "var(--a-wait)";
  if (v.startsWith("nied")) return "var(--a-done)";
  return "var(--a-violet)";
}

const REASON_LABEL: Record<string, string> = { paket: t("gleiches Paket"), datei: t("gleiche Audit-Datei"), vorher: t("muss vorher fertig sein") };

/** Wurzel „Projektordner“ im Reiter Dateien (die Favoriten-Wurzel ohne Unterordner). */
const PROJECT_ROOT: string = FINDER_ROOTS.find((r) => r.base === "project" && r.rel === "")?.id ?? FINDER_ROOTS[0].id;

function Fact({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("cc-card-deep min-w-0 border border-a-line px-2.5 py-2", wide && "col-span-2")}>
      <div className="text-label text-a-mut">{label}</div>
      <div className="truncate text-caption text-a-ink">{children}</div>
    </div>
  );
}

function StagePill({ stage }: { stage: EntryStage }) {
  const m = STAGE_META[stage];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption", m.bg, m.text)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

function finderLink(path: string) {
  return finderHref(PROJECT_ROOT, { dir: parentOf(path), sel: path, open: path });
}

/** Oberer Teil: Werte, Befund-Text, Verwandte, Aufträge, Sessions. */
export function AuditTop({ entryId, stage, onOpenEntry }: { entryId: number; stage: EntryStage; onOpenEntry: (id: number) => void }) {
  const q = useAuditDetail(entryId);
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-xl bg-a-p2" />;
  if (q.isError || !q.data) return <p className="text-caption text-a-mut">{t("Die Einzelheiten zu diesem Befund konnten gerade nicht geladen werden. Die Seite versucht es gleich noch einmal.")}</p>;
  const d = q.data;
  const f = d.finding;
  const src = d.source;
  return (
    <>
      <section aria-label={t("Befund-Werte")} className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {src && (
          <Fact label={t("Datei")} wide>
            <Link to={finderLink(src.path)} className="text-a-acc hover:underline" title={src.path}>
              {src.name}
            </Link>
          </Fact>
        )}
        <Fact label={t("Stand der Datei")}>{src?.updatedAt ? `${formatDateTime(src.updatedAt)}${src.origin === "spiegel" ? ` ${t("(Spiegel)")}` : ""}` : "–"}</Fact>
        <Fact label={t("Status")}>
          <StagePill stage={stage} />
        </Fact>
        {f?.schwere && (
          <Fact label={t("Schwere")}>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2 rounded-full" style={{ background: severityColor(f.schwere) }} />
              <span style={{ color: severityColor(f.schwere) }}>{f.schwere}</span>
            </span>
          </Fact>
        )}
        {f?.stufe !== null && f?.stufe !== undefined && <Fact label={t("Stufe")}>{t("Stufe {n}", { n: f.stufe })}</Fact>}
        {f?.rang !== null && f?.rang !== undefined && <Fact label={t("Rang im Plan")}>{`#${f.rang}`}</Fact>}
        {f?.risiko !== null && f?.risiko !== undefined && <Fact label={t("Risiko (R)")}>{t("{n} von 5", { n: f.risiko })}</Fact>}
        {f?.aufwand && <Fact label={t("Aufwand")}>{f.aufwand}</Fact>}
        {f?.paket && <Fact label={t("Paket")}>{f.paket}</Fact>}
        {f && (f.vorher ?? []).length > 0 && <Fact label={t("Vorher erledigen")}>{f.vorher.join(", ")}</Fact>}
        {d.planPath && (
          <Fact label={t("Maßnahmenplan")} wide>
            <Link to={finderLink(d.planPath)} className="text-a-acc hover:underline" title={d.planPath}>
              {d.planPath.split("/").pop()}
            </Link>
          </Fact>
        )}
      </section>

      {f?.paketArbeit && (
        <p className="rounded-xl border border-a-line bg-a-p px-3.5 py-2.5 text-caption text-a-mut">
          <b className="font-medium text-a-ink">{t("Paket {name}:", { name: f.paket })}</b> {f.paketArbeit}
        </p>
      )}

      <section aria-label={t("Befund")} className="cc-card-deep space-y-2 border border-a-line p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-label tracking-wide text-a-mut uppercase">{t("Befund · Textvorschau")}</h2>
          {src?.origin === "spiegel" && <span className="rounded bg-a-wait/15 px-1.5 py-0.5 text-label text-a-wait">{t("letzter gespiegelter Stand – der Rechner ist gerade nicht verbunden")}</span>}
        </div>
        {src?.section ? (
          <MarkdownDocument text={src.section} base={{ root: PROJECT_ROOT, rel: src.path }} variant="inline" toc={false} label={t("Befund-Text")} />
        ) : src && src.content === null ? (
          <p className="text-caption text-a-mut">{t("Der Text liegt auf dem Rechner, und der ist gerade nicht verbunden. Sobald die Brücke läuft, steht er hier – danach auch, wenn der Rechner zu ist.")}</p>
        ) : (
          <p className="text-caption text-a-mut">{t("In der Audit-Datei steht zu diesem Befund kein eigener Abschnitt. Die ganze Datei steht unten.")}</p>
        )}
      </section>

      {d.related.length > 0 && (
        <section aria-label={t("Zugehörige Befunde")} className="cc-card-deep space-y-1.5 border border-a-line p-3.5">
          <h2 className="font-mono text-label tracking-wide text-a-mut uppercase">{t("Zugehörige Befunde")}</h2>
          <ul className="space-y-1">
            {d.related.map((r) => (
              <li key={r.findingId}>
                <button
                  type="button"
                  disabled={r.entryId === null}
                  onClick={() => r.entryId !== null && onOpenEntry(r.entryId)}
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption hover:bg-a-p3 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span aria-hidden="true" className="size-2 rounded-full" style={{ background: severityColor(r.schwere) }} />
                  <span className="truncate text-a-ink">
                    <b className="font-medium">{r.findingId}</b> — {r.title}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-label text-a-mut">
                    {REASON_LABEL[r.reason] ?? r.reason}
                    {r.stage && <StagePill stage={r.stage} />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(d.tasks.length > 0 || d.sessions.length > 0) && (
        <section aria-label={t("Aufträge und Sessions")} className="cc-card-deep space-y-2 border border-a-line p-3.5">
          {d.tasks.length > 0 && (
            <>
              <h2 className="font-mono text-label tracking-wide text-a-mut uppercase">{t("Aufträge, die diesen Befund nennen")}</h2>
              <ul className="space-y-1">
                {d.tasks.map((t) => (
                  <li key={t.entryId}>
                    <button type="button" onClick={() => onOpenEntry(t.entryId)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption hover:bg-a-p3">
                      <span className="truncate text-a-ink" title={t.path}>
                        {t.title}
                      </span>
                      <StagePill stage={t.stage} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.sessions.length > 0 && (
            <>
              <h2 className="pt-1 font-mono text-label tracking-wide text-a-mut uppercase">{t("Sessions an der Audit-Datei")}</h2>
              <ul className="space-y-0.5">
                {d.sessions.map((s) => (
                  <li key={s.key}>
                    <Link to={s.href} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-caption hover:bg-a-p3">
                      <span aria-hidden="true" className="size-2 rounded-full" style={{ background: s.tool === "codex" ? "var(--a-codex)" : "var(--a-claude)" }} />
                      <span className="truncate text-a-ink">{sessionLabel(s)}</span>
                      <span className="shrink-0 text-label text-a-mut">
                        {s.modes.includes("write") ? t("geändert") : t("gelesen")}
                        {relativeTime(s.lastActivityAt) ? ` · ${relativeTime(s.lastActivityAt)}` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}

/** Unterer Teil: die ganze Audit-Datei als Dokument (mit Inhaltsverzeichnis und Sprung zur Stelle). */
export function AuditFullFile({ entryId }: { entryId: number }) {
  const q = useAuditDetail(entryId);
  const box = useRef<HTMLDivElement>(null);
  const src = q.data?.source;
  if (!src?.content) return null;
  const id = q.data?.finding?.id ?? "";
  const anchor = id ? extractToc(src.content).find((t) => t.text.includes(`[${id}]`) || t.text.startsWith(id)) : undefined;
  return (
    <section aria-label={t("Ganze Audit-Datei")} className="cc-card-deep space-y-3 border border-a-line p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 font-mono text-label tracking-wide text-a-mut uppercase">{t("Ganze Audit-Datei · {name}", { name: src.name })}</h2>
        {anchor && (
          <button
            type="button"
            onClick={() => box.current?.querySelector(`[id="${CSS.escape(anchor.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="h-(--a-ctl-h) rounded-lg border border-a-line px-2.5 text-caption text-a-ink hover:bg-a-p3"
          >
            {t("Zur Stelle von {id} springen", { id })}
          </button>
        )}
        <Link to={finderLink(src.path)} className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-acc/50 bg-a-acc/10 px-2.5 text-caption font-medium text-a-acc hover:bg-a-acc/20">
          {t("In Dateien öffnen ›")}
        </Link>
      </div>
      <div ref={box} className="cc-scroll max-h-[80vh] overflow-y-auto rounded-lg bg-a-bg/60 p-3 md:p-6">
        <MarkdownDocument text={src.content} base={{ root: PROJECT_ROOT, rel: src.path }} label={t("Audit-Datei")} />
      </div>
    </section>
  );
}
