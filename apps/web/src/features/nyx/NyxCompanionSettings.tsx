// Einstellungen → Nyx in der Leiste (Dauer-Zuhören an/aus, Vorlesen).
// Nyx lebt oben in der Leiste (kein schwebender Kreis mehr) – gedrückt halten zum Sprechen geht immer.
import { t } from "@nyxos/shared";
import { SectionTitle } from "../../components/ui/Card";
import { setCompanionSettings, useCompanionSettings } from "./companionSettings";

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-a-p2">
      <input type="checkbox" data-nyx={id} className="mt-0.5 h-4 w-4 accent-[var(--a-nyx)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="grid gap-0.5">
        <span className="text-callout text-a-ink">{label}</span>
        <span className="text-caption text-a-mut">{hint}</span>
      </span>
    </label>
  );
}

export function NyxCompanionSettings() {
  const s = useCompanionSettings();
  return (
    <section className="grid gap-2" aria-labelledby="nyx-companion-title" id="nyx">
      <SectionTitle>
        <span id="nyx-companion-title">{t("Nyx in der Leiste")}</span>
      </SectionTitle>
      <p className="text-callout text-a-mut">
        {t(
          "Nyx sitzt oben in der Leiste. Klick öffnet das Nyx-Zentrum (⌘J), gedrückt halten (oder ⌥ Leertaste) heißt sprechen. Nyx kann alles in NyxOS für dich bedienen – auch von Telegram aus. Löschen, Merge, Push, Deploy, Session beenden und Entscheidungen macht er nur nach deinem Tipp auf „Ausführen“; Anmeldung und Schlüssel fasst er nie an.",
        )}
      </p>
      <div className="grid gap-0.5 rounded-[13px] border border-a-line bg-a-p p-2">
        <Toggle
          id="nyx-setting-listening"
          label={t("Nyx in der Leiste: Zuhören")}
          hint={t("An: Mikrofon bleibt offen, Nyx erkennt selbst, wann du fertig bist. Aus: nur, solange du die Leiste gedrückt hältst.")}
          checked={s.listening}
          onChange={(v) => setCompanionSettings({ listening: v })}
        />
        <Toggle
          id="nyx-setting-speak"
          label={t("Antworten vorlesen")}
          hint={t("Die Stimme kommt vom eigenen Server. Ohne Stimme steht die Antwort als Text unter der Leiste.")}
          checked={s.speak}
          onChange={(v) => setCompanionSettings({ speak: v })}
        />
      </div>
    </section>
  );
}
