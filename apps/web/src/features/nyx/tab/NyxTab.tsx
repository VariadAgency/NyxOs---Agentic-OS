// Nyx-Tab (Fokus-Modus): ganzer Bildschirm ohne Kopfzeile.
// Mitte: Nyx' Netz in echtem 3D vor einem tiefen Raum (Sterne, Nebel, Vignette). Unten der Sprech-/Schreib-
// Bereich: nur der runde Mikro-Knopf (Leertaste halten; kein Kasten, kein Dauer-Zuhören-Schalter, kein Hinweis-
// Text – der steht im Tooltip), Live-Untertitel, ein Schreibfeld. Rechts eine dezente Glas-Leiste mit Reitern (Chat, Aufgaben live, Dateien &
// Links, Bilder, Gedächtnis, Kontext, Einstellungen), einklappbar. Oben steht immer, was Nyx gerade tut.
// Die Sprach-Logik (Schleife, Erkennung, Unterbrechen) kommt unverändert aus `useNyxVoiceLoop`.
// EIN Weck-Knopf (unten, mittig),
// dasselbe Zustandswort wie Nyx-Zentrum und Leiste (`../stateWord.ts`), und der Chat setzt den zuletzt benutzten
// Faden fort (gemeinsames Gedächtnis mit dem Zentrum, `useNyxConversation`).
// Die App-Seitenleiste bleibt sichtbar (App.tsx) — darum kein eigener „Zurück“-Knopf mehr
// und Esc verlässt den Tab nie (Esc direkt nach Nyx' letzter Silbe warf einen sonst hinaus). Unter 768 px bringt der
// Tab den Menü-Knopf (☰) der Kopfzeile selbst mit, weil die Kopfzeile hier fehlt.
import { nyxToolDoing, nyxToolStatus, t, type GraphResponse, type NyxFile, type NyxState } from "@nyxos/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { NyxAura } from "../../../components/brand/NyxAura";
import { SIDEBAR_ID } from "../../../components/Sidebar";
import { cn } from "../../../lib/cn";
import { toggleNavDrawer, useNavDrawerOpen } from "../../../lib/navDrawer";
import { useHaikuStatus } from "../../haiku/EngineStatus";
import { ToastView, useToast } from "../../haiku/ui";
import { nyxStateWord } from "../stateWord";
import { NyxNet3D } from "./net3d/NyxNet3D";
import { buildNetModel } from "./netModel";
import { fetchTools } from "./nyxTabApi";
import "./nyxTab.css";
import { ChatPanel, type PendingGift } from "./panels/ChatPanel";
import { ContextPanel } from "./panels/ContextPanel";
import { GivePanel } from "./panels/GivePanel";
import { ImagesPanel, ImageViewer } from "./panels/ImagesPanel";
import { MemoryPanel } from "./panels/MemoryPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { TasksPanel } from "./panels/TasksPanel";
import { useNyxSettings } from "./settings";
import { useNyxConversation } from "./useNyxConversation";
import { useNyxLive } from "./useNyxLive";
import { useNyxVoiceLoop } from "./useNyxVoiceLoop";
import { createLevelDrive, type LevelDrive } from "./voice/level";
import { reportNyxLevel } from "../voice/levelBus";
import { useNyxVisualSequence } from "../visualSequence";

type IconName = "chat" | "tasks" | "give" | "images" | "memory" | "context" | "settings";

