// Settings overview. Like the iOS settings: search at the top, below ONE column of grouped rows (symbol, title, one
// line of summary/state, arrow). The same page for „Allgemein“ (`/settings`) and „Nyx“ (`/einstellungen/nyx`, with
// the preview „So spricht Nyx“ on top). Old anchors (`/settings#push`) redirect here. Areas that do not exist in the
// current run mode are left out (`sectionsForMode`).
import "./settings.css";
import { t } from "@nyxos/shared";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigationType } from "react-router";
import { PageShell } from "../../components/PageShell";
import { useAppMode } from "../../hooks/useAppInfo";
import { cn } from "../../lib/cn";
import { toneVar } from "../../lib/tones";
import { resolveLegacySettingsPath } from "./legacy";
import { NyxPreviewSummary } from "./nyx/NyxProfilePanels";
import { rememberScroll, restoreScroll, scrollToTop } from "./scroll";
import { ALL_SECTIONS, GENERAL_GROUPS, GENERAL_SECTIONS, NYX_GROUPS, NYX_SECTIONS, sectionsForMode } from "./sections";
import { SettingsSearch } from "./SettingsSearch";
import { SettingsTabs } from "./SettingsTabs";
import type { SectionStatus, SettingsSection } from "./types";

export type SettingsScope = "general" | "nyx";

const STATUS_TONE: Record<NonNullable<SectionStatus["tone"]>, string> = { ok: "bg-a-ok", wait: "bg-a-wait", bad: "bg-a-bad", mut: "bg-a-idle" };

const noStatus = (): SectionStatus | null => null;

function Row({ section }: { section: SettingsSection }) {
  // Every row has its fixed state hook (or none) – the order of hooks never changes.
  const useStatus = section.useStatus ?? noStatus;
  const status = useStatus();
  return (
    <li className="border-b border-a-line last:border-b-0">
      <Link
        to={section.href ?? section.path}
        state={{ fromOverview: true }}
        data-nyx={`settings:${section.id}`}
        aria-label={`${section.title} – ${status?.text ?? section.summary}`}
        className="group grid min-h-14 min-w-0 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-a-p2 focus-visible:bg-a-p2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-a-acc"
      >
        <span aria-hidden className="text-center text-title2 leading-none" style={{ color: toneVar(section.tone) }}>
          {section.icon}
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-headline font-medium text-a-ink">{section.title}</span>
          {/* Phone: state instead of summary (room for one line only); wider: summary, state on the right. */}
          <span className={cn("truncate text-caption text-a-mut", status && "hidden sm:block")}>{section.summary}</span>
          {status && (
            <span className="flex min-w-0 items-center gap-1.5 text-caption text-a-mut sm:hidden">
              <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_TONE[status.tone ?? "mut"])} />
              <span className="truncate">{status.text}</span>
            </span>
          )}
        </span>
        <span className="flex items-center gap-3">
          {status && (
            <span className="hidden max-w-[16rem] items-center gap-1.5 truncate text-caption text-a-mut sm:flex">
              <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_TONE[status.tone ?? "mut"])} />
              <span className="truncate">{status.text}</span>
            </span>
          )}
          <span aria-hidden className="text-headline text-a-mut transition-transform duration-150 group-hover:translate-x-0.5">
            ›
          </span>
        </span>
      </Link>
    </li>
  );
}

export function SettingsOverview({ scope }: { scope: SettingsScope }) {
  const location = useLocation();
  const navType = useNavigationType();
  const [query, setQuery] = useState("");
  const legacy = resolveLegacySettingsPath(location.pathname, location.hash, ALL_SECTIONS);
  const groups = scope === "nyx" ? NYX_GROUPS : GENERAL_GROUPS;
  const mode = useAppMode();
  const sections = useMemo(() => sectionsForMode(scope === "nyx" ? NYX_SECTIONS : GENERAL_SECTIONS, mode), [scope, mode]);
  const scrollKey = `settings:${scope}`;

  // Back (browser or „‹ Einstellungen“) lands at the same spot of the list; opened anew it starts at the top.
  useLayoutEffect(() => {
    if (navType === "POP") restoreScroll(scrollKey);
    else scrollToTop();
    return () => rememberScroll(scrollKey);
  }, [navType, scrollKey]);

  useEffect(() => setQuery(""), [scope]);

  if (legacy) return <Navigate to={legacy} replace />;

  return (
    <PageShell gap="gap-5">
      <SettingsTabs />
      <header className="grid gap-1">
        <h1 className="font-display text-title font-semibold text-a-ink">{scope === "nyx" ? "Nyx" : t("Einstellungen")}</h1>
        {scope === "nyx" && <p className="text-callout text-a-mut">{t("So kennt dich Nyx – und so antwortet Nyx dir.")}</p>}
      </header>

      {scope === "nyx" && !query && <NyxPreviewSummary />}

      <SettingsSearch value={query} onChange={setQuery} />

      {!query.trim() &&
        groups.map((g) => {
          const rows = sections.filter((s) => s.group === g.id && !s.parent);
          if (rows.length === 0) return null;
          return (
            <section key={g.id} aria-labelledby={`settings-group-${g.id}`} className="grid min-w-0 gap-2">
              <h2 id={`settings-group-${g.id}`} className="px-1 font-mono text-label uppercase tracking-wider text-a-mut">
                {g.title}
              </h2>
              <ul className="min-w-0 overflow-hidden rounded-xl border border-a-line bg-a-p">
                {rows.map((s) => (
                  <Row key={s.id} section={s} />
                ))}
              </ul>
            </section>
          );
        })}
    </PageShell>
  );
}
