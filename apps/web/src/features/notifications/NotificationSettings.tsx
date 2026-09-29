// The settings subpage "Mitteilungen" (without its own PageShell/page title: the settings register mounts it as the
// area "mitteilungen"). Top to bottom, one column:
//   Wann?            per occasion Immer / Wenn weg / Nie (session occasions open, the rest under "Weitere Anlässe")
//   Wie geschrieben? ─┐ own subpages (`/settings/mitteilungen-stil`, `…-nyx`); this page only shows two rows with a
//   Nyx              ─┘ summary ("Stil: Mit Zusammenhang", "Nyx prüft: aus"). Important ones (urgent, approvals,
//                       crashes) always get through.
//   Wege             computer, browser, phone, Telegram + test
//   Verlauf          last notifications with reason, "Passt" / "Brauche ich nicht", rule suggestions
//   Erweitert        quiet hours, bundling, waiting time, minimum gap, away detection, own templates, phone, click address
// Replaces the former panels `PushSettingsPanel` + `AwaySettingsPanel` (no duplicate switches).
import {
  NOTIFY_KINDS,
  NOTIFY_OCCASIONS,
  NOTIFY_STYLE_LABEL,
  NOTIFY_WHEN_LABEL,
  renderNotification,
  t,
  type NotifyRules,
  type NotifySettingsPatch,
  type NotifySettingsResponse,
  type NotifyStyle,
  type NotifyWhen,
  type PushEventKind,
} from "@nyxos/shared";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { usePatchNotifySettings, useNotifyPreview, useNotifySettings } from "./api";
import { clockTime } from "./clock";
import { NotificationAdvanced } from "./NotificationAdvanced";
import { NotificationChannels } from "./NotificationChannels";
import { NotificationHistory } from "./NotificationHistory";
import { BTN, BTN_ACCENT, LABEL, LockscreenCard, Section, Segmented, SelectField, SwitchRow } from "./parts";

const WHEN_TONES: { value: NotifyWhen; tone: "ok" | "wait" | "mut" }[] = [
  { value: "always", tone: "ok" },
  { value: "away", tone: "wait" },
  { value: "never", tone: "mut" },
];

/** Built on render: the language can change at runtime. */
function whenOptions(): { value: NotifyWhen; label: string; tone: "ok" | "wait" | "mut" }[] {
  return WHEN_TONES.map((o) => ({ ...o, label: t(NOTIFY_WHEN_LABEL[o.value]) }));
}

/** Short confirmation at the bottom ("Gespeichert") – a live region for screen readers. */
function useSavedFlash(): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);
  return [
    text,
    (next: string) => {
      setText(next);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setText(null), 1800);
    },
  ];
}

/** Occasions around your sessions – always open; the rest sits under "Weitere Anlässe". */
const MAIN_KINDS: readonly PushEventKind[] = (["session_waiting", "session_done", "approval_needed", "session_crashed", "context_guard_hinweis"] as const).filter((k) =>
  (NOTIFY_KINDS as readonly string[]).includes(k),
);
const MORE_KINDS: readonly PushEventKind[] = NOTIFY_KINDS.filter((k) => !MAIN_KINDS.includes(k));

/** "Build rot: Immer · Neuer Bug: Wenn weg …" – the collapsed levels at a glance. */
function moreSummary(when: NotifyRules["when"]): string {
  return MORE_KINDS.map((k) => `${t(NOTIFY_OCCASIONS[k].label)}: ${t(NOTIFY_WHEN_LABEL[when[k]])}`).join(" · ");
}

function WhenRow({ kind, data, save, busy }: { kind: PushEventKind; data: NotifySettingsResponse; save: (p: NotifySettingsPatch) => void; busy: boolean }) {
  const meta = NOTIFY_OCCASIONS[kind];
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-xl border border-a-line bg-a-p px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-testid={`when-${kind}`}>
      <div className="min-w-0">
        <div className="text-callout font-medium text-a-ink">{t(meta.label)}</div>
        <p className="text-caption text-a-mut">{t(meta.text)}</p>
      </div>
      <Segmented compact label={t("{label}: wann melden", { label: t(meta.label) })} options={whenOptions()} value={data.rules.when[kind]} disabled={busy} onChange={(v) => save({ rules: { when: { [kind]: v } } })} />
    </li>
  );
}

