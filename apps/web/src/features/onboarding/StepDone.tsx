// Schritt 5: Fertig. Kurzer Rückblick, Name + „Onboarding erledigt“ speichern, auf Wunsch ein erstes Briefing starten –
// dann auf den Überblick, der dich mit Namen begrüßt.
import { t, tc, type OnboardingStep } from "@nyxos/shared";
import { useState } from "react";
import { NyxAura } from "../../components/brand/NyxAura";
import { Button } from "../../components/ui/button";
import { friendlyError } from "../../lib/friendlyError";
import { useOnboardingAi, useSetupState } from "./onboardingApi";
import { Block, ErrorLine, StatusPill } from "./ui";

export function StepDone({ name, skipped, busy, error, onFinish }: { name: string; skipped: OnboardingStep[]; busy: boolean; error: unknown; onFinish: (briefing: boolean) => void }) {
  const ai = useOnboardingAi(false);
  const setup = useSetupState();
  const ready = ai.data?.ready === true;
  const [briefing, setBriefing] = useState(true);
  const roots = setup.data?.projectRoots.length ?? 0;
  const online = setup.data?.bridgeOnline === true;
  const hooks = setup.data ? setup.data.hooks.claude && (setup.data.hooks.codex || !setup.data.tools.codex) : false;

  const rows: { label: string; ok: boolean; text: string }[] = [
    { label: t("KI"), ok: ready, text: ready ? t("Nyx ist verbunden ({model}).", { model: ai.data?.modelLabel ?? "–" }) : t("Noch nicht verbunden – Nyx antwortet erst, wenn eine KI verbunden ist (Einstellungen → Zugänge).") },
    { label: t("Profil"), ok: !skipped.includes("interview"), text: skipped.includes("interview") ? t("Übersprungen – Nyx lernt dich nach und nach kennen.") : t("Nyx weiß, wer du bist und wie du es magst.") },
    {
      label: tc("onboarding", "Ordner"),
      ok: roots > 0 || online,
      text: roots > 0 ? (roots === 1 ? t("1 Projekt-Ordner verbunden.") : t("{n} Projekt-Ordner verbunden.", { n: roots })) : t("Kein Projekt-Ordner gewählt – NyxOS zeigt alle deine Sessions."),
    },
    {
      label: t("Helfer"),
      ok: hooks,
      text: hooks
        ? t("Hooks sind eingerichtet – NyxOS sieht sofort, wenn eine Session auf dich wartet.")
        : t("Hooks fehlen noch – Sessions erscheinen trotzdem, nur ohne sofortige Meldungen. Nachholen: Einstellungen → Info & Hilfe → „Onboarding erneut starten“."),
    },
  ];

  return (
    <div className="grid gap-6">
      <header className="grid justify-items-start gap-4">
        <NyxAura size={56} state="speaking" />
        <div className="grid gap-2">
          <h1 className="font-display text-title font-semibold tracking-tight text-a-ink">{t("Alles bereit, {name}!", { name })}</h1>
          <p className="max-w-prose text-headline text-a-mut">{t("Gleich siehst du den Überblick: laufende Sessions, was wartet und was als Nächstes dran ist.")}</p>
        </div>
      </header>

      <Block title={t("Das ist eingerichtet")}>
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.label} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
              <StatusPill tone={r.ok ? "ok" : "mut"}>{r.label}</StatusPill>
              <span className="text-callout text-a-ink">{r.text}</span>
            </li>
          ))}
        </ul>
      </Block>

      {ready && (
        <label className="flex items-start gap-2.5 text-callout text-a-ink">
          <input type="checkbox" checked={briefing} onChange={(e) => setBriefing(e.target.checked)} className="mt-0.5 accent-[var(--a-acc)]" />
          <span>
            {t("Nyx soll gleich ein erstes Briefing schreiben")}
            <span className="block text-caption text-a-mut">{t("Eine kurze Zusammenfassung deiner Lage. Dauert etwa eine Minute im Hintergrund.")}</span>
          </span>
        </label>
      )}

      <div className="grid justify-items-start gap-2">
        <Button variant="primary" className="px-5 py-2 text-headline" onClick={() => onFinish(ready && briefing)} disabled={busy} autoFocus>
          {busy ? t("Einen Moment …") : t("Los geht's")}
        </Button>
        <ErrorLine text={error ? friendlyError(error) : null} />
      </div>
    </div>
  );
}
