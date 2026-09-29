// Einstellungen → „Temporäre Chats und Sessions“: nach wie vielen Stunden (1–72) Wegwerf-Einträge
// verschwinden. Sessions wandern ins Archiv (Transkripte bleiben), Haiku-Fäden werden gelöscht.
import { t, TEMPORARY_HOURS_MAX, TEMPORARY_HOURS_MIN } from "@nyxos/shared";
import { useState } from "react";
import { SectionTitle } from "../../components/ui/Card";
import { useSaveTemporaryHours, useTemporarySettings } from "./api";
import { TemporaryArchive } from "./TemporaryArchive";

const FIELD = "w-24 rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 font-mono text-callout text-a-ink focus:border-a-acc focus:outline-none";

export function TemporarySettingsPanel() {
  const settings = useTemporarySettings();
  const save = useSaveTemporaryHours();
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const value = draft ?? (settings.data ? String(settings.data.hours) : "");

  const submit = () => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < TEMPORARY_HOURS_MIN || n > TEMPORARY_HOURS_MAX) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save.mutate(n, { onSuccess: () => setDraft(null) });
  };

  return (
    <section className="grid gap-2" aria-labelledby="temp-settings-title">
      <SectionTitle>
        <span id="temp-settings-title">{t("Wegwerf-Chats")}</span>
      </SectionTitle>
      <p className="text-callout text-a-mut">
        {t(
          "Mit ⏳ markierte („temporäre“) Sessions und Nyx-Fäden verschwinden nach dieser Zeit ohne Aktivität. Sessions wandern ins Archiv – die Verläufe bleiben, auf deinem Rechner wird nichts gelöscht. „Behalten“ (Reiter Info einer Session) oder „Zurückholen“ (unten) macht sie wieder normal.",
        )}
      </p>
      <form
        noValidate
        className="flex flex-wrap items-end gap-3 rounded-xl border border-a-line bg-a-p p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="grid gap-1 text-caption text-a-mut">
          {t("Nach wie vielen Stunden")}
          <input
            type="number"
            inputMode="numeric"
            min={TEMPORARY_HOURS_MIN}
            max={TEMPORARY_HOURS_MAX}
            step={1}
            aria-label={t("Stunden bis temporäre Einträge verschwinden")}
            value={value}
            disabled={settings.isPending}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
            }}
            className={FIELD}
          />
        </label>
        <button
          type="submit"
          disabled={save.isPending || settings.isPending}
          className="h-[34px] rounded-lg border border-transparent bg-a-primary px-3 text-caption font-semibold text-a-on-primary hover:brightness-110 disabled:opacity-40"
        >
          {t("Speichern")}
        </button>
        {save.isSuccess && draft === null && <span className="pb-2 text-caption text-a-ok">{t("Gespeichert.")}</span>}
        {invalid && (
          <p role="alert" className="basis-full text-caption text-a-bad">
            {t("Bitte eine ganze Zahl von {min} bis {max} Stunden eingeben.", { min: TEMPORARY_HOURS_MIN, max: TEMPORARY_HOURS_MAX })}
          </p>
        )}
        {save.isError && (
          <p role="alert" className="basis-full text-caption text-a-bad">
            {t("Speichern hat nicht geklappt. Bitte noch einmal versuchen.")}
          </p>
        )}
        {settings.isError && (
          <p role="alert" className="basis-full text-caption text-a-bad">
            {t("Die Einstellung konnte nicht geladen werden.")}{" "}
            <button type="button" className="underline" onClick={() => void settings.refetch()}>
              {t("Erneut versuchen")}
            </button>
          </p>
        )}
      </form>
      <TemporaryArchive />
    </section>
  );
}
