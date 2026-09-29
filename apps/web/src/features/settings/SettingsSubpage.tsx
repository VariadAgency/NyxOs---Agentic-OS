// Subpage of a settings area (`/settings/<id>`, `/einstellungen/nyx/<id>`). Header like on the iPhone:
// „‹ Einstellungen“ (back – coming from the overview it really is „back“, otherwise to the overview; a subpage with
// `parent` goes back to that area instead), title, one
// sentence of explanation. Below the blocks of the area; rare ones sit together behind „Erweitert“. An anchor
// (`#push`) scrolls to the block and opens „Erweitert“ when it is in there. An area that does not exist in the current
// run mode (e.g. idea links in local mode) leads back to the overview.
import "./settings.css";
import { t } from "@nyxos/shared";
import { useLayoutEffect, useMemo } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { PageShell } from "../../components/PageShell";
import { useAppMode } from "../../hooks/useAppInfo";
import { toneVar } from "../../lib/tones";
import { Advanced } from "./Advanced";
import { NyxSaveBar } from "./nyx/NyxProfilePanels";
import { useNyxProfile } from "./nyx/NyxProfileContext";
import { scrollToAnchor, scrollToTop } from "./scroll";
import { findSection, GENERAL_SECTIONS, NYX_SECTIONS, NYX_SETTINGS_PATH, SETTINGS_PATH, sectionsForMode } from "./sections";
import type { SettingsScope } from "./SettingsOverview";
import type { SettingsPanelDef } from "./types";

/** Nyx subpages that edit the profile – the save bar always stands there. */
const NYX_PROFILE_PAGES = new Set(["persoenlichkeit", "ueber-dich"]);

function Panel({ panel }: { panel: SettingsPanelDef }) {
  const { Component } = panel;
  return (
    <div id={panel.id} className="min-w-0 scroll-mt-4" data-settings-panel={panel.id}>
      <Component />
    </div>
  );
}

function NyxBar({ sectionId }: { sectionId: string }) {
  const { dirty } = useNyxProfile();
  return NYX_PROFILE_PAGES.has(sectionId) || dirty ? <NyxSaveBar /> : null;
}

export function SettingsSubpage({ scope }: { scope: SettingsScope }) {
  const { sectionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const overview = scope === "nyx" ? NYX_SETTINGS_PATH : SETTINGS_PATH;
  const mode = useAppMode();
  const all = useMemo(() => sectionsForMode(scope === "nyx" ? NYX_SECTIONS : GENERAL_SECTIONS, mode), [scope, mode]);
  const section = findSection(all, sectionId);
  const anchor = location.hash.replace(/^#/, "");
  const parent = section?.parent ? findSection(all, section.parent) : undefined;
  // Old anchor on a subpage that is its own page today (`/settings/betrieb#verbindungen` → `/settings/verbindungen`).
  const movedTo =
    anchor && section ? all.find((s) => s.parent === section.id && (s.id === anchor || s.parentAnchors?.includes(anchor) || s.panels.some((p) => p.id === anchor))) : undefined;

  useLayoutEffect(() => {
    if (!anchor) {
      scrollToTop();
      return;
    }
    // `zugaenge-einrichten` belongs to the block `zugaenge` (the panel then opens the wizard itself).
    const target = section?.panels.find((p) => anchor === p.id || anchor.startsWith(`${p.id}-`))?.id ?? anchor;
    return scrollToAnchor(target);
  }, [anchor, section]);

  if (!section) return <Navigate to={overview} replace />;
  if (movedTo) return <Navigate to={movedTo.path} replace />;

  const state = location.state as { fromOverview?: boolean; fromParent?: boolean } | null;
  // Coming from the list (or from the parent area), „‹“ is a real back – otherwise it goes one level up.
  const cameFromUp = parent ? state?.fromParent === true : state?.fromOverview === true;
  const up = parent?.path ?? overview;
  const back = () => {
    if (cameFromUp) void navigate(-1);
    else void navigate(up);
  };
  const normal = section.panels.filter((p) => !p.advanced);
  const advanced = section.panels.filter((p) => p.advanced);
  const advancedTargeted = advanced.some((p) => anchor === p.id || anchor.startsWith(`${p.id}-`));
  const backLabel = parent?.title ?? (scope === "nyx" ? "Nyx" : t("Einstellungen"));

  return (
    <PageShell gap="gap-5" className={scope === "nyx" && NYX_PROFILE_PAGES.has(section.id) ? "pb-0" : undefined}>
      <header className="grid min-w-0 gap-2">
        <button
          type="button"
          onClick={back}
          data-nyx="settings-back"
          aria-label={t("Zurück zu {page}", { page: backLabel })}
          className="-ml-2 flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-callout text-a-acc hover:bg-a-p2 focus-visible:outline-2 focus-visible:outline-a-acc"
        >
          <span aria-hidden className="text-title2 leading-none">
            ‹
          </span>
          {backLabel}
        </button>
        <h1 className="flex min-w-0 items-center gap-2.5 font-display text-title font-semibold text-a-ink">
          <span aria-hidden className="text-title2 leading-none" style={{ color: toneVar(section.tone) }}>
            {section.icon}
          </span>
          <span className="min-w-0 break-words">{section.title}</span>
        </h1>
        {section.lead && <p className="max-w-[70ch] text-callout text-a-mut">{section.lead}</p>}
      </header>

      {normal.map((p) => (
        <Panel key={p.id} panel={p} />
      ))}
      {advanced.length > 0 && (
        <Advanced id={`bereich-${section.id}`} hint={advanced.map((p) => p.title).join(", ")} open={advancedTargeted}>
          {advanced.map((p) => (
            <Panel key={p.id} panel={p} />
          ))}
        </Advanced>
      )}
      {scope === "nyx" && <NyxBar sectionId={section.id} />}
    </PageShell>
  );
}