export const NYX_TABS = [
  { id: "chat", label: t("Chat"), icon: "chat" },
  { id: "aufgaben", label: t("Aufgaben live"), icon: "tasks" },
  { id: "geben", label: t("Dateien & Links"), icon: "give" },
  { id: "bilder", label: t("Bilder"), icon: "images" },
  { id: "gedaechtnis", label: t("Gedächtnis"), icon: "memory" },
  { id: "kontext", label: t("Kontext"), icon: "context" },
  { id: "einstellungen", label: t("Einstellungen"), icon: "settings" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];
type TabId = (typeof NYX_TABS)[number]["id"];

/** Breite der Leiste (offen) und der Reiter-Spalte (eingeklappt), CSS-px — das Netz rückt in die freie Mitte. */
export const PANEL_WIDTH = 440;
export const RAIL_WIDTH = 64;
const PANEL_KEY = "nyx.tab.panel";
/**
 * Ab hier (schmal, z. B. iPhone 390 px) liegt die Leiste ÜBER dem Netz statt daneben (gleiche Grenze wie nyxTab.css).
 * 1100 px Fenster, weil die Seitenleiste (208 px) jetzt mit im Bild steht — die Bühne ist dann ≈ 900 px breit.
 */
const NARROW_QUERY = "(max-width: 1100px)";

function subscribeNarrow(cb: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function isNarrow(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

async function fetchGraph(): Promise<GraphResponse | null> {
  const res = await fetch("/api/graph", { headers: { accept: "application/json" } });
  return res.ok ? ((await res.json()) as GraphResponse) : null;
}

/**
 * Tippst du gerade (Textfeld, Auswahl)? Knöpfe zählen bewusst NICHT dazu: Im Nyx-Tab heißt Leertaste immer
 * „sprechen“ — sonst drückte die Leertaste nach einem Klick auf „Nyx wecken“ gleich „Mikro aus“.
 */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * Steht der Fokus in der Leiste rechts (Reiter, Knöpfe im Chat, in den Einstellungen …)? Dort behält die
 * Leertaste ihre normale Bedeutung (Knopf drücken) — sonst wäre die Leiste per Tastatur nicht bedienbar.
 */
function isPanelTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && el.closest(".nyx-panel") !== null;
}

/** Liegt gerade ein Dialog über allem (Befehlspalette, Anmeldung …)? Dann gehört Esc ihm, nicht Nyx. */
function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"], [role="dialog"][data-state="open"]') !== null;
}

/**
 * Gemerkter Wunsch für BREITE Fenster (Standard: offen). Schmal liegt die Leiste über dem ganzen
 * Netz – dort startet sie immer zu, klappt beim Schmal-Werden von selbst zu, und Auf-/Zuklappen im Schmalen
 * ändert diesen Wunsch nicht. Wird das Fenster wieder breit, gilt er wieder.
 */
function readPanelWish(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

function initialPanelOpen(): boolean {
  return !isNarrow() && readPanelWish();
}

/** Was Nyx gerade tut — ein kurzer, klarer Satz für die Statuszeile. */
export function statusLine(opts: { state: NyxState; tool: string | null; awake: boolean; waking: boolean; continuous: boolean; detail?: string | null }): string {
  const { state, tool, awake, waking, continuous, detail } = opts;
  if (state === "listening") return t("Ich höre dir zu …");
  if (state === "thinking") return t("Ich denke nach …");
  // Einfache Wörter statt der Werkzeug-ID („Schaut in Git …“, nie „git_lage“).
  if (state === "tool") return detail ? `${detail}` : tool ? `${nyxToolStatus(tool)} …` : t("Ich arbeite …");
  if (state === "speaking") return t("Ich spreche – sprich einfach rein, dann höre ich auf.");
  if (waking) return t("Ich wache auf …");
  // Mikro zu heißt nicht „Nyx schläft“: Nyx ist bereit (Zustandswort oben), nur das Zuhören ist aus.
  if (!awake) return t("Bereit. Tippe unten auf den Knopf, dann höre ich zu – oder schreib mir.");
  // Ruhig und kurz – wie man spricht, steht im Tooltip am Knopf.
  return continuous ? t("Ich höre dauerhaft zu – sprich einfach.") : t("Bereit.");
}

export function NyxTab() {
  const [settings, setSettings] = useNyxSettings();
  const conversation = useNyxConversation();
  const drive = useMemo(() => createLevelDrive(), []);
  const loop = useNyxVoiceLoop(conversation, settings, drive);
  const live = useNyxLive();
  const engine = useHaikuStatus().data?.engine.state;
  const navigate = useNavigate();
  const navOpen = useNavDrawerOpen();
  const [params, setParams] = useSearchParams();
  const tab: TabId = (NYX_TABS.find((x) => x.id === params.get("r"))?.id ?? "chat") as TabId;
  const [panelOpen, setPanelOpenState] = useState(initialPanelOpen);
  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenState(open);
    // Nur im Breiten merken: schmal ist Auf-/Zuklappen ein Blick in den Chat, kein neuer Wunsch.
    if (isNarrow()) return;
    try {
      localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
    } catch {
      /* privater Modus: nur für diese Sitzung */
    }
  }, []);
  const setTab = useCallback(
    (id: TabId) => {
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.set("r", id);
          return n;
        },
        { replace: true },
      );
      setPanelOpen(true);
    },
    [setParams, setPanelOpen],
  );
  const [gifts, setGifts] = useState<PendingGift[]>([]);
  const [viewer, setViewer] = useState<{ files: NyxFile[]; index: number } | null>(null);
  const toast = useToast(6000);
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  // Fenster über die Schmal-Grenze gezogen: schmal → Leiste zu (Netz frei), breit → wieder der gemerkte Wunsch.
  const [lastNarrow, setLastNarrow] = useState(narrow);
  if (narrow !== lastNarrow) {
    setLastNarrow(narrow);
    setPanelOpenState(narrow ? false : readPanelWish());
  }

  // Kommt das Gehirn nicht (Server beschäftigt), leben die Neuronen weiter; nach 30 s noch einmal versuchen.
  const graph = useQuery({ queryKey: ["nyx", "graph"], queryFn: fetchGraph, staleTime: 5 * 60_000, retry: 1, refetchInterval: (q) => (q.state.data ? false : 30_000) });
  const tools = useQuery({ queryKey: ["nyx", "tools"], queryFn: fetchTools, staleTime: 60_000 });
  const model = useMemo(() => buildNetModel(graph.data ?? null, (tools.data ?? []).map((x) => x.name)), [graph.data, tools.data]);

  // Zustand fürs Netz: die eigene Gesprächsschleife zuerst, sonst eine getippte Frage, sonst was der Server meldet
  // (z. B. Nyx arbeitet gerade für Telegram).
  // Meldungen zur EIGENEN, schon beantworteten Frage kommen verspätet – die eigene Schleife weiß es besser
  // (sonst: grün → eine Runde orange → grün). Andere Fäden (Telegram, Nyx-Feld) zeigt das Netz weiter.
  const server =
    live.serverState && !(conversation.threadId !== null && live.serverState.threadId === conversation.threadId && !conversation.busy) ? live.serverState : null;
  const serverTool = server?.state === "tool" ? (server.tool ?? null) : null;
  let raw: NyxState = loop.state;
  let rawTool: string | null = loop.tool;
  if (raw === "idle" && conversation.busy) {
    // Getippte Frage – strömt schon Antwort-Text, antwortet Nyx (grün).
    const last = conversation.messages.at(-1);
    raw = conversation.tool ? "tool" : last?.role === "assistant" && last.streaming && last.text ? "speaking" : "thinking";
    rawTool = conversation.tool;
  }
  if ((raw === "thinking" || raw === "idle") && serverTool) {
    raw = "tool";
    rawTool = serverTool;
  } else if (raw === "idle" && server && server.state !== "idle") raw = server.state;
  // Ruhige Farbfolge (Mindestdauern, Such-Runde läuft zu Ende) – Netz, Aura, Chip und Statuszeile zeigen dieselbe.
  const { state, tool } = useNyxVisualSequence(raw, rawTool);
  // Bedienung (Esc stoppt) und Pegel folgen dem echten Zustand, nicht der nachlaufenden Anzeige.
  const busy = raw === "speaking" || raw === "thinking" || raw === "tool";
  // Pegel fürs Nyx-Logo (Wortmarke, Leiste, Kopf) – Mikro, solange Nyx wach ist; Nyx' Stimme beim Sprechen.
  const speaking = raw === "speaking";
  useEffect(() => (loop.awake || speaking ? reportNyxLevel(() => (speaking ? drive.output : drive.input)) : undefined), [drive, loop.awake, speaking]);

  // Neues Bild von Nyx → Hinweis mit Knopf (nicht bei eigenen Uploads).
  const lastFileId = useRef<number | null>(null);
  useEffect(() => {
    const f = live.lastFile;
    if (!f || f.id === lastFileId.current) return;
    lastFileId.current = f.id;
    if (f.kind === "image" && f.source !== "upload") toast.show(t("Neues Bild von Nyx: {name}", { name: f.title ?? f.name }));
  }, [live.lastFile, toast]);

  // „Getippte Antworten vorlesen“: fertige Antwort auf eine getippte Frage einmal sprechen.
  const spokenKey = useRef<string | null>(null);
  useEffect(() => {
    if (!settings.speakTyped) return;
    const last = conversation.messages.at(-1);
    if (!last || last.role !== "assistant" || last.streaming || last.channel !== "web" || !last.text || last.error) return;
    if (spokenKey.current === last.key) return;
    spokenKey.current = last.key;
    // Die Sprechfassung (ohne Markdown/Links), sonst der Text – nie die Gedanken.
    loop.speak(last.speak?.trim() || last.text);
  }, [conversation.messages, loop, settings.speakTyped]);

  // Leertaste halten = sprechen. Esc stoppt Nyx bzw. verlässt das Schreibfeld — sonst nichts (kein Hinauswerfen;
  // ein offenes Menü, Bild oder Dialog schließt Esc selbst).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (viewer || navOpen || e.defaultPrevented || modalOpen()) return;
        if (busy) {
          loop.interrupt();
          return;
        }
        if (isTypingTarget(e.target) && e.target instanceof HTMLElement) e.target.blur();
        return;
      }
      if (e.code !== "Space" || e.repeat || isTypingTarget(e.target) || isPanelTarget(e.target) || viewer || modalOpen()) return;
      e.preventDefault();
      if (!loop.awake) void loop.wake();
      else loop.pttDown();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTypingTarget(e.target) || isPanelTarget(e.target)) return;
      e.preventDefault();
      loop.pttUp();
    };
    // Fenster verlassen (Cmd+Tab, anderer Tab) bei gedrückter Leertaste: das Loslassen kommt nie an → hier loslassen.
    const release = () => loop.pttUp();
    const onVisibility = () => document.visibilityState === "hidden" && loop.pttUp();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [busy, loop, navOpen, viewer]);

  const openImage = useCallback((files: NyxFile[], index: number) => setViewer({ files, index }), []);
  const running = live.tasks.filter((x) => x.status === "running").length;
  const badge: Partial<Record<TabId, ReactNode>> = {
    aufgaben: running > 0 ? running : null,
    geben: gifts.length > 0 ? gifts.length : null,
  };
  const word = nyxStateWord(engine, state);
  const preview = server?.preview;
  const status = statusLine({ state, tool, awake: loop.awake, waking: loop.waking, continuous: settings.continuous, detail: state === "tool" ? (server?.detail ?? null) : null });
  const current = NYX_TABS.find((x) => x.id === tab) ?? NYX_TABS[0];
  // Schmal liegt die offene Leiste über dem Netz — das Netz bleibt dann mittig (nur die Reiter-Spalte zählt).
  const inset = panelOpen && !narrow ? PANEL_WIDTH + RAIL_WIDTH : RAIL_WIDTH;

  return (
    <div className="nyx-stage" data-nyx="nyx-tab" data-focus="true" data-panel={panelOpen ? "open" : "closed"} data-tone={state} style={{ ["--nyx-inset" as string]: `${inset}px` }}>
      <div className="nyx-space" aria-hidden="true">
        <div className="nyx-nebula nyx-nebula--a" />
        <div className="nyx-nebula nyx-nebula--b" />
        <div className="nyx-nebula nyx-nebula--c" />
        <div className="nyx-aura" />
      </div>

      <section className="nyx-net-area" aria-label="Nyx">
        <NyxNet3D model={model} state={state} drive={drive} tool={tool} highlightNode={server?.node ?? null} rightInset={inset} onOpen={(href) => void navigate(href)} />
      </section>
      <div className="nyx-vignette" aria-hidden="true" />

      {/* ── Oben: Menü (nur schmal), wer/was, Mikro ── */}
      <header className="nyx-top">
        <div className="nyx-top__left">
          {/* Unter 768 px ist die Seitenleiste ein Menü; die Kopfzeile mit ihrem ☰ fehlt hier, darum dieser Knopf (nyxTab.css). */}
          <button
            type="button"
            className="nyx-glass nyx-menu"
            onClick={toggleNavDrawer}
            aria-label={t("Menü öffnen")}
            aria-expanded={navOpen}
            aria-controls={SIDEBAR_ID}
            data-nyx="nyx-menue"
          >
            <Icon name="menu" />
          </button>
        </div>
        <div className="nyx-title">
          <div className="nyx-title__brand">
            <NyxAura size={26} state={state} />
            <h1 className="nyx-wordmark">Nyx</h1>
          </div>
          <span role="status" aria-live="polite" className="nyx-chip" data-tone={word.tone} data-nyx="nyx-zustand">
            <span className="nyx-chip__dot" aria-hidden="true" />
            {/* Bei einem Werkzeug sagt der Chip, was Nyx tut („prüft den Server“), nie die ID. */}
            {state === "tool" && tool ? nyxToolDoing(tool) : word.word}
          </span>
        </div>
        <div className="nyx-top__right">
          {/* Geweckt wird nur unten (großer Knopf); oben nur das Gegenstück, solange das Mikro offen ist. */}
          {loop.awake && (
            <button type="button" onClick={loop.sleep} className="nyx-glass nyx-pill-btn" data-nyx="nyx-schlafen">
              <Icon name="micOff" />
              {t("Mikro aus")}
            </button>
          )}
        </div>
      </header>

      <p className="nyx-statusline" data-nyx="nyx-status" data-tone={state}>
        {status}
      </p>

      {preview && (
        <div className="nyx-preview nyx-glass cc-rise" data-nyx="nyx-vorschau">
          {preview.kind === "image" ? (
            <button
              type="button"
              className="block w-full"
              onClick={() =>
                openImage(
                  [
                    {
                      id: preview.fileId ?? 0,
                      kind: "image",
                      source: "show_image",
                      name: preview.title ?? t("Bild"),
                      title: preview.title ?? null,
                      mime: "image/png",
                      size: 0,
                      createdAt: new Date().toISOString(),
                      url: preview.url,
                      downloadUrl: preview.fileId ? `/api/nyx/files/${preview.fileId}?download=1` : preview.url,
                    },
                  ],
                  0,
                )
              }
            >
              <img src={preview.url} alt={preview.title ?? t("Vorschau")} className="aspect-[4/3] w-full object-cover" />
            </button>
          ) : (
            <a href={preview.url} target="_blank" rel="noreferrer noopener" className="block px-3 py-2 text-caption text-a-acc underline">
              {preview.title ?? preview.url}
            </a>
          )}
          {preview.title && preview.kind === "image" && <div className="truncate px-3 py-1.5 text-caption text-a-ink">{preview.title}</div>}
        </div>
      )}

      {/* ── Unten: Untertitel + Sprechen/Schreiben ── */}
      <div className="nyx-dock-wrap">
        <div className="nyx-captions" aria-live="polite" data-nyx="nyx-untertitel">
          {loop.userCaption && (
            <p key={`u-${loop.userCaption}`} className="nyx-caption nyx-caption--user">
              <span className="nyx-caption__who">{t("Du")}</span>
              {loop.userCaption}
            </p>
          )}
          {(loop.nyxCaption || state === "listening") && (
            <p className="nyx-caption nyx-caption--nyx">
              {loop.nyxCaption ? (
                <>
                  <span className="nyx-caption__who nyx-caption__who--nyx">Nyx</span>
                  {loop.nyxCaption}
                  {loop.interrupted && <span className="nyx-caption__flag">{t("unterbrochen")}</span>}
                </>
              ) : (
                <span className="text-a-mut">{t("Ich höre …")}</span>
              )}
            </p>
          )}
        </div>

        {loop.error && (
          <div role="alert" className="nyx-alert">
            {loop.error}
          </div>
        )}

        {/* Nur das Mikrofonsymbol – kein Kasten, kein Dauer-Zuhören-Schalter,
            kein „Leertaste halten“. Stopp erscheint nur, solange Nyx arbeitet oder spricht. */}
        <div className="nyx-mic-dock" data-nyx="nyx-mikro">
          <MicButton loop={loop} drive={drive} state={state} />
          {busy && loop.awake && (
            <button type="button" onClick={loop.interrupt} className="nyx-stop nyx-mic-dock__stop" data-nyx="nyx-unterbrechen">
              <Icon name="stop" />
              {t("Stopp")}
              <kbd className="nyx-kbd">Esc</kbd>
            </button>
          )}
        </div>
        {!(panelOpen && tab === "chat") && <QuickAsk onAsk={(text) => void conversation.ask(text, "web")} onOpenChat={() => setTab("chat")} busy={conversation.busy} />}
      </div>

      {/* ── Rechts: Glas-Leiste mit Reitern, einklappbar ── */}
      <aside className="nyx-panel" data-open={panelOpen ? "true" : "false"} aria-label={t("Nyx-Leiste")}>
        <nav className="nyx-rail" aria-label={t("Leiste")}>
          <button
            type="button"
            className="nyx-rail__toggle"
            aria-expanded={panelOpen}
            aria-controls="nyx-panel-body"
            aria-label={panelOpen ? t("Leiste einklappen") : t("Leiste aufklappen")}
            title={panelOpen ? t("Leiste einklappen") : t("Leiste aufklappen")}
            data-nyx="nyx-leiste-umschalten"
            onClick={() => setPanelOpen(!panelOpen)}
          >
            <Icon name={panelOpen ? "collapse" : "expand"} />
          </button>
          <div role="tablist" aria-label={t("Bereiche")} aria-orientation="vertical" className="nyx-rail__tabs">
            {NYX_TABS.map((tb) => (
              <button
                key={tb.id}
                type="button"
                role="tab"
                aria-selected={tab === tb.id}
                aria-controls="nyx-panel-body"
                aria-label={tb.label}
                title={tb.label}
                data-nyx={`nyx-reiter-${tb.id}`}
                onClick={() => (tab === tb.id && panelOpen ? setPanelOpen(false) : setTab(tb.id))}
                className="nyx-rail__tab"
                data-active={tab === tb.id && panelOpen ? "true" : "false"}
              >
                <Icon name={tb.icon} />
                {badge[tb.id] != null && <span className="nyx-rail__badge">{badge[tb.id]}</span>}
              </button>
            ))}
          </div>
        </nav>
        {panelOpen && (
          <div id="nyx-panel-body" className="nyx-panel__body nyx-glass" role="tabpanel" aria-label={current.label}>
            <div className="nyx-panel__head">
              <Icon name={current.icon} />
              <h2>{current.label}</h2>
            </div>
            <div className="nyx-panel__content">
              {tab === "chat" && <ChatPanel conversation={conversation} gifts={gifts} onClearGifts={() => setGifts([])} onSent={() => undefined} />}
              {tab === "aufgaben" && <TasksPanel tasks={live.tasks} state={state} tool={tool} detail={server?.detail ?? null} openImage={openImage} />}
              {tab === "geben" && <GivePanel threadId={conversation.threadId} gifts={gifts} onAdd={(g) => setGifts((gs) => [...gs, g])} onGoChat={() => setTab("chat")} />}
              {tab === "bilder" && <ImagesPanel openImage={openImage} />}
              {tab === "gedaechtnis" && <MemoryPanel />}
              {tab === "kontext" && <ContextPanel messages={conversation.messages} timings={loop.timings} />}
              {tab === "einstellungen" && <SettingsPanel settings={settings} onChange={setSettings} />}
            </div>
          </div>
        )}
      </aside>

      {viewer && <ImageViewer files={viewer.files} index={viewer.index} onIndex={(i) => setViewer((v) => (v ? { ...v, index: i } : v))} onClose={() => setViewer(null)} />}
      <ToastView message={toast.message} />
    </div>
  );
}

