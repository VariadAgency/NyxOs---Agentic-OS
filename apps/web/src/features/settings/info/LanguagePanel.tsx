// Einstellungen → Sprache. Umschalten speichert die Sprache auf dem Server und lädt die Seite neu, damit jeder Text
// (auch in Konstanten, die beim Laden übersetzt werden) in der neuen Sprache erscheint.
import { getLang, t, type Lang } from "@nyxos/shared";
import { useState } from "react";
import { SectionTitle } from "../../../components/ui/Card";
import { saveAppSettings } from "../../../hooks/useAppInfo";
import { switchLanguage } from "../../../lib/appInfo";
import { friendlyError } from "../../../lib/friendlyError";
import { Segmented } from "../../onboarding/ui";

export const LANGUAGE_OPTIONS: { value: Lang; label: string }[] = [
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
];

/** Deutsch/English umschalten. `beforeReload` läuft direkt vor dem Neuladen (z. B. Fortschritt merken). */
export function LanguageSwitch({ beforeReload }: { beforeReload?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = getLang();
  const change = async (lang: Lang) => {
    if (lang === current || busy) return;
    setBusy(true);
    setError(null);
    try {
      beforeReload?.();
      await switchLanguage(lang, saveAppSettings);
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-1.5">
      <Segmented value={current} options={LANGUAGE_OPTIONS} onChange={(v) => void change(v)} label={t("Sprache")} disabled={busy} />
      {busy && <p className="text-caption text-a-mut">{t("Sprache wird gewechselt …")}</p>}
      {error && (
        <p role="alert" className="text-caption text-a-bad">
          {error}
        </p>
      )}
    </div>
  );
}

export function LanguagePanel() {
  return (
    <section id="sprache" className="grid scroll-mt-4 gap-2">
      <SectionTitle>{t("Sprache")}</SectionTitle>
      <p className="text-callout text-a-mut">{t("Die Sprache von NyxOS und Nyx. Die Seite lädt danach kurz neu.")}</p>
      <LanguageSwitch />
    </section>
  );
}
