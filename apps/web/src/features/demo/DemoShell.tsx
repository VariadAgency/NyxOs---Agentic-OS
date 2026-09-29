// Demo-Rahmen: eine feste Leiste unten über der ganzen App („Du siehst eine Demo …“ + großer Knopf „Jetzt einrichten“)
// und die ruhige, globale Meldung, wenn in der Demo etwas geändert werden sollte (`authFetch` → `demo_readonly`).
// Die Leiste meldet ihre Höhe als `--a-demo-bar-h`; die App hält unten so viel frei, damit nichts verdeckt ist.
import { t } from "@nyxos/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { demoReadonlyText, onDemoReadonly } from "../../lib/demoReadonly";
import { CommandLine } from "../onboarding/ui";
import { goHome, installCommand, useDemo } from "./demoApi";

/** So lange bleibt die Demo-Meldung stehen (jede neue Ablehnung startet die Zeit neu). */
const NOTICE_MS = 7000;
const BAR_HEIGHT_VAR = "--a-demo-bar-h";

export function DemoShell() {
  const { demo, homeUrl, repo } = useDemo();
  const [installOpen, setInstallOpen] = useState(false);
  const setUp = () => {
    if (homeUrl) goHome(homeUrl);
    else setInstallOpen(true);
  };
  return (
    <>
      <DemoNotice onSetUp={setUp} />
      {demo && <DemoBar homeUrl={homeUrl} repo={repo} installOpen={installOpen} onInstallOpen={setInstallOpen} onSetUp={setUp} />}
    </>
  );
}

function DemoBar({ homeUrl, repo, installOpen, onInstallOpen, onSetUp }: { homeUrl: string | null; repo: string; installOpen: boolean; onInstallOpen: (open: boolean) => void; onSetUp: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  // Eigene Höhe an die App melden (wächst mit dem Installations-Feld und auf schmalen Bildschirmen).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const report = () => root.style.setProperty(BAR_HEIGHT_VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    report();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty(BAR_HEIGHT_VAR);
    };
  }, []);

  const panelId = "demo-install-panel";
  return (
    <div
      ref={ref}
      role="region"
      aria-label={t("Demo")}
      data-testid="demo-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-a-line-strong bg-a-p px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] shadow-pop"
    >
      <div className="mx-auto grid max-w-5xl gap-3">
        {installOpen && !homeUrl && (
          <section id={panelId} aria-labelledby="demo-install-title" className="grid gap-2 rounded-xl border border-a-line bg-a-p2 p-3 motion-safe:animate-[cc-tab-fade_150ms_ease-out]">
            <div className="flex items-start gap-3">
              <div className="grid min-w-0 flex-1 gap-0.5">
                <h2 id="demo-install-title" className="text-headline font-semibold text-a-ink">
                  {t("NyxOS auf deinem Rechner einrichten")}
                </h2>
                <p className="text-callout text-a-mut">{t("Im Terminal einfügen und Enter drücken – danach führt dich NyxOS Schritt für Schritt durch die Einrichtung.")}</p>
              </div>
              <Button variant="ghost" className="shrink-0" onClick={() => onInstallOpen(false)}>
                {t("Schließen")}
              </Button>
            </div>
            <CommandLine command={installCommand(repo)} />
          </section>
        )}
        <div className="flex items-center gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-3">
          <p className="min-w-0 flex-1 text-callout text-a-ink">
            <span className="mr-2 inline-block rounded-full border border-a-wait/40 bg-a-wait/10 px-2 py-0.5 align-[1px] font-mono text-label font-medium tracking-wider text-a-wait">DEMO</span>
            {t("Du siehst eine Demo mit erfundenen Daten. Umsehen geht überall, ausprobieren kannst du nur Nyx.")}
          </p>
          <Button
            variant="primary"
            onClick={onSetUp}
            aria-expanded={homeUrl ? undefined : installOpen}
            aria-controls={homeUrl ? undefined : panelId}
            className="h-16 shrink-0 rounded-xl px-12 text-title font-bold tracking-tight shadow-raise ring-2 ring-a-acc/40 ring-offset-2 ring-offset-a-p max-sm:h-14 max-sm:w-full"
          >
            {t("Jetzt einrichten")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Ruhige Meldung statt roter Fehler, wenn in der Demo etwas geändert werden sollte. */
function DemoNotice({ onSetUp }: { onSetUp: () => void }) {
  const [shownAt, setShownAt] = useState<number | null>(null);
  useEffect(() => onDemoReadonly(() => setShownAt(Date.now())), []);
  useEffect(() => {
    if (shownAt === null) return;
    const timer = setTimeout(() => setShownAt(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [shownAt]);
  if (shownAt === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="demo-notice"
      className="cc-rise fixed bottom-[calc(var(--a-demo-bar-h)+12px)] left-1/2 z-[70] flex w-max max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-xl border border-a-line-strong bg-a-p3 px-4 py-2.5 text-callout text-a-ink shadow-pop"
    >
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-a-wait" />
      <span className="min-w-0">{demoReadonlyText()}</span>
      <button
        type="button"
        onClick={() => {
          setShownAt(null);
          onSetUp();
        }}
        className="shrink-0 font-semibold text-a-acc underline-offset-2 hover:underline"
      >
        {t("Jetzt einrichten")}
      </button>
      <button type="button" onClick={() => setShownAt(null)} aria-label={t("Hinweis schließen")} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-a-mut hover:bg-a-p2 hover:text-a-ink">
        ✕
      </button>
    </div>
  );
}
