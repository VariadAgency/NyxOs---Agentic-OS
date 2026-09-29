// Onboarding, erster Schritt: „Demo ansehen“ als zweite Wahl neben dem Einrichten. Startet eine eigene Demo-Instanz
// mit erfundenen Daten (dauert ein paar Sekunden) und wechselt dann dorthin – der Name wird dafür nicht gebraucht.
import { t } from "@nyxos/shared";
import { useMutation } from "@tanstack/react-query";
import { NyxAura } from "../../components/brand/NyxAura";
import { Button } from "../../components/ui/button";
import { friendlyError } from "../../lib/friendlyError";
import { ErrorLine } from "../onboarding/ui";
import { demoNav, startDemo, useDemo } from "./demoApi";

export function DemoChoice() {
  const { demo } = useDemo();
  const start = useMutation({
    mutationFn: startDemo,
    onSuccess: (url) => demoNav.go(url),
  });
  // Schon in der Demo: kein zweiter Einstieg.
  if (demo) return null;
  // Nach dem Erfolg lädt die Seite gleich die Demo – bis dahin weiter „wird vorbereitet“.
  const busy = start.isPending || start.isSuccess;
  return (
    <section aria-labelledby="demo-choice-title" data-testid="demo-choice" className="grid gap-3 rounded-xl border border-a-acc/35 bg-a-acc/5 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="grid min-w-0 flex-1 basis-[220px] gap-1">
          <h2 id="demo-choice-title" className="text-headline font-semibold text-a-ink">
            {t("Erst mal reinschauen?")}
          </h2>
          <p className="text-callout text-a-mut">{t("Die komplette App mit erfundenen Daten – nichts wird verändert.")}</p>
        </div>
        {/* Nicht `disabled` (wäre blass) – beim Vorbereiten sichtbar aktiv, ein zweiter Klick tut nichts. */}
        <Button
          onClick={() => {
            if (!busy) start.mutate();
          }}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          className="h-10 shrink-0 px-5 text-callout max-sm:w-full"
        >
          {busy ? (
            <>
              <NyxAura size={16} state="thinking" />
              {t("Demo wird vorbereitet …")}
            </>
          ) : (
            t("Demo ansehen")
          )}
        </Button>
      </div>
      {busy && (
        <p role="status" className="text-caption text-a-mut">
          {t("Das dauert ein paar Sekunden.")}
        </p>
      )}
      {start.isError && <ErrorLine text={friendlyError(start.error, t("Die Demo ließ sich gerade nicht starten – bitte gleich noch einmal versuchen."))} />}
    </section>
  );
}
