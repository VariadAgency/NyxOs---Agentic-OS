// Reiter „Einstellungen“: Stimme, Tempo, welches Modell antwortet, Dauer-Zuhören, Begleiter an/aus.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { describeModel, locale, t } from "@nyxos/shared";
import { cn } from "../../../../lib/cn";
import { fetchHaikuStatus } from "../../../haiku/haikuApi";
import { fetchVoiceStatus } from "../nyxTabApi";
import { RATE_MAX, RATE_MIN, type NyxTabSettings } from "../settings";
import { setCompanionSettings, useCompanionSettings } from "../../companionSettings";
import { synthesize } from "../../voice/serverVoice";

type VoiceLang = "de" | "en";
type VoiceChoice = { id: string; label: string; ready: boolean; language?: string };

/** Probesätze je Sprache (bewusst nicht übersetzt) – kurz, mit Fachwort und Zahl, damit man die Aussprache hört. */
export const VOICE_SAMPLE: Record<VoiceLang, string> = {
  de: "Hallo, ich bin Nyx. Der Build ist um 14:30 Uhr fertig.",
  en: "Hi, I'm Nyx. The build is ready at 2:30 PM.",
};

/** Stimmen ohne Sprach-Angabe (älterer Server) gelten als deutsch. */
export function voiceLanguage(v: { language?: string }): VoiceLang {
  return v.language === "en" ? "en" : "de";
}

/** Eine Auswahl („Deutsche Stimme“ / „Englische Stimme“) mit „Probe hören“. */
function VoicePicker({
  lang,
  label,
  value,
  voices,
  serverDefault,
  speed,
  onChange,
}: {
  lang: VoiceLang;
  label: string;
  value: string | null;
  voices: VoiceChoice[];
  serverDefault: string | null;
  speed: number;
  onChange: (id: string | null) => void;
}) {
  const [probe, setProbe] = useState<"idle" | "loading" | "playing" | "failed">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
    },
    [],
  );

  async function play() {
    abortRef.current?.abort();
    audioRef.current?.pause();
    const abort = new AbortController();
    abortRef.current = abort;
    setProbe("loading");
    const chosen = value ?? undefined;
    const blob = await synthesize(VOICE_SAMPLE[lang], {
      language: lang,
      ...(lang === "en" ? { voiceEn: chosen } : { voice: chosen }),
      speed,
      signal: abort.signal,
    });
    if (abort.signal.aborted) return;
    if (!blob) {
      setProbe("failed");
      return;
    }
    try {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      const done = (state: "idle" | "failed") => {
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) setProbe(state);
      };
      audio.onended = () => done("idle");
      audio.onerror = () => done("failed");
      setProbe("playing");
      void Promise.resolve(audio.play()).catch(() => done("failed"));
    } catch {
      setProbe("failed");
    }
  }

  const slug = lang === "en" ? "nyx-stimme-en" : "nyx-stimme";
  return (
    <div className="grid gap-1 text-caption">
      <label className="grid gap-1">
        <span className="text-a-ink">{label}</span>
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="rounded-md border border-a-line bg-a-p3 px-2 py-1.5 text-caption text-a-ink"
          data-nyx={slug}
          aria-label={label}
        >
          <option value="">{serverDefault ? t("Standard des Servers ({name})", { name: serverDefault }) : t("Standard des Servers")}</option>
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.ready ? v.label : t("{name} – lädt noch", { name: v.label })}
            </option>
          ))}
        </select>
      </label>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void play()}
          disabled={probe === "loading"}
          data-nyx={`${slug}-probe`}
          className="rounded-md border border-a-line bg-a-p3 px-2 py-1 text-caption text-a-acc disabled:opacity-60"
        >
          {probe === "loading" ? t("Stimme rechnet …") : probe === "playing" ? t("Spielt …") : t("Probe hören")}
        </button>
        {probe === "failed" && <span className="text-caption text-a-wait">{t("Die Probe hat nicht geklappt – die Stimme startet vielleicht gerade. Gleich noch einmal versuchen.")}</span>}
      </span>
    </div>
  );
}

