// Woher kommen Aufgaben und Audits — und was fehlt gerade? Eine Stand-Zeile oben in beiden Reitern und
// der Leer-Zustand mit einem einfachen Satz plus Knopf „Jetzt importieren“.
// Keine Technik-Meldungen: der Server liefert fertige Sätze (`message`).
import type { EntryImportSourceStatus, EntryImportStatus } from "@nyxos/shared";
import { t } from "@nyxos/shared";
import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useImportStatus, useRunImport } from "./hooks";

export type ImportView = "aufgaben" | "audits";

function sourceSentence(view: ImportView): string {
  return view === "audits" ? t("Audits kommen aus dem Maßnahmenplan im Projektordner.") : t("Aufgaben kommen aus den GOAL.md-Dateien im Projektordner.");
}

function emptyTitle(view: ImportView): string {
  return view === "audits" ? t("Noch keine Audit-Befunde.") : t("Noch keine Aufgaben.");
}

function sourceOf(status: EntryImportStatus | undefined): EntryImportSourceStatus | undefined {
  return status?.dateien ?? undefined;
}

/** Zweiter Satz: was fehlt gerade (oder warum ist es leer)? */
export function missingSentence(view: ImportView, s: EntryImportSourceStatus | undefined, now = Date.now()): string {
  if (!s) return t("Der Stand des Imports ließ sich gerade nicht laden.");
  const ago = relativeTime(s.lastDeliveryAt ?? s.lastOkAt, now) ?? t("zuletzt");
  if (s.state === "wartet") return view === "audits" ? t("Die Brücke hat ihn noch nicht geschickt.") : t("Die Brücke hat sie noch nicht geschickt.");
  if (s.state === "leer") return view === "audits" ? t("Die Brücke hat {ago} geliefert, aber keinen Maßnahmenplan gefunden.", { ago }) : t("Die Brücke hat {ago} geliefert, aber keine GOAL.md gefunden.", { ago });
  if (s.state === "fehler") return s.message ?? t("Der letzte Import ist schiefgegangen.");
  return view === "audits" ? t("Im Maßnahmenplan (geliefert {ago}) steht gerade kein Befund.", { ago }) : t("In den GOAL.md-Dateien (geliefert {ago}) steht gerade nichts für diese Ansicht.", { ago });
}

const DOT: Record<EntryImportSourceStatus["state"], string> = {
  ok: "bg-a-ok",
  leer: "bg-a-wait",
  wartet: "bg-a-wait",
  kein_zugang: "bg-a-bad",
  aus: "bg-a-violet",
  fehler: "bg-a-bad",
};

function runErrorText(err: unknown): string {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return t("Bitte zuerst anmelden, dann erneut importieren.");
  return t("Der Import hat gerade nicht geklappt. Bitte gleich noch einmal versuchen.");
}

export function ImportButton({ className }: { className?: string }) {
  const run = useRunImport();
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2", className)}>
      <button
        type="button"
        onClick={() => run.mutate()}
        disabled={run.isPending}
        className="rounded border border-a-acc/40 bg-a-acc/10 px-2.5 py-1 text-caption text-a-acc hover:bg-a-acc/20 disabled:opacity-60 pointer-coarse:min-h-11"
      >
        {run.isPending ? t("Importiert …") : t("Jetzt importieren")}
      </button>
      {run.isError && <span className="text-caption text-a-bad">{runErrorText(run.error)}</span>}
    </span>
  );
}

/** Stand-Zeile oben: Quelle, wann zuletzt, wie viele — plus Knopf. */
export function ImportStatusLine({ view }: { view: ImportView }) {
  const { data } = useImportStatus();
  const s = sourceOf(data);
  const ago = relativeTime(s?.lastDeliveryAt ?? null);
  const count = view === "aufgaben" ? s?.counts?.aufgaben : s?.counts?.audits;
  const label = view === "audits" ? t("Maßnahmenplan") : t("GOAL.md-Dateien");
  let text: string;
  if (!s) text = t("Stand wird geladen …");
  else if (s.state === "ok" || s.state === "leer") {
    const when = ago ?? "–";
    if (count === undefined) text = t("zuletzt von der Brücke geliefert {when}", { when });
    else if (view === "audits") text = t("zuletzt von der Brücke geliefert {when} · {n} Befunde", { when, n: count });
    else text = t("zuletzt von der Brücke geliefert {when} · {n} Aufträge", { when, n: count });
    if (s.message) text += ` · ${s.message}`;
  } else text = s.message ?? missingSentence(view, s);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-caption text-a-mut" data-testid="import-status">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={cn("size-2 rounded-full", s ? (DOT[s.state] ?? "bg-a-wait") : "bg-a-wait")} />
        <b className="font-medium text-a-ink">{label}</b>
      </span>
      <span>{text}</span>
      <ImportButton />
    </div>
  );
}

/** Leer-Zustand ohne Suche/Filter: EIN Satz, woher die Daten kommen, einer, was fehlt, plus Knopf. */
export function EntriesEmptyState({ view }: { view: ImportView }) {
  const { data, isLoading } = useImportStatus();
  const s = sourceOf(data);
  return (
    <div data-testid="entries-empty" className="cc-card-deep border border-a-line p-6 text-center">
      <b className="text-a-ink">{emptyTitle(view)}</b>
      <p className="mt-1 text-caption text-a-mut">
        {sourceSentence(view)} {isLoading ? t("Stand wird geladen …") : missingSentence(view, s)}
      </p>
      <ImportButton className="mt-3 justify-center" />
    </div>
  );
}