// ───────────────────────────── Bausteine ─────────────────────────────

type Loop = ReturnType<typeof useNyxVoiceLoop>;

/** Großer Mikro-Knopf: Ring zeigt den Mikro-Pegel live (per rAF direkt am DOM, kein React-State).
 * Ohne Beschriftung darunter – der Hinweis steht nur noch im Tooltip und für Screenreader. */
function MicButton({ loop, drive, state }: { loop: Loop; drive: LevelDrive; state: NyxState }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!loop.awake) {
      ref.current?.style.setProperty("--lvl", "0");
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      ref.current?.style.setProperty("--lvl", Math.min(1, drive.input * 1.4).toFixed(3));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [drive, loop.awake]);
  const listening = loop.holding || state === "listening";
  const label = loop.awake ? t("Halten zum Sprechen") : loop.waking ? t("Wecke Nyx …") : t("Nyx wecken");
  return (
    <div className="nyx-mic-wrap">
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={loop.awake ? t("Knopf oder Leertaste gedrückt halten und sprechen") : t("Nyx wecken – danach Knopf oder Leertaste gedrückt halten und sprechen")}
        aria-pressed={loop.holding}
        data-nyx="nyx-sprechen"
        data-mic={!loop.awake ? "asleep" : listening ? "listening" : "ready"}
        className="nyx-mic"
        onPointerDown={(e) => {
          e.preventDefault();
          // Finger festhalten – sonst meldet iOS beim leichten Verrutschen „verlassen“ und bricht ab.
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId);
          } catch {
            // jsdom/alte Browser
          }
          if (!loop.awake) void loop.wake();
          else loop.pttDown();
        }}
        onPointerUp={() => loop.pttUp()}
        onPointerLeave={() => loop.holding && loop.pttUp()}
        // iOS/Android brechen einen langen Druck ab (Scrollen, Lupe) – dann wie Loslassen behandeln.
        onPointerCancel={() => loop.holding && loop.pttUp()}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !loop.awake) void loop.wake();
        }}
      >
        <span className="nyx-mic__ring" aria-hidden="true" />
        <span className="nyx-mic__ring nyx-mic__ring--2" aria-hidden="true" />
        <Icon name={loop.awake ? "mic" : "spark"} />
      </button>
    </div>
  );
}

