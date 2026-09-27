// Schritt 1: Willkommen, „Demo ansehen“ als zweite Wahl, Name (Pflicht fürs Einrichten) und Sprache (vorgewählt aus dem Browser).
import { t } from "@nyxos/shared";
import { NyxAura } from "../../components/brand/NyxAura";
import { DemoChoice } from "../demo/DemoChoice";
import { FIELD, LABEL } from "../settings/fieldStyles";
import { LanguageSwitch } from "../settings/info/LanguagePanel";
import { Block } from "./ui";
import { NAME_MAX } from "./wizardState";

export function StepWelcome({ name, onName, onSubmit, beforeReload }: { name: string; onName: (v: string) => void; onSubmit: () => void; beforeReload: () => void }) {
  return (
    <div className="grid gap-6">
      <header className="grid justify-items-start gap-4">
        <NyxAura size={56} state="idle" />
        <div className="grid gap-2">
          <h1 className="font-display text-title font-semibold tracking-tight text-a-ink">{t("Willkommen bei NyxOS")}</h1>
          <p className="max-w-prose text-headline text-a-mut">
            {t("NyxOS zeigt dir alle deine Claude-Code- und Codex-Sessions an einem Ort. Nyx, deine Assistentin, behält den Überblick und hilft dir. In fünf kurzen Schritten ist alles eingerichtet.")}
          </p>
        </div>
      </header>

      {/* Zweite Wahl: erst die Demo ansehen – ohne Namen, ohne etwas einzurichten. */}
      <DemoChoice />

      <Block title={t("Wie heißt du?")}>
        <form
          className="grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <label htmlFor="onboarding-name" className={LABEL}>
            {t("Dein Name")}
          </label>
          <input
            id="onboarding-name"
            value={name}
            maxLength={NAME_MAX}
            autoComplete="given-name"
            autoFocus
            onChange={(e) => onName(e.target.value)}
            placeholder={t("z. B. Alex")}
            className={`${FIELD} max-w-sm py-2 text-headline`}
          />
          <p className="text-caption text-a-mut">{t("So spricht Nyx dich an. Du kannst ihn später in den Einstellungen ändern.")}</p>
        </form>
      </Block>

      <Block title={t("Sprache")}>
        <LanguageSwitch beforeReload={beforeReload} />
        <p className="text-caption text-a-mut">{t("Beim Wechsel lädt die Seite kurz neu – dein Name bleibt erhalten.")}</p>
      </Block>
    </div>
  );
}
