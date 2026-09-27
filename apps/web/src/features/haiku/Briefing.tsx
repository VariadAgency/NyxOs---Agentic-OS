// Briefing/Recap. Route `/briefing` (`BriefingPage`).
// Gestaltet wie ein Artefakt, volle Breite, von oben nach unten: Kopf (Zeitstempel, Kernaussage,
// Stand) → „Braucht dich“ (Knöpfe) → Kennzahl-Kacheln → Graphen → „Was lief / Was hängt / Was als Nächstes“ →
// „Läuft ohne dich“. Alle Zahlen und Graphen aus `report.figures` (Server-Schnappschuss), nie aus dem
// Modelltext. „Leichter Tag“ zeigt nur Punkte ohne Aufwand aus `GET /api/haiku/light-day`.
import { friendlyError } from "../../lib/friendlyError";
import { ErrorDetails } from "../../components/ErrorDetails";
import { BRIEF_GROUP_TITLE, briefGroupOf, briefGroupTarget, greetingLine, locale, t, tc, timeZone, type BriefGroup, type HaikuReport, type ReportItem, type ReportStatement } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AskNyxButton } from "../../components/nyx/AskNyxButton";
import { useUserName } from "../../hooks/useAppInfo";
import { Link, useSearchParams } from "react-router";
import { cn } from "../../lib/cn";
import { SinceCard } from "../overview/SinceCard";
import { RawDetails } from "../builds/RawDetails";
import { useAnswerInbox, useDecideApproval } from "../inbox/useInbox";
import { ChartGrid, KpiGrid } from "./BriefingFigures";
import { PROFILE_KEY, fetchNyxProfile } from "../settings/nyx/nyxApi";
import { autoRewriteAllowed, claimAutoRewrite } from "./autoRewrite";
import { ReadAloudButton, ReadAloudProgress, ReaderBar, useBriefingReadAloud } from "./BriefingReadAloud";
import { HaikuApiError, createReport, fetchLightDay, fetchReport, releaseAll } from "./haikuApi";
import { ErrorBox, EstimateTag, HAIKU_ERROR_TEXT, SourceChips, ToastView, riseStyle, useToast } from "./ui";

type Kind = HaikuReport["kind"];
const LIGHT_KEY = "nyxos.lightDay";

/** Gemeinsame Regel aus shared – derselbe Gruß wie Server-Bericht und Vorlesen. */
export function greetingFor(date: Date, name?: string | null): string {
  return greetingLine(date, name);
}

