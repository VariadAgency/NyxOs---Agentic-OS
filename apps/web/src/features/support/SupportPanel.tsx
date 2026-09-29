// Einstellungen → Feedback & Unterstützen (`/settings/unterstuetzen`): the three ways as rows, each opens the sheet on
// its tab (SupportSheet, `?support=…`). Below, honestly, how many reports still wait in the outbox.
import { t } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../../lib/cn";
import { fetchSupportState, SUPPORT_STATE_KEY } from "./api";
import { openSupport, type SupportTab } from "./openSupport";
import { HeartIcon } from "./parts";

const WAYS: { tab: SupportTab; icon: string; tone: string; title: string; text: string }[] = [
  { tab: "bug", icon: "⚑", tone: "text-a-bad", title: t("Fehler melden"), text: t("Was ist passiert? Auf Wunsch mit Diagnose – ohne persönliche Daten.") },
  { tab: "idea", icon: "✦", tone: "text-a-wait", title: t("Idee an den Entwickler"), text: t("Ein Wunsch oder Vorschlag für NyxOS.") },
  { tab: "tokens", icon: "", tone: "text-a-conf", title: t("Buy me Tokens"), text: t("Das Projekt mit einem kleinen Betrag unterstützen – direkt hier in NyxOS.") },
];

export function SupportPanel() {
  const state = useQuery({ queryKey: SUPPORT_STATE_KEY, queryFn: fetchSupportState, staleTime: 60_000, retry: false });
  const waiting = state.data?.outbox.waiting ?? 0;
  return (
    <div className="grid min-w-0 gap-3">
      <ul className="min-w-0 overflow-hidden rounded-xl border border-a-line bg-a-p">
        {WAYS.map((w) => (
          <li key={w.tab} className="border-b border-a-line last:border-b-0">
            <button
              type="button"
              data-nyx={`support-open:${w.tab}`}
              onClick={() => openSupport(w.tab)}
              className="group grid min-h-14 w-full min-w-0 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-a-p2 focus-visible:bg-a-p2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-a-acc"
            >
              <span aria-hidden className={cn("grid place-items-center text-title2 leading-none", w.tone)}>
                {w.tab === "tokens" ? <HeartIcon className="h-4 w-4" /> : w.icon}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate text-headline font-medium text-a-ink">{w.title}</span>
                <span className="text-caption text-a-mut">{w.text}</span>
              </span>
              <span aria-hidden className="text-headline text-a-mut transition-transform duration-150 group-hover:translate-x-0.5">
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>
      {waiting > 0 && (
        <p className="text-caption text-a-wait" role="status">
          {waiting === 1 ? t("1 Meldung wartet im Postausgang – sie geht von selbst raus.") : t("{n} Meldungen warten im Postausgang – sie gehen von selbst raus.", { n: waiting })}
        </p>
      )}
    </div>
  );
}