function WhenList({ data, save, busy }: { data: NotifySettingsResponse; save: (p: NotifySettingsPatch) => void; busy: boolean }) {
  const presence = data.presence.away
    ? t("Gerade bist du weg – „Wenn weg“-Mitteilungen kommen.")
    : data.away.enabled
      ? t("Gerade bist du da. „Weg“ heißt: {n} Min kein aktives NyxOS-Fenster.", { n: data.away.awayAfterMinutes })
      : t("Die Weg-Erkennung ist aus (Erweitert) – „Wenn weg“ meldet sich dann nie.");
  return (
    <Section id="wann" title={t("Wann?")} intro={t("Für jeden Anlass: immer melden, nur wenn du nicht in NyxOS bist, oder nie.")}>
      <p className="text-caption text-a-mut" data-testid="notify-presence">
        {presence}
      </p>
      <ul className="grid gap-1.5">
        {MAIN_KINDS.map((kind) => (
          <WhenRow key={kind} kind={kind} data={data} save={save} busy={busy} />
        ))}
      </ul>
      {/* Eleven equal rows were ~1200 px on a phone alone – the rare occasions are collapsed. */}
      {MORE_KINDS.length > 0 && (
        <details className="group min-w-0 rounded-xl border border-a-line" data-testid="when-more">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="text-a-mut transition-transform duration-150 group-open:rotate-90">
              ›
            </span>
            <span className="grid min-w-0">
              <span className="text-callout font-medium text-a-ink">{t("Weitere Anlässe ({n})", { n: MORE_KINDS.length })}</span>
              <span className="truncate text-caption text-a-mut">{moreSummary(data.rules.when)}</span>
            </span>
          </summary>
          <ul className="grid gap-1.5 border-t border-a-line p-1.5">
            {MORE_KINDS.map((kind) => (
              <WhenRow key={kind} kind={kind} data={data} save={save} busy={busy} />
            ))}
          </ul>
        </details>
      )}
      <div className="rounded-xl border border-a-line bg-a-p px-3 py-1">
        <SwitchRow
          title={t("Unter-Agenten nie melden")}
          hint={t("Helfer, die eine Session selbst startet (z. B. Codex-Worker wie „Locke: …“). Die startest du nicht selbst – gemeldet wird nur die Haupt-Session.")}
          on={data.rules.skipSubAgents}
          disabled={busy}
          testId="skip-subagents"
          onChange={(v) => save({ rules: { skipSubAgents: v } })}
        />
      </div>
    </Section>
  );
}