function Toggle({ checked, onChange, label, hint, nyx }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: ReactNode; nyx: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-a-line bg-a-p2 p-3">
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-callout text-a-ink">{label}</span>
        <span className="text-caption text-a-mut">{hint}</span>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" data-nyx={nyx} aria-label={label} />
      <span aria-hidden="true" className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors", checked ? "border-a-acc bg-a-acc/80" : "border-a-line bg-a-p3")}>
        <span className={cn("absolute top-0.5 h-3.5 w-3.5 rounded-full bg-a-ink transition-[left]", checked ? "left-[18px]" : "left-0.5")} />
      </span>
    </label>
  );
}

export function SettingsPanel({ settings, onChange }: { settings: NyxTabSettings; onChange: (patch: Partial<NyxTabSettings>) => void }) {
  const bar = useCompanionSettings();
  const voice = useQuery({ queryKey: ["nyx", "voice-status"], queryFn: fetchVoiceStatus, staleTime: 30_000, retry: false });
  const status = useQuery({ queryKey: ["nyx", "haiku-status"], queryFn: fetchHaikuStatus, staleTime: 30_000 });
  // Alle installierten Stimmen mit Namen (Server-Status `voiceInfo`); ältere Server liefern nur Kennungen.
  const info = voice.data?.tts.voiceInfo ?? [];
  const ids = [...new Set([...(info.length ? info.map((v) => v.id) : [voice.data?.tts.voice]), settings.voice, settings.voiceEn].filter((v): v is string => typeof v === "string" && v.length > 0))];
  const voices: VoiceChoice[] = ids.map((id) => info.find((v) => v.id === id) ?? { id, label: id, ready: true, language: id === settings.voiceEn ? "en" : "de" });
  // Zwei getrennte Stimmen – deutsche Sätze spricht die deutsche, englische die englische.
  const voicesDe = voices.filter((v) => voiceLanguage(v) === "de");
  const voicesEn = voices.filter((v) => voiceLanguage(v) === "en");
  const labelOf = (id: string | null | undefined) => (id ? (info.find((v) => v.id === id)?.label ?? id) : null);
  const speaking = labelOf(voice.data?.tts.voice);
  const speakingEn = labelOf(voice.data?.tts.voiceEn);

  return (
    <div className="cc-scroll grid h-full content-start gap-4 overflow-y-auto p-3" data-nyx="nyx-einstellungen">
      <section className="grid gap-2">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Stimme")}</h3>
        <div className="grid gap-2 rounded-lg border border-a-line bg-a-p2 p-3">
          <div className="flex items-center gap-2 text-caption">
            <span className={cn("h-2 w-2 rounded-full", voice.data?.tts.ready && voice.data.stt.ready ? "bg-a-ok" : voice.isError ? "bg-a-wait" : "bg-a-idle")} />
            <span className="text-a-ink">
              {voice.isLoading
                ? t("Prüfe die Stimme auf dem Server …")
                : voice.isError
                  ? t("Die Stimme auf dem Server ist noch nicht eingerichtet. Bis dahin antwortet Nyx nur als Text.")
                  : voice.data?.tts.ready && voice.data.stt.ready
                    ? voice.data.scope === "local"
                      ? t("Hören und Sprechen laufen auf diesem Computer.")
                      : t("Hören und Sprechen laufen auf deinem Server.")
                    : // nicht installiert, lädt, aus: der Satz des Servers sagt ehrlich, was los ist (lokal ohne Docker).
                      [voice.data?.sentence, voice.data?.fix].filter(Boolean).join(" ") || t("Die Stimme startet gerade – gleich noch einmal schauen.")}
            </span>
          </div>
          {voice.data && (
            <div className="font-mono text-label text-a-mut">
              {t("Erkennung: {stt} · Deutsch: {de} · Englisch: {en}", { stt: voice.data.stt.model ?? "–", de: speaking ?? "–", en: speakingEn ?? "–" })}
            </div>
          )}
          <VoicePicker lang="de" label={t("Deutsche Stimme")} value={settings.voice} voices={voicesDe} serverDefault={speaking} speed={settings.rate} onChange={(id) => onChange({ voice: id })} />
          <VoicePicker lang="en" label={t("Englische Stimme")} value={settings.voiceEn} voices={voicesEn} serverDefault={speakingEn} speed={settings.rate} onChange={(id) => onChange({ voiceEn: id })} />
          <span className="text-caption text-a-mut">{t("Nyx antwortet in der Sprache, in der du ihn ansprichst. Jeder Satz bekommt die passende Stimme.")}</span>
          <label className="grid gap-1 text-caption">
            <span className="flex justify-between text-a-ink">
              <span>{t("Tempo")}</span>
              <span className="font-mono text-a-mut">{settings.rate.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 2 })}×</span>
            </span>
            <input
              type="range"
              min={RATE_MIN}
              max={RATE_MAX}
              step={0.05}
              value={settings.rate}
              onChange={(e) => onChange({ rate: Number(e.target.value) })}
              aria-label={t("Sprechtempo")}
              data-nyx="nyx-tempo"
              className="accent-[var(--a-acc)]"
            />
          </label>
        </div>
      </section>

      <section className="grid gap-2">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Modell")}</h3>
        <div className="grid gap-1 rounded-lg border border-a-line bg-a-p2 p-3 text-caption">
          <span className="text-a-ink">
            {t("Nyx antwortet gerade mit")} <span className="font-mono text-a-acc">{describeModel(status.data?.engine.model ?? "haiku")}</span>
            {status.data && status.data.engine.state !== "ready" && <span className="text-a-wait"> {t("(nicht bereit)")}</span>}
          </span>
          {status.data?.engine.reason && <span className="text-caption text-a-mut">{status.data.engine.reason}</span>}
          <Link to="/settings/modelle" className="justify-self-start text-caption text-a-acc underline">
            {t("Modelle und Anbieter verwalten")}
          </Link>
        </div>
      </section>

      <section className="grid gap-2">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Zuhören")}</h3>
        {/* Dauer-Zuhören hat keinen Schalter mehr im Tab; Nyx hört nur, solange der
            Knopf oder die Leertaste gedrückt ist (settings.ts: ein alter „an“-Zustand zählt als aus). */}
        <Toggle nyx="nyx-vorlesen" checked={settings.speakTyped} onChange={(v) => onChange({ speakTyped: v })} label={t("Getippte Antworten vorlesen")} hint={t("Auch Antworten auf geschriebene Fragen spricht Nyx laut aus.")} />
        {/* Kein Kreis mehr – Nyx sitzt oben in der Leiste; hier dieselbe Einstellung wie unter Einstellungen → Nyx. */}
        <Toggle
          nyx="nyx-leiste-zuhoeren"
          checked={bar.listening}
          onChange={(v) => setCompanionSettings({ listening: v })}
          label={t("Nyx in der Leiste: Zuhören")}
          hint={t("Auf allen anderen Seiten hört Nyx oben in der Leiste zu. Aus: nur, solange du die Leiste gedrückt hältst.")}
        />
      </section>

      <section className="grid gap-1 text-caption text-a-mut">
        <h3 className="font-mono text-label uppercase tracking-wide text-a-mut">{t("Tasten")}</h3>
        <span>
          <kbd className="rounded border border-a-line bg-a-p3 px-1 font-mono">{t("Leertaste")}</kbd> {t("halten = sprechen")} · <kbd className="rounded border border-a-line bg-a-p3 px-1 font-mono">Esc</kbd> ={" "}
          {t("Nyx unterbrechen")}
        </span>
      </section>
    </div>
  );
}
