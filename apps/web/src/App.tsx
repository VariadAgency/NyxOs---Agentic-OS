import { lazy, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { t } from "@nyxos/shared";
import { CommandPalette, toggleFullscreen } from "./components/CommandPalette";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { LazyView } from "./components/LazyView";
import { isModalOpen, isTypingTarget } from "./lib/keyboard";
import { installAudioUnlock } from "./features/nyx/voice/unlock";
import { BriefingPage } from "./features/haiku/Briefing";
import { HaikuRoot } from "./features/haiku/HaikuRoot";
import { HaikuSettingsPanel } from "./features/haiku/HaikuSettingsPanel";
import { IdeaLinksPanel } from "./features/idealink/IdeaLinksPanel";
import { InboxView } from "./features/inbox/InboxView";
import { EntryOverlay } from "./features/entries/EntryOverlay";
import { IdeasView } from "./features/ideas/IdeasView";
import { IdeaDetailView } from "./features/ideas/IdeaDetailView";
import { TasksView } from "./features/tasks/TasksView";
import { Conflicts } from "./features/conflicts/Conflicts";
import { Git } from "./features/git/Git";
import { Overview } from "./features/overview/Overview";
import { Server } from "./features/server/Server";
import { Settings } from "./features/settings/Settings";
import { NyxSettingsPage } from "./features/settings/nyx/NyxSettingsPage";
import { InfoPage } from "./features/settings/info/InfoPage";
import { OnboardingWizard } from "./features/onboarding/OnboardingWizard";
import { useOnboardingGate } from "./features/onboarding/useOnboardingGate";
import { useLiveSocket } from "./hooks/useLiveSocket";
import { usePageTitle } from "./hooks/usePageTitle";
import { usePresenceHeartbeat } from "./hooks/usePresenceHeartbeat";
import { AgentsView } from "./features/agents/AgentsView";
import { SkillDetailView } from "./features/skills/SkillDetailView";
import { SkillsView } from "./features/skills/SkillsView";
import { UsageView } from "./features/usage/UsageView";
import { NyxTab } from "./features/nyx/tab/NyxTab";
import { SessionsView } from "./routes/SessionsView";
import { LoginDialog } from "./features/terminal/LoginDialog";
import { NewSessionDialog } from "./features/terminal/NewSessionDialog";
import { DemoShell } from "./features/demo/DemoShell";
// Brain as its own bundle (load force-graph/d3 only when the tab is open).
const BrainView = lazy(() => import("./features/brain/BrainView").then((m) => ({ default: m.BrainView })));
// The finder too – the first NyxOS load stays smaller.
const FinderView = lazy(() => import("./features/finder/FinderView").then((m) => ({ default: m.FinderView })));


/**
 * Short cross-fade beim Tab-Wechsel (150 ms). Der `key` ist
 * bewusst nur das ERSTE Pfadsegment ("sessions", "git", …) statt der vollen `pathname` — ein
 * Wechsel INNERHALB eines Tabs (Session öffnen, Art/Baustelle wählen, `?e=`/`?run=` setzen) bleibt
 * derselbe Key und remounted damit nicht, nur der Wechsel AUF einen anderen Tab blendet über.
 */
function TabFade({ children }: { children: ReactNode }) {
  const location = useLocation();
  const tabKey = location.pathname.split("/")[1] || "overview";
  return (
    // h-full: Ansichten mit eigener Vollhöhe (Gehirn: `h-full`) brauchen eine feste Höhe vom Elternteil,
    // sonst fällt der Graph auf min-h 480 px zurück (e2e/brain.spec.ts „füllt“).
    <div key={tabKey} className="h-full motion-safe:animate-[cc-tab-fade_150ms_ease-out]">
      {children}
    </div>
  );
}

/**
 * Seiten im Fokus-Modus (ohne Kopfzeile): die Seitenleiste bleibt sichtbar; nur Kopfzeile (mit Nyx-Leiste) und „Haiku fragen“ fallen weg, weil
 * der Nyx-Tab Nyx selbst groß zeigt. Den Menü-Knopf (☰) für schmale Bildschirme bringt der Tab selbst mit.
 */
export function isFocusRoute(pathname: string): boolean {
  return /^\/nyx(\/|$)/.test(pathname);
}

export function App() {
  useLiveSocket();
  usePageTitle();
  usePresenceHeartbeat(); // presence: "the user is here"
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Safari: Ton und Mikro-Pegel bei der ersten Geste freischalten – Nyx spricht später von selbst.
  useEffect(() => installAudioUnlock(), []);
  const { pathname } = useLocation();
  const focus = isFocusRoute(pathname);
  // Onboarding: full screen while `onboardingDone === false`, or on `/onboarding` (restart from Info & Hilfe).
  const onboarding = useOnboardingGate(pathname);

  // Taste F = Vollbild ein/aus (der Knopf in der Kopfleiste ist weg; in ⌘K steht „Vollbild“ mit F).
  // Nicht beim Tippen (Feld, Terminal, Komposition), mit keiner Zusatztaste (⌘F bleibt die Browser-Suche, ⌥ gehört
  // dem Nyx-Halten), nicht wenn ein sichtbarer Dialog offen ist, nicht im Nyx-Tab.
  useEffect(() => {
    if (focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || isModalOpen()) return;
      e.preventDefault();
      toggleFullscreen();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focus]);

  if (onboarding) {
    return (
      <>
        <OnboardingWizard again={onboarding === "again"} />
        <LoginDialog />
      </>
    );
  }

  return (
    // Unten so viel frei wie die Demo-Leiste hoch ist (außerhalb der Demo 0).
    <div className="flex h-dvh min-h-0 bg-a-bg pb-(--a-demo-bar-h) text-a-ink" data-focus={focus ? "true" : undefined}>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {!focus && <TopBar />}
        <main className="cc-scroll min-h-0 flex-1 overflow-y-auto">
          <TabFade>
            <Routes>
              {/* Überblick ist die Startseite. */}
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<Overview />} />
              <Route path="/nyx" element={<NyxTab />} />
              <Route path="/git" element={<Git />} />
              <Route path="/conflicts" element={<Conflicts />} />
              <Route path="/server" element={<Server />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/sessions" element={<SessionsView />} />
              <Route path="/sessions/:art" element={<SessionsView />} />
              <Route path="/sessions/:art/:baustelle" element={<SessionsView />} />
              <Route path="/sessions/:art/:baustelle/:id" element={<SessionsView />} />
              <Route path="/briefing" element={<BriefingPage />} />
              <Route path="/inbox" element={<InboxView />} />
              <Route path="/einstellungen/ideen-links" element={<IdeaLinksPanel />} />
              <Route path="/einstellungen/haiku" element={<HaikuSettingsPanel />} />
              <Route path="/einstellungen/nyx" element={<NyxSettingsPage />} />
              <Route path="/einstellungen/info" element={<InfoPage />} />
              <Route path="/tasks" element={<TasksView />} />
              <Route path="/ideas" element={<IdeasView />} />
              <Route path="/ideas/:id" element={<IdeaDetailView />} />
              <Route path="/audits" element={<TasksView fixedKind="audit" title={t("Audits")} hint={t("Alle Audit-Befunde als eigene Ansicht der Aufgaben.")} />} />
              {/* Dateien wie der Finder; die Liste „von Sessions angefasst“ steckt dort unter „Intelligent“. */}
              <Route path="/files" element={<LazyView><FinderView /></LazyView>} />
              <Route path="/agents" element={<AgentsView />} />
              <Route path="/skills" element={<SkillsView />} />
              <Route path="/skills/:key" element={<SkillDetailView />} />
              <Route path="/usage" element={<UsageView />} />
              <Route path="/gehirn" element={<LazyView><BrainView /></LazyView>} />
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Routes>
          </TabFade>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {/* Im Fokus-Modus ist Nyx der Assistent — kein zweiter „Haiku fragen“-Knopf über der Leiste. */}
      {!focus && <HaikuRoot />}
      <NewSessionDialog />
      <LoginDialog />
      <EntryOverlay />
      <DemoShell />
    </div>
  );
}