function readLight(): boolean {
  try {
    return localStorage.getItem(LIGHT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeLight(v: boolean) {
  try {
    localStorage.setItem(LIGHT_KEY, v ? "1" : "0");
  } catch {
    // ohne Speicher: gilt nur bis zum Neuladen
  }
}

const ITEM_KIND: Record<ReportItem["kind"], string> = {
  approval: t("Freigabe"),
  question: t("Frage"),
  plan: t("Plan"),
  review: t("Abnahme"),
  crashed: t("Abgestürzt"),
  build: "Build",
  session: "Session",
};

/** Jede Art hat ihre Farbe (bunt, nie grau) — Etikett und Rand der Knöpfe in „Braucht dich“. */
const ITEM_COLOR: Record<ReportItem["kind"], string> = {
  approval: "var(--a-acc)",
  question: "var(--a-wait)",
  plan: "var(--a-violet)",
  review: "var(--a-done)",
  crashed: "var(--a-bad)",
  build: "var(--a-bad)",
  session: "var(--a-wait)",
};


const GROUP_COLOR: Record<BriefGroup, string> = { lief: "var(--a-ok)", haengt: "var(--a-wait)", naechstes: "var(--a-acc)" };
const GROUP_ORDER: BriefGroup[] = ["lief", "haengt", "naechstes"];
const GROUP_EMPTY: Record<BriefGroup, string> = { lief: t("Noch nichts gelaufen."), haengt: t("Nichts hängt."), naechstes: t("Nichts drängt.") };

/** Zählwort: `one`/`many` sind Übersetzungs-Schlüssel mit `{n}`. */
const plural = (n: number, one: string, many: string) => t(n === 1 ? one : many, { n });

/** Uhrzeit des Stands in der eingestellten Zeitzone, z. B. „10:38“. */
const standFmt = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() });

function minutesLabel(m: number): string {
  return m <= 0 ? t("1 Klick") : t("~{m} Min", { m });
}

function errorText(err: unknown): string {
  if (err instanceof HaikuApiError && err.code && err.code in HAIKU_ERROR_TEXT) return HAIKU_ERROR_TEXT[err.code as keyof typeof HAIKU_ERROR_TEXT];
  return friendlyError(err, t("Das hat gerade nicht geklappt – bitte noch einmal versuchen."));
}

const TOGGLE = "h-(--a-ctl-h) rounded-lg border px-2.5 text-caption transition-colors duration-150";

/** @param afterHead steht direkt unter dem Kopf mit der Kernaussage (dort „Seit du weg warst“). */
export function Briefing({ className, afterHead }: { className?: string; afterHead?: ReactNode }) {
  const qc = useQueryClient();
  const now = new Date();
  // `?vorlesen=1` (von Nyx) startet das Vorlesen, `&art=recap|briefing` wählt den Bericht.
  const [params, setParams] = useSearchParams();
  const artParam = params.get("art");
  const wantedArt: Kind | null = artParam === "recap" || artParam === "briefing" ? artParam : null;
  const [kind, setKind] = useState<Kind>(() => wantedArt ?? (now.getHours() >= 18 ? "recap" : "briefing"));
  const [light, setLightState] = useState(readLight);
  const toast = useToast();

  const report = useQuery({ queryKey: ["haiku", "report", kind], queryFn: () => fetchReport(kind) });
  // Name im Gruß aus dem Nyx-Profil (wie Überblick und Vorlesen), sonst der Name aus der Einrichtung.
  const profile = useQuery({ queryKey: PROFILE_KEY, queryFn: fetchNyxProfile, staleTime: 5 * 60_000, retry: false });
  const userName = useUserName();
  const greetingName = profile.data?.profile.user.name?.trim() || userName || null;
  const create = useMutation({
    mutationFn: () => createReport(kind),
    onSuccess: (r) => {
      qc.setQueryData(["haiku", "report", r.kind], r);
      // Überblick-Teaser und Kopfzeile sollen denselben Stand zeigen.
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  // Passt der Bericht nicht mehr zum jetzigen Stand, wird er beim Öffnen EINMAL von selbst neu
  // geschrieben. Die Sperre lebt außerhalb der Seite (`autoRewrite.ts`) – sonst ginge nach jedem
  // Neu-Einhängen (Tab-Wechsel, Neuladen) wieder ein POST los, auch wenn der letzte gescheitert war.
  const staleId = report.data?.stale === true && report.data.kind === kind ? report.data.id : null;
  const { mutate: rewrite, isPending: rewriting } = create;
  useEffect(() => {
    if (staleId === null || rewriting) return;
    if (claimAutoRewrite(kind, staleId)) rewrite();
  }, [staleId, kind, rewriting, rewrite]);

  const setLight = (v: boolean) => {
    setLightState(v);
    writeLight(v);
  };

  const data = report.data ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const readAloud = useBriefingReadAloud(rootRef, data?.id ?? null);
  const startReading = () => {
    // Vorgelesen wird das ganze Briefing – dafür muss es auch zu sehen sein.
    if (light) setLight(false);
    readAloud.start();
  };
  // Von Nyx geöffnet: sobald der aktuelle Bericht da ist (nicht mitten im Neuschreiben), einmal starten.
  const wantsReading = params.get("vorlesen") === "1";
  // Seite war schon offen (useState-Startwert greift dann nicht): die gewünschte Art trotzdem umschalten.
  useEffect(() => {
    if (wantsReading && wantedArt && wantedArt !== kind) setKind(wantedArt);
  }, [wantsReading, wantedArt, kind]);
  // Veraltet und gleich automatisch neu geschrieben → erst den neuen Bericht vorlesen.
  const readyToRead = !!data && (!wantedArt || wantedArt === kind) && !create.isPending && (!data.stale || !autoRewriteAllowed(kind, data.id));
  useEffect(() => {
    if (!wantsReading || !readyToRead || readAloud.voiceReady === false) return;
    const next = new URLSearchParams(params);
    next.delete("vorlesen");
    next.delete("art");
    setParams(next, { replace: true });
    startReading();
    // Nur diese drei Werte lösen aus: genau ein Start je Aufruf mit ?vorlesen=1 (danach ist der Parameter weg).
  }, [wantsReading, readyToRead, readAloud.voiceReady]);
  const kindLabel = kind === "briefing" ? t("Briefing") : t("Recap");
  // Inside a sentence: lower case in English („Couldn’t load the briefing“), the noun as is in German.
  const kindWord = kind === "briefing" ? tc("sentence", "Briefing") : tc("sentence", "Recap");
  const dateText = now.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long", timeZone: timeZone() });
  const stand = data ? standFmt.format(new Date(data.snapshot?.at ?? data.createdAt)) : null;
  // Ältere Berichte haben keine Kernaussage — dann trägt der Lage-Satz selbst den Kopf.
  const headline: ReportStatement | null = data?.headline ?? null;
  const HEADLINE = "max-w-[62ch] text-balance font-display text-title2 font-semibold leading-[1.18] tracking-[-.01em] text-a-ink @md:text-title @3xl:text-title";

  return (
    <div ref={rootRef} data-testid="briefing-root" className={cn("cc-briefing @container grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4", className)}>
      <header data-testid="briefing-head" className="cc-card relative grid min-w-0 gap-3 overflow-hidden p-4 pt-5 sm:gap-4 sm:p-6 sm:pt-7">
        {/* Kopf als EINE ruhige Fläche – kein Farbschein, kein Farbband (keine zweifarbigen Kacheln). */}
        <div data-speech-dim className="flex min-w-0 flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-label uppercase tracking-[.14em] text-a-acc">
              {kindLabel} · <span className="normal-case tracking-normal text-a-mut">{dateText}</span>
              {stand && <span className="normal-case tracking-normal text-a-mut">{` · ${t("Stand {time}", { time: stand })}`}</span>}
            </p>
            <h2 className="mt-1 font-display text-title2 font-semibold text-a-mut">{greetingFor(now, greetingName)}</h2>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div role="group" aria-label={t("Bericht wählen")} className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-line bg-a-p2 p-0.5">
              {(["briefing", "recap"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={cn("h-full rounded-md px-2.5 text-caption transition-colors duration-150", kind === k ? "bg-a-p3 text-a-ink" : "text-a-mut hover:text-a-ink")}
                >
                  {k === "briefing" ? t("Briefing") : t("Recap")}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-pressed={light}
              onClick={() => setLight(!light)}
              className={cn(TOGGLE, light ? "border-a-acc/50 bg-a-acc/10 text-a-acc" : "border-a-line bg-a-p2 text-a-mut hover:text-a-ink")}
            >
              {t("Leichter Tag")}
            </button>
            {data && <ReadAloudButton ra={{ ...readAloud, start: startReading }} disabled={create.isPending} />}
            {data && (
              <button type="button" disabled={create.isPending} onClick={() => create.mutate()} className={cn(TOGGLE, "border-a-line bg-a-p2 text-a-mut hover:text-a-ink disabled:opacity-50")}>
                {create.isPending ? t("Erstellt …") : t("Jetzt neu erstellen")}
              </button>
            )}
          </div>
        </div>
        {data && <ReadAloudProgress ra={readAloud} />}
        {data && !headline && (
          <div data-testid="briefing-headline" data-speech-target="headline">
            <p data-testid="briefing-lage" className={HEADLINE}>
              {data.lage}
            </p>
          </div>
        )}
        {headline && (
          <p data-testid="briefing-headline" data-speech-target="headline" className={HEADLINE}>
            {headline.author === "haiku" && (
              <span title={t("Kernaussage von Nyx")} className="mr-2 inline-grid h-6 w-6 place-items-center rounded-full bg-a-acc/15 align-[5px] font-display text-caption font-bold text-a-acc sm:h-7 sm:w-7">
                N<span className="sr-only">yx:</span>
              </span>
            )}
            {headline.text}
          </p>
        )}
        {data && headline && (
          <p data-testid="briefing-lage" data-speech-dim className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-callout leading-relaxed text-a-mut">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-a-ok" />
            {data.lage}
          </p>
        )}
        {(data?.stale || data?.mode === "nur-daten" || create.isPending || create.isError) && (
          <div data-speech-dim className="grid min-w-0 gap-2">
            {data?.stale && stand && (
              <p role="status" className="w-fit rounded-md border border-a-acc/30 bg-a-acc/10 px-2 py-1 text-caption text-a-acc">
                {create.isPending ? t("Seit {time} hat sich etwas geändert – wird gerade neu geschrieben.", { time: stand }) : t("Seit {time} hat sich etwas geändert – „Jetzt neu erstellen“ holt den aktuellen Stand.", { time: stand })}
              </p>
            )}
            {data?.mode === "nur-daten" && (
              <p className="w-fit rounded-md border border-a-wait/30 bg-a-wait/10 px-2 py-1 text-caption text-a-wait">{t("Ohne Nyx erstellt – {reason}", { reason: data.modeReason ?? t("Nyx war nicht bereit.") })}</p>
            )}
            {create.isPending && <Writing />}
            {create.isError && (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-caption text-a-bad">
                <span>{t("{kind} ließ sich gerade nicht neu schreiben.", { kind: kindWord })} {errorText(create.error)}</span>
                <button type="button" onClick={() => create.mutate()} className="rounded-md border border-a-line px-2 py-0.5 text-caption text-a-ink hover:bg-a-p3">
                  {t("Erneut versuchen")}
                </button>
                <ErrorDetails error={create.error} />
              </div>
            )}
          </div>
        )}
      </header>

      {afterHead}

      {report.isLoading && <BriefingSkeleton />}
      {report.isError && <ErrorBox text={t("{kind} konnte nicht geladen werden.", { kind: kindWord })} onRetry={() => void report.refetch()} />}

      {report.isSuccess && !data && !create.isPending && (
        <div className="cc-card grid justify-items-start gap-3 p-5">
          <p className="text-callout text-a-mut">{kind === "briefing" ? t("Für heute gibt es noch kein Briefing.") : t("Für heute gibt es noch keinen Recap.")}</p>
          <button
            type="button"
            onClick={() => create.mutate()}
            className="rounded-lg border border-a-acc bg-a-acc px-3 py-1.5 text-caption font-semibold text-a-bg hover:brightness-110"
          >
            {t("{kind} jetzt erstellen", { kind: kindWord })}
          </button>
        </div>
      )}

      {light ? (
        <LightDayBlock onToast={toast.show} />
      ) : (
        data && (
          <>
            <NeedsYou items={data.needsYou} />
            {data.figures ? (
              <>
                <KpiGrid figures={data.figures} highlights={data.highlights ?? []} />
                <ChartGrid figures={data.figures} order={data.chartOrder} />
              </>
            ) : (
              <p className="cc-card px-4 py-3 text-caption text-a-mut">{t("Kennzahlen und Graphen kommen mit dem nächsten Briefing – „Jetzt neu erstellen“ holt sie sofort.")}</p>
            )}
            <Story sections={data.sections} />
            <RunsWithoutYou items={data.runsWithoutYou} onToast={toast.show} />
          </>
        )
      )}
      <ToastView message={toast.message} />
      <ReaderBar ra={{ ...readAloud, start: startReading }} />
    </div>
  );
}

export function BriefingPage() {
  // Volle Breite (nur ein schmaler Rand), damit Kacheln und Graphen Platz haben.
  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] gap-4 px-3 py-4 sm:px-5 sm:py-5 xl:px-6">
      {/* „Seit du weg warst“, derselbe Stand wie im Überblick. Unter der Kernaussage statt
          darüber – auf dem Handy stünde die Kernaussage sonst erst unter der Karte. */}
      <Briefing afterHead={<SinceCard collapsible place="briefing" />} />
    </div>
  );
}

/** „Was lief / Was hängt / Was als Nächstes“ — die Bericht-Abschnitte in drei Gruppen, jede in ihrer Farbe. */
function Story({ sections }: { sections: HaikuReport["sections"] }) {
  const groups = GROUP_ORDER.map((g) => ({ g, parts: sections.filter((s) => briefGroupOf(s.title) === g) }));
  return (
    <div data-testid="briefing-story" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 @5xl:grid-cols-3">
      {groups.map(({ g, parts }, i) => {
        const statements = parts.flatMap((p) => p.statements.map((st) => ({ st, sub: parts.length > 1 ? p.title : null })));
        return (
          <section key={g} aria-label={t(BRIEF_GROUP_TITLE[g])} data-speech-target={briefGroupTarget(g)} className="cc-card cc-rise relative grid min-w-0 content-start gap-3 overflow-hidden p-4 sm:p-5" style={{ ...riseStyle(i + 7), "--speech-accent": GROUP_COLOR[g] } as CSSProperties}>
            <span aria-hidden="true" className="absolute inset-y-4 left-0 w-[3px] rounded-r-full" style={{ background: GROUP_COLOR[g] }} />
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 font-display text-headline font-semibold text-a-ink">
                <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: GROUP_COLOR[g] }} />
                {t(BRIEF_GROUP_TITLE[g])}
              </h3>
              {statements.length > 0 && <AskNyxButton compact inline={false} label={t("Nyx zu „{label}“ fragen", { label: t(BRIEF_GROUP_TITLE[g]) })} question={t("Fass mir „{label}“ aus meinem Briefing kurz zusammen.", { label: t(BRIEF_GROUP_TITLE[g]) })} facts={statements.map(({ st }) => `- ${st.text}`).join("\n")} />}
            </div>
            {statements.length === 0 ? (
              <p className="text-callout text-a-mut">{GROUP_EMPTY[g]}</p>
            ) : (
              <ul className="grid min-w-0 gap-3">
                {statements.map(({ st, sub }, j) => (
                  <Statement key={`${g}-${j}`} statement={st} sub={sub} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Writing() {
  return (
    <div className="flex items-center gap-2 text-caption text-a-mut" role="status">
      <span className="cc-typing inline-flex items-center gap-1" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {t("Nyx schreibt … das kann bis zu einer Minute dauern.")}
    </div>
  );
}

function BriefingSkeleton() {
  return (
    <div className="grid gap-4" aria-label={t("Lädt")}>
      {[112, 148, 96].map((h) => (
        <div key={h} className="animate-pulse rounded-xl bg-a-p2 motion-reduce:animate-none" style={{ height: h }} />
      ))}
    </div>
  );
}

function Statement({ statement, sub = null }: { statement: ReportStatement; sub?: string | null }) {
  return (
    <li className="grid min-w-0 gap-1.5">
      {sub && <span className="font-mono text-label uppercase tracking-[.12em] text-a-mut">{sub}</span>}
      <p className="min-w-0 break-words text-headline leading-relaxed text-a-ink">
        {statement.author === "haiku" && (
          <span title={t("Satz von Nyx")} className="mr-1.5 inline-grid h-4 w-4 place-items-center rounded-full bg-a-acc/15 align-[1px] font-display text-label font-bold text-a-acc">
            N<span className="sr-only">yx:</span>
          </span>
        )}
        {statement.text}
      </p>
      {(statement.sources.length > 0 || statement.estimate || statement.corrected) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <SourceChips sources={statement.sources} />
          {statement.estimate && <EstimateTag />}
          {statement.corrected && (
            <span
              title={t("Nyx hatte hier eine Zahl, die nicht zu den Daten passte – das ist der Satz aus den Daten.")}
              className="rounded-full border border-a-wait/30 bg-a-wait/10 px-2 py-px text-label text-a-wait"
            >
              {t("Zahl korrigiert")}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function ItemBody({ item }: { item: ReportItem }) {
  return (
    <>
      <span
        className="min-w-[78px] shrink-0 rounded-full border px-2 py-px text-center font-mono text-label"
        style={{ color: ITEM_COLOR[item.kind], borderColor: `color-mix(in srgb, ${ITEM_COLOR[item.kind]} 35%, transparent)`, background: `color-mix(in srgb, ${ITEM_COLOR[item.kind]} 10%, transparent)` }}
      >
        {ITEM_KIND[item.kind]}
      </span>
      <span className="min-w-[min(100%,140px)] flex-1">
        <span className="block truncate text-callout text-a-ink">{item.title}</span>
        {item.detail && <span className="block truncate text-caption text-a-mut">{item.detail}</span>}
      </span>
    </>
  );
}

const ROW = "flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-150";

function RunsWithoutYou({ items, onToast }: { items: ReportItem[]; onToast: (m: string) => void }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const release = useMutation({
    mutationFn: () => releaseAll(items.map((i) => i.id)),
    onSuccess: (r) => {
      setConfirming(false);
      onToast(plural(r.released, "{n} Punkt freigegeben", "{n} Punkte freigegeben"));
      for (const key of [["haiku", "report"], ["approvals"], ["inbox"], ["haiku", "light-day"]]) void qc.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <section aria-label={t("Läuft ohne dich")} className="cc-card cc-rise grid min-w-0 gap-2 p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="font-display text-headline font-semibold text-a-ink">{t("Läuft ohne dich")}</h3>
        <span className="font-mono text-label text-a-mut">{items.length}</span>
        <span className="flex-1" />
        {items.length > 0 && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-lg border border-a-acc bg-a-acc px-3 py-1 text-caption font-semibold text-a-bg hover:brightness-110"
          >
            {t("Alles freigeben")}
          </button>
        )}
      </div>
      {confirming && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-a-acc/30 bg-a-acc/5 px-3 py-2 text-caption text-a-ink">
          <span className="min-w-0 flex-1">{plural(items.length, "{n} Punkt ohne weitere Frage freigeben?", "{n} Punkte ohne weitere Frage freigeben?")}</span>
          <button
            type="button"
            disabled={release.isPending}
            onClick={() => release.mutate()}
            className="rounded-md border border-a-acc bg-a-acc px-2.5 py-1 text-caption font-semibold text-a-bg disabled:opacity-50"
          >
            {t("Ja, {n} freigeben", { n: items.length })}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded-md px-2 py-1 text-caption text-a-mut hover:text-a-ink">
            {t("Abbrechen")}
          </button>
        </div>
      )}
      {release.isError && <p className="text-caption text-a-bad">{t("Freigabe fehlgeschlagen: {error}", { error: errorText(release.error) })}</p>}
      {items.length === 0 ? (
        <p className="px-1 text-caption text-a-mut">{t("Nichts, das allein laufen kann.")}</p>
      ) : (
        <ul className="grid min-w-0 gap-0.5">
          {items.map((item, i) => (
            <li key={item.id} className="cc-rise min-w-0" style={riseStyle(i)}>
              {item.href ? (
                <Link to={item.href} className={cn(ROW, "hover:bg-a-p2")}>
                  <ItemBody item={item} />
                </Link>
              ) : (
                <div className={ROW}>
                  <ItemBody item={item} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** „Braucht dich“ oben, als Knöpfe in einem Raster (schmal einspaltig) — ein Klick öffnet die Stelle. */
function NeedsYou({ items }: { items: ReportItem[] }) {
  const total = items.reduce((a, i) => a + Math.max(0, i.minutes), 0);
  return (
    <section aria-label={t("Braucht dich")} data-testid="briefing-needs" data-speech-target="needs" className="cc-card cc-rise relative grid min-w-0 gap-3 overflow-hidden p-4 sm:p-5" style={{ ...riseStyle(1), "--speech-accent": "var(--a-wait)" } as CSSProperties}>
      <span aria-hidden="true" className="absolute inset-y-4 left-0 w-[3px] rounded-r-full bg-a-wait" />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 className="font-display text-headline font-semibold text-a-ink">{t("Braucht dich")}</h3>
        <span data-testid="needs-count" className="rounded-full bg-a-wait/15 px-2 py-px font-mono text-caption tabular-nums text-a-wait">
          {items.length}
        </span>
        {items.length > 0 && <span className="text-caption text-a-mut">{total <= 0 ? t("zusammen etwa ein paar Klicks") : t("zusammen etwa {m} Min", { m: total })}</span>}
      </div>
      {items.length === 0 ? (
        <p className="text-callout text-a-mut">{t("Nichts wartet auf dich.")}</p>
      ) : (
        <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 @3xl:grid-cols-2 @[1400px]:grid-cols-3">
          {items.map((item, i) => {
            const body = (
              <>
                <ItemBody item={item} />
                <span className="shrink-0 font-mono text-caption tabular-nums text-a-mut">{minutesLabel(item.minutes)}</span>
                {item.href && (
                  <span aria-hidden="true" className="shrink-0 text-a-mut transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-a-ink">
                    →
                  </span>
                )}
              </>
            );
            const btn = "group flex min-h-[52px] min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 @md:flex-nowrap rounded-lg border border-a-line bg-a-p2/60 px-3 py-2 transition-[border-color,background-color] duration-150";
            return (
              <li key={item.id} className="cc-rise grid min-w-0 content-start" style={riseStyle(i)}>
                {item.href ? (
                  <Link to={item.href} className={cn(btn, "hover:border-a-acc/50 hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc")}>
                    {body}
                  </Link>
                ) : (
                  <div className={btn}>{body}</div>
                )}
                {/* Rohmeldung nur aufklappbar und außerhalb des Links (Aufklappen springt nicht weg). */}
                {item.rawDetail && <RawDetails text={item.rawDetail} className="px-3 pb-1 pt-1" />}
                {/* Kurz von Nyx erklären lassen, was hier ansteht (klein, außerhalb des Links). */}
                <div className="px-1 pt-1">
                  <AskNyxButton label={t("Nyx fragen")} question={t("Worum geht es bei „{title}“ und was soll ich tun?", { title: item.title })} facts={[item.title, item.detail ?? "", item.minutes > 0 ? t("Aufwand etwa {m} Minuten.", { m: item.minutes }) : ""].filter(Boolean).join("\n")} className="h-6" />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LightDayBlock({ onToast }: { onToast: (m: string) => void }) {
  const lightDay = useQuery({ queryKey: ["haiku", "light-day"], queryFn: fetchLightDay });
  const items = (lightDay.data?.items ?? []).filter((i) => i.zeroEnergy);
  const deferred = lightDay.data?.deferred ?? 0;

  return (
    <section aria-label={t("Leichter Tag")} className="cc-card cc-rise grid min-w-0 gap-2 p-4">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-headline font-semibold text-a-ink">{t("Leichter Tag")}</h3>
        <span className="text-caption text-a-mut">{t("nur, was keine Energie kostet")}</span>
      </div>
      {lightDay.isLoading && <div className="h-24 animate-pulse rounded-lg bg-a-p2 motion-reduce:animate-none" />}
      {lightDay.isError && <ErrorBox text={t("Leichter Tag konnte nicht geladen werden.")} onRetry={() => void lightDay.refetch()} />}
      {lightDay.isSuccess && items.length === 0 && <p className="px-1 text-caption text-a-mut">{t("Heute ist nichts ohne Aufwand offen.")}</p>}
      {items.length > 0 && (
        <ul className="grid min-w-0 gap-1.5">
          {items.map((item, i) => (
            <LightItem key={item.id} item={item} index={i} onToast={onToast} />
          ))}
        </ul>
      )}
      {lightDay.isSuccess && deferred > 0 && <p className="px-1 text-caption text-a-mut">{plural(deferred, "{n} Punkt still auf später verschoben", "{n} Punkte still auf später verschoben")}</p>}
    </section>
  );
}

function LightItem({ item, index, onToast }: { item: ReportItem; index: number; onToast: (m: string) => void }) {
  const answer = useAnswerInbox(220);
  const decide = useDecideApproval(220);
  const busy = answer.isPending || decide.isPending;
  const done = answer.isSuccess || decide.isSuccess;
  const action = item.action;

  return (
    <li className={cn("cc-rise flex min-w-0 flex-wrap items-center gap-2.5 rounded-lg border border-a-line bg-a-p2/60 px-3 py-2", done && "cc-leave")} style={riseStyle(index)}>
      <ItemBody item={item} />
      {/* Freigeben/Ja/Nein im Briefing entscheidest nur du — nie der Nyx-Cursor. */}
      <span className="flex shrink-0 flex-wrap gap-1.5" data-nyx-risk={action ? "" : undefined}>
        {action?.type === "approval" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => decide.mutate({ id: action.approvalId, decision: "approve" }, { onSuccess: () => onToast(t("Freigegeben – gilt genau einmal")) })}
              className="rounded-md border border-a-acc bg-a-acc px-2.5 py-1 text-caption font-semibold text-a-bg disabled:opacity-50"
            >
              {t("Freigeben")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => decide.mutate({ id: action.approvalId, decision: "deny" }, { onSuccess: () => onToast(t("Abgelehnt")) })}
              className="rounded-md border border-a-line bg-a-p2 px-2.5 py-1 text-caption text-a-ink disabled:opacity-50"
            >
              {t("Ablehnen")}
            </button>
          </>
        )}
        {action?.type === "inbox" &&
          action.options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={busy}
              onClick={() => answer.mutate({ id: action.inboxId, answer: { optionId: opt.id } }, { onSuccess: () => onToast(t("Antwort gespeichert")) })}
              className="min-w-12 rounded-md border border-a-line bg-a-p3 px-3 py-1 text-caption font-medium text-a-ink hover:border-a-acc/60 disabled:opacity-50"
            >
              {opt.label}
            </button>
          ))}
        {!action && item.href && (
          <Link to={item.href} className="rounded-md border border-a-line px-2.5 py-1 text-caption text-a-acc">
            {t("Öffnen")}
          </Link>
        )}
      </span>
      {(answer.isError || decide.isError) && <p className="w-full text-caption text-a-bad">{t("Nicht gespeichert – bitte noch einmal.")}</p>}
    </li>
  );
}