function QuickAsk({ onAsk, onOpenChat, busy }: { onAsk(text: string): void; onOpenChat(): void; busy: boolean }) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    onAsk(q);
    setText("");
    onOpenChat();
  };
  return (
    <form className="nyx-ask nyx-glass" onSubmit={submit} data-nyx="nyx-schreiben">
      <Icon name="pen" />
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Oder schreib Nyx etwas …")} aria-label={t("Schnell an Nyx schreiben")} className="nyx-ask__input" />
      <button type="submit" className="nyx-ask__send" disabled={!text.trim() || busy} aria-label={t("Senden")}>
        <Icon name="send" />
      </button>
    </form>
  );
}

const ICONS: Record<IconName | "menu" | "mic" | "micOff" | "spark" | "stop" | "pen" | "send" | "collapse" | "expand", ReactNode> = {
  chat: <path d="M4 5h16v10H9l-5 4z" />,
  tasks: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  give: (
    <>
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M5 20h14" />
    </>
  ),
  images: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M20 16l-5-5-8 8" />
    </>
  ),
  memory: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="6" r="1.6" />
      <circle cx="19" cy="6" r="1.6" />
      <circle cx="12" cy="20" r="1.6" />
      <path d="M6.3 7.2l3.4 2.9M17.7 7.2l-3.4 2.9M12 15v3.4" />
    </>
  ),
  context: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 8 8h-8z" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  micOff: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" />
    </>
  ),
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  pen: <path d="M4 20l4-1 11-11-3-3L5 16z" />,
  send: <path d="M4 12l16-8-6 16-2-6z" />,
  collapse: <path d="M9 5l7 7-7 7" />,
  expand: <path d="M15 5l-7 7 7 7" />,
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cn("nyx-icon")} aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