/** On its own subpage without a second heading (the page carries the title) and without an anchor id (the frame has it). */
function Block({ bare, id, title, intro, children }: { bare: boolean; id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  if (!bare)
    return (
      <Section id={id} title={title} intro={intro}>
        {children}
      </Section>
    );
  return (
    <div className="grid min-w-0 gap-3">
      {intro && <p className="text-callout text-a-mut">{intro}</p>}
      {children}
    </div>
  );
}

function StyleSection({
  data,
  save,
  busy,
  example,
  setExample,
  bare = false,
}: {
  data: NotifySettingsResponse;
  save: (p: NotifySettingsPatch) => void;
  busy: boolean;
  example: PushEventKind;
  setExample: (k: PushEventKind) => void;
  bare?: boolean;
}) {
  const rules = data.rules;
  const now = useNow();
  const meta = NOTIFY_OCCASIONS[example];
  const preview = useMemo(
    () =>
      renderNotification(
        example,
        rules.style,
        { session: meta.session ? data.sample.session : null, baustelle: meta.session ? data.sample.baustelle : null, was: t(meta.sample.was), wann: clockTime(now), details: t(meta.sample.details) },
        rules.templates[example] ?? null,
      ),
    [example, rules.style, rules.templates, data.sample, meta, now],
  );
  const nyxPreview = useNotifyPreview();
  const nyxOn = rules.nyxReview || rules.nyxWrite;
  const resetNyx = nyxPreview.reset;
  // Nyx' trial only holds for the example/style it ran with.
  useEffect(() => resetNyx(), [example, rules.style, resetNyx]);
  return (
    <Block bare={bare} id="wie" title={t("Wie geschrieben?")} intro={t("Der Name ist immer der Titel der Session oder die Baustelle – nie der rohe Prompt.")}>
      <div role="radiogroup" aria-label={t("Stil der Mitteilungen")} className="grid gap-1.5" data-testid="style-choice">
        {(Object.keys(NOTIFY_STYLE_LABEL) as NotifyStyle[]).map((style) => {
          const active = rules.style === style;
          return (
            <button
              key={style}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              onClick={() => !active && save({ rules: { style } })}
              className={cn(
                "flex min-h-11 items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-a-acc disabled:opacity-60",
                active ? "border-a-acc/60 bg-a-p2" : "border-a-line bg-a-p hover:border-a-line-strong",
              )}
            >
              <span aria-hidden className={cn("mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full border", active ? "border-a-acc" : "border-a-mut")}>
                {active && <span className="h-2 w-2 rounded-full bg-a-acc" />}
              </span>
              <span className="min-w-0">
                <span className="block text-callout font-medium text-a-ink">
                  {t(NOTIFY_STYLE_LABEL[style].title)}
                  {style === "zusammenhang" && <span className="ml-2 font-mono text-label uppercase tracking-wide text-a-mut">{t("Standard")}</span>}
                </span>
                <span className="block text-caption text-a-mut">{t(NOTIFY_STYLE_LABEL[style].text)}</span>
              </span>
            </button>
          );
        })}
      </div>
      <label className="grid gap-1">
        <span className={LABEL}>{t("Beispiel")}</span>
        <SelectField value={example} onChange={(v) => setExample(v as PushEventKind)} testId="preview-kind">
          {NOTIFY_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(NOTIFY_OCCASIONS[k].label)}
            </option>
          ))}
        </SelectField>
      </label>
      <LockscreenCard title={preview.title} body={preview.body} time={clockTime(now)} testId="notify-preview" />
      {rules.templates[example] && <p className="text-caption text-a-mut">{t("Für diesen Anlass gilt deine eigene Vorlage (Mitteilungen → Erweitert).")}</p>}
      {nyxOn && (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={cn(BTN, BTN_ACCENT)} disabled={nyxPreview.isPending} onClick={() => nyxPreview.mutate({ kind: example, style: rules.style, withNyx: true })}>
              {nyxPreview.isPending ? t("Nyx schreibt …") : t("Mit Nyx ausprobieren")}
            </button>
            <span className="text-caption text-a-mut">{t("Ein kurzer Nyx-Lauf, zählt ins Nyx-Budget.")}</span>
          </div>
          {nyxPreview.isError && <p className="text-caption text-a-bad">{friendlyError(nyxPreview.error, t("Nyx konnte gerade nicht – bitte noch einmal versuchen."))}</p>}
          {nyxPreview.data && (
            <div className="grid gap-2" aria-live="polite">
              <LockscreenCard label={t("So würde Nyx es schreiben")} title={nyxPreview.data.title} body={nyxPreview.data.body} time={nyxPreview.data.time} testId="notify-preview-nyx" />
              {nyxPreview.data.nyx && (
                <p className="text-caption text-a-mut">
                  {nyxPreview.data.nyx.decision
                    ? `${nyxPreview.data.nyx.decision === "senden" ? t("Nyx würde senden.") : nyxPreview.data.nyx.decision === "weglassen" ? t("Nyx würde sie weglassen.") : t("Nyx würde sie mit der nächsten bündeln.")} `
                    : ""}
                  {nyxPreview.data.nyx.note ?? ""}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Block>
  );
}

/** Time for the preview, refreshed every minute. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function NyxSection({ rules, nyxReady, save, busy, bare = false }: { rules: NotifyRules; nyxReady: boolean; save: (p: NotifySettingsPatch) => void; busy: boolean; bare?: boolean }) {
  const [important, setImportant] = useState(rules.important);
  useEffect(() => setImportant(rules.important), [rules.important]);
  const dirty = important.trim() !== rules.important;
  return (
    <Block bare={bare} id="nyx" title="Nyx" intro={t("Nyx kann jede Mitteilung vorher ansehen und selbst schreiben. Jede Entscheidung steht mit Grund im Verlauf.")}>
      {!nyxReady && (
        <p className="rounded-lg border border-a-line bg-a-p px-3 py-2 text-caption text-a-wait" data-testid="nyx-unavailable">
          {t("Nyx ist gerade nicht erreichbar – Mitteilungen gehen dann ganz normal ohne Nyx raus. Einrichten unter Modelle & Konnektoren.")}
        </p>
      )}
      <div className="grid gap-0.5 rounded-xl border border-a-line bg-a-p px-3 py-1">
        <SwitchRow
          title={t("Nyx prüft jede Mitteilung")}
          hint={t("Nyx entscheidet: senden, weglassen oder mit der nächsten bündeln. Antwortet Nyx nicht in 8 Sekunden, geht sie ganz normal raus.")}
          on={rules.nyxReview}
          disabled={busy}
          testId="nyx-review"
          onChange={(v) => save({ rules: { nyxReview: v } })}
        />
        <SwitchRow
          title={t("Nyx schreibt den Text")}
          hint={t("Aus den letzten Schritten der Session, im gewählten Stil. Zahlen und Namen nur aus den Daten – sonst bleibt die Vorlage.")}
          on={rules.nyxWrite}
          disabled={busy}
          testId="nyx-write"
          onChange={(v) => save({ rules: { nyxWrite: v } })}
        />
        <SwitchRow
          title={t("Wichtiges kommt immer durch")}
          hint={t("Freigaben, Abstürze und „Deploy fehlgeschlagen“ kann Nyx nicht wegfiltern.")}
          on={rules.protectUrgent}
          disabled={busy}
          onChange={(v) => save({ rules: { protectUrgent: v } })}
        />
      </div>
      <label className="grid gap-1.5">
        <span className="text-callout text-a-ink">{t("Was mir wichtig ist")}</span>
        <span className="text-caption text-a-mut">{t("Nyx liest das bei jeder Prüfung mit – dazu deine Rückmeldungen aus dem Verlauf.")}</span>
        <textarea
          value={important}
          maxLength={1000}
          rows={3}
          onChange={(e) => setImportant(e.target.value)}
          onBlur={() => dirty && save({ rules: { important: important.trim() } })}
          placeholder={t("z. B. Melde dich nur, wenn eine Session wirklich blockiert ist. Kontext-Hinweise brauche ich nur, wenn ich weg bin.")}
          className="w-full rounded-lg border border-a-line bg-a-p2 px-2.5 py-2 text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none"
          data-testid="nyx-important"
        />
      </label>
      {dirty && (
        <div>
          <button type="button" className={cn(BTN, BTN_ACCENT)} disabled={busy} onClick={() => save({ rules: { important: important.trim() } })}>
            {t("Speichern")}
          </button>
        </div>
      )}
      {!rules.nyxReview && important.trim() && <p className="text-caption text-a-mut">{t("Wirkt, sobald „Nyx prüft jede Mitteilung“ an ist.")}</p>}
    </Block>
  );
}

/** Summary "Stil: …" for the row on the notifications page. */
export function styleSummary(rules: NotifyRules): string {
  return t("Stil: {style}", { style: t(NOTIFY_STYLE_LABEL[rules.style].title) });
}

/** Summary "Nyx prüft: aus" (+ "schreibt selbst" when on). */
export function nyxSummary(rules: NotifyRules): string {
  const base = rules.nyxReview ? t("Nyx prüft: an") : t("Nyx prüft: aus");
  return rules.nyxWrite ? `${base} · ${t("schreibt selbst")}` : base;
}

/** Row to a subpage (like in the settings overview): title, summary, arrow. */
function SubpageRow({ to, title, summary, testId }: { to: string; title: string; summary: string; testId: string }) {
  return (
    <Link
      to={to}
      state={{ fromParent: true }}
      data-testid={testId}
      // Nyx-Cursor findet die Unterseite (Klickpfad der NyxOS-Karte: settings-sub:<bereich>).
      data-nyx={`settings-sub:${to.replace(/^\/settings\//, "").split("#")[0]}`}
      className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-a-p2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-a-acc"
    >
      <span className="grid min-w-0 flex-1">
        <span className="text-callout font-medium text-a-ink">{title}</span>
        <span className="truncate text-caption text-a-mut">{summary}</span>
      </span>
      <span aria-hidden className="text-headline text-a-mut">
        ›
      </span>
    </Link>
  );
}

interface FrameCtx {
  data: NotifySettingsResponse;
  save: (p: NotifySettingsPatch) => void;
  busy: boolean;
}

/** Loading, error, save error and the short confirmation "✓ Gespeichert" – the same for all three pages. */
function NotifyFrame({ testId, children }: { testId: string; children: (ctx: FrameCtx) => ReactNode }) {
  const settings = useNotifySettings();
  const [flash, setFlash] = useSavedFlash();
  const patch = usePatchNotifySettings(() => setFlash(t("Gespeichert")));
  const save = (p: NotifySettingsPatch) => patch.mutate(p);

  if (settings.isLoading) {
    return (
      <div className="grid gap-3" aria-busy="true" aria-label={t("Mitteilungen laden")}>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (settings.isError || !settings.data) {
    return (
      <div className="grid gap-2 rounded-xl border border-a-line bg-a-p p-4">
        <p className="text-callout text-a-bad">{friendlyError(settings.error, t("Die Mitteilungs-Einstellungen konnten nicht geladen werden."))}</p>
        <div>
          <button type="button" className={BTN} onClick={() => void settings.refetch()}>
            {t("Erneut versuchen")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-10" data-testid={testId}>
      {patch.isError && (
        <p role="alert" className="rounded-lg border border-a-bad/40 bg-a-p px-3 py-2 text-callout text-a-bad">
          {friendlyError(patch.error, t("Das hat nicht geklappt – bitte noch einmal versuchen."))}
        </p>
      )}
      {children({ data: settings.data, save, busy: patch.isPending })}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "cc-above-tabbar pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-40 flex justify-center transition-opacity duration-200",
          flash ? "opacity-100" : "opacity-0",
        )}
      >
        {flash && <span className="rounded-full border border-a-line bg-a-p2 px-3 py-1.5 text-caption text-a-ink">✓ {flash}</span>}
      </div>
    </div>
  );
}

export function NotificationSettings() {
  const [example, setExample] = useState<PushEventKind>("session_waiting");
  return (
    <NotifyFrame testId="notification-settings">
      {({ data, save, busy }) => (
        <>
          <WhenList data={data} save={save} busy={busy} />
          {/* Style and Nyx are own subpages – here only how they are set right now. */}
          <nav aria-label={t("Text und Nyx")} className="grid min-w-0 divide-y divide-a-line overflow-hidden rounded-xl border border-a-line bg-a-p">
            <SubpageRow to="/settings/mitteilungen-stil" title={t("Wie geschrieben?")} summary={styleSummary(data.rules)} testId="notify-row-style" />
            <SubpageRow to="/settings/mitteilungen-nyx" title={t("Nyx prüft & schreibt")} summary={nyxSummary(data.rules)} testId="notify-row-nyx" />
          </nav>
          <NotificationChannels data={data} save={save} busy={busy} />
          <NotificationHistory save={save} />
          <NotificationAdvanced data={data} save={save} busy={busy} example={example} setExample={setExample} />
        </>
      )}
    </NotifyFrame>
  );
}

/** Subpage "Wie geschrieben?": style + preview (+ "Mit Nyx ausprobieren" when Nyx writes/checks). */
export function NotificationStylePanel() {
  const [example, setExample] = useState<PushEventKind>("session_waiting");
  return <NotifyFrame testId="notification-style">{({ data, save, busy }) => <StyleSection bare data={data} save={save} busy={busy} example={example} setExample={setExample} />}</NotifyFrame>;
}

/** Subpage "Nyx prüft & schreibt". */
export function NotificationNyxPanel() {
  return <NotifyFrame testId="notification-nyx">{({ data, save, busy }) => <NyxSection bare rules={data.rules} nyxReady={data.nyxReady} save={save} busy={busy} />}</NotifyFrame>;
}
