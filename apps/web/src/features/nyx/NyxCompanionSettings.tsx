// Einstellungen → Nyx → Begleiter (Dauer-Zuhören an/aus, Vorlesen).
// Nyx lebt oben in der Leiste (kein schwebender Kreis mehr) – gedrückt halten zum Sprechen geht immer.
// Own subpage (`/einstellungen/nyx/begleiter`): title and explanation are in the subpage header; what Nyx may do
// is explained under „Zugriff & Freigaben“ (`features/settings/nyx/NyxAccessPanel.tsx`).
import { t } from "@nyxos/shared";
import { setCompanionSettings, useCompanionSettings } from "./companionSettings";

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-a-p2">
      <input type="checkbox" data-nyx={id} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--a-nyx)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
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
    <section className="grid gap-2" aria-label={t("Nyx in der Leiste")} id="nyx">
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
          hint={t("Ohne Vorlesen steht die Antwort als Text unter der Leiste.")}
          checked={s.speak}
          onChange={(v) => setCompanionSettings({ speak: v })}
        />
      </div>
      <p className="text-caption text-a-mut">{t("Klick auf Nyx öffnet das Nyx-Zentrum (⌘J). Gedrückt halten (oder ⌥ Leertaste) heißt sprechen – das geht immer.")}</p>
    </section>
  );
}
