// Einstellungen → Nyx → Stimme. Von oben nach unten: Anbieter (eigene Stimme / ElevenLabs), eigene Stimmen je
// Sprache mit Hörprobe je Stimme, Tempo, ElevenLabs (Schlüssel, Stimme, Modell), Aussprache-Wörterbuch.
// Stimme + Tempo gelten je Browser (wie im Nyx-Tab, derselbe Speicher); Anbieter, ElevenLabs und Aussprache liegen
// auf dem Server und gelten überall (Browser, Begleiter, Telegram). Lokal steht ganz oben das Stimmen-Paket
// (installieren mit einem Klick); die Sprache der App steht in den Listen zuerst.
import { ELEVENLABS_CLONE_MAX_BYTES, ELEVENLABS_MODELS, NYX_LEXICON_MAX_ENTRIES, NYX_VOICE_IMPORT_URL, getLang, locale, t, type NyxImportableVoice, type ElevenLabsModel, type NyxLexiconEntry, type NyxVoiceInfo, type NyxVoiceSettings } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn";
import { friendlyError } from "../../../lib/friendlyError";
import { useAppInfo } from "../../../hooks/useAppInfo";
import { RATE_MAX, RATE_MIN, useNyxSettings } from "../../nyx/tab/settings";
import {
  cloneElevenLabsVoice,
  deleteElevenLabsKey,
  importVoice,
  ELEVEN_VOICES_KEY,
  fetchElevenLabsVoices,
  fetchProbeAudio,
  fetchVoiceSettings,
  fetchVoiceStatusFull,
  VOICE_STATUS_FULL_KEY,
  saveElevenLabsKey,
  saveVoiceSettings,
  VOICE_SETTINGS_KEY,
} from "./nyxApi";
import { VoicePackBlock } from "./VoicePackBlock";

const FIELD =
  "w-full min-w-0 rounded-lg border border-a-line bg-a-p2 px-3 py-2 font-body text-callout text-a-ink placeholder:text-a-mut focus:border-a-acc focus:outline-none";
const LABEL = "font-mono text-label uppercase tracking-wide text-a-mut";
const BTN = "rounded-lg border border-a-line px-3 py-1.5 text-caption text-a-ink transition-colors hover:bg-a-p2 disabled:opacity-50";
const BTN_PRIMARY = "rounded-lg border border-transparent bg-a-primary px-4 py-1.5 text-caption font-semibold text-a-on-primary hover:brightness-110 disabled:opacity-50";

/** Hörprobe in der Sprache der Stimme (nicht der Oberfläche) – mit dem Namen aus der Einrichtung, falls gesetzt. */
function sample(lang: "de" | "en", name: string): string {
  const n = name.trim();
  return lang === "en"
    ? `${n ? `Hi ${n}` : "Hi"}, I'm Nyx. Your build is ready at 2:30 PM.`
    : `${n ? `Hallo ${n}` : "Hallo"}, ich bin Nyx. Dein Build ist um 14:30 Uhr fertig, die Session läuft seit 3 Std.`;
}

const MODEL_LABEL: Record<ElevenLabsModel, string> = {
  eleven_multilingual_v2: t("Multilingual v2 – beste Qualität"),
  eleven_flash_v2_5: t("Flash v2.5 – sehr schnell, günstiger"),
};

type ProbeState = { key: string; state: "loading" | "playing" | "failed"; note?: string } | null;

/** Eine Hörprobe zur Zeit: neue Probe stoppt die alte. */
function useProbe() {
  const [probe, setProbe] = useState<ProbeState>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
    },
    [],
  );
  async function play(key: string, body: Record<string, unknown>) {
    abortRef.current?.abort();
    audioRef.current?.pause();
    const abort = new AbortController();
    abortRef.current = abort;
    setProbe({ key, state: "loading" });
    try {
      const out = await fetchProbeAudio(body, abort.signal);
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(out.blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      const done = (failed: boolean) => {
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) setProbe(failed ? { key, state: "failed" } : null);
      };
      audio.onended = () => done(false);
      audio.onerror = () => done(true);
      setProbe({ key, state: "playing", note: out.fallback ? t("ElevenLabs hat nicht geantwortet – das ist die eigene Stimme als Ersatz.") : undefined });
      await audio.play();
    } catch (e) {
      if (abort.signal.aborted) return;
      setProbe({ key, state: "failed", note: friendlyError(e, t("Die Hörprobe hat nicht geklappt – die Stimme startet vielleicht gerade.")) });
    }
  }
  return { probe, play };
}

function ProbeButton({ id, probe, onPlay, label }: { id: string; probe: ProbeState; onPlay: () => void; label?: string }) {
  const mine = probe?.key === id ? probe : null;
  return (
    <button type="button" onClick={onPlay} disabled={mine?.state === "loading"} className={cn(BTN, "shrink-0 text-a-acc")} data-nyx={`probe-${id}`}>
      {mine?.state === "loading" ? t("Rechnet …") : mine?.state === "playing" ? t("Spielt …") : (label ?? t("Hörprobe"))}
    </button>
  );
}

function Block({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-2.5">
      <div className="grid gap-0.5">
        <h3 className={LABEL}>{title}</h3>
        {hint && <p className="text-caption text-a-mut">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function NyxVoiceSettings() {
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: VOICE_SETTINGS_KEY, queryFn: fetchVoiceSettings, retry: false });
  const statusQ = useQuery({
    queryKey: VOICE_STATUS_FULL_KEY,
    queryFn: fetchVoiceStatusFull,
    staleTime: 30_000,
    retry: false,
    // Während eine (importierte) Stimme lädt, alle 3 s nachsehen – danach steht sie mit Hörprobe in der Liste.
    refetchInterval: (q) => ((q.state.data?.tts?.voiceInfo ?? []).some((v) => !v.ready && v.state !== "error") ? 3000 : false),
  });
  const [tab, setTab] = useNyxSettings();
  const { probe, play } = useProbe();
  // Name aus der Einrichtung; fehlt er (oder antwortet der Server unvollständig), klingt die Probe ohne Namen.
  const appInfo = useAppInfo().data;
  const userName = appInfo?.settings?.userName ?? "";
  // Lokal (nicht in der Demo) läuft die eigene Stimme als Stimmen-Paket auf diesem Computer.
  const localMode = appInfo?.mode === "local" && !appInfo.demo;
  const [packInstalled, setPackInstalled] = useState<boolean | null>(null);
  const showLocalVoices = !localMode || packInstalled !== false;
  const langs = getLang() === "en" ? (["en", "de"] as const) : (["de", "en"] as const);
  // Nur eine vollständige Antwort zählt (ein älterer Server ohne Stimmen-Einstellungen liefert etwas anderes).
  const s = settingsQ.data?.elevenlabs ? settingsQ.data : undefined;

  const save = useMutation({
    mutationFn: saveVoiceSettings,
    onSuccess: (res) => qc.setQueryData<NyxVoiceSettings>(VOICE_SETTINGS_KEY, res),
  });

  const voices = statusQ.data?.tts?.voiceInfo ?? [];
  const local = (lang: "de" | "en") => voices.filter((v) => (v.language ?? "de") === lang);
  const probeLocal = (v: NyxVoiceInfo) =>
    play(`local-${v.id}`, { text: sample(v.language === "en" ? "en" : "de", userName), provider: "local", language: v.language, ...(v.language === "en" ? { voiceEn: v.id } : { voice: v.id }), speed: tab.rate });

  return (
    <section id="stimme" aria-label={t("Stimme")} className="grid min-w-0 scroll-mt-4 gap-5 rounded-xl border border-a-line bg-a-p p-4 md:p-5" data-nyx="nyx-stimme-einstellungen">
      <div className="grid gap-0.5">
        <h2 className="font-display text-headline text-a-ink">{t("Stimme")}</h2>
        <p className="text-caption text-a-mut">{t("Wie Nyx klingt: welche Stimme, wie schnell und wie er schwierige Wörter ausspricht. Jede Stimme kannst du vorher anhören.")}</p>
      </div>

      {localMode && <VoicePackBlock onState={setPackInstalled} />}

      {settingsQ.isError && <p className="text-callout text-a-bad">{friendlyError(settingsQ.error, t("Die Stimmen-Einstellungen ließen sich nicht laden."))}</p>}

      {s && (
        <Block
          title={t("Anbieter")}
          hint={
            localMode
              ? t("Eigene Stimme = läuft auf diesem Computer, kostenlos. ElevenLabs = sehr natürlich, braucht deinen Schlüssel. Fällt ElevenLabs aus, spricht automatisch die eigene Stimme.")
              : t("Eigene Stimme = läuft auf deinem Server, kostenlos. ElevenLabs = sehr natürlich, braucht deinen Schlüssel. Fällt ElevenLabs aus, spricht automatisch die eigene Stimme.")
          }
        >
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("Anbieter")}>
            {(["local", "elevenlabs"] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={s.provider === p}
                disabled={save.isPending || (p === "elevenlabs" && (!s.elevenlabs.keySet || !s.elevenlabs.voiceId))}
                onClick={() => save.mutate({ provider: p })}
                className={cn(BTN, s.provider === p && "border-a-acc bg-a-acc/10 text-a-acc")}
              >
                {p === "local" ? t("Eigene Stimme") : "ElevenLabs"}
              </button>
            ))}
          </div>
          {!s.elevenlabs.keySet && <p className="text-caption text-a-mut">{t("Für ElevenLabs unten zuerst den Schlüssel eintragen und eine Stimme wählen.")}</p>}
          {save.isError && <p className="text-caption text-a-bad">{friendlyError(save.error, t("Nicht gespeichert – bitte noch einmal."))}</p>}
        </Block>
      )}

      {showLocalVoices && (
        <Block title={t("Eigene Stimmen")} hint={t("Deutsch und Englisch haben je eine eigene Stimme. Deine Wahl gilt in diesem Browser.")}>
          {statusQ.isError && <p className="text-caption text-a-wait">{t("Der Stimmen-Dienst antwortet gerade nicht.")}</p>}
          {langs.map((lang) => {
            const chosen = lang === "de" ? tab.voice : tab.voiceEn;
            const list = local(lang);
            return (
              <div key={lang} className="grid gap-1.5">
                <span className="text-callout text-a-ink">{lang === "de" ? t("Deutsch") : t("Englisch")}</span>
                <ul className="grid gap-1.5">
                  <li className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-a-line bg-a-p2 px-3 py-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-callout text-a-ink">
                      <input type="radio" name={`voice-${lang}`} checked={!chosen} onChange={() => setTab(lang === "de" ? { voice: null } : { voiceEn: null })} />
                      {localMode ? t("Standard") : t("Standard des Servers")}
                      <span className="text-caption text-a-mut">({(lang === "de" ? statusQ.data?.tts?.voice : statusQ.data?.tts?.voiceEn) ?? "–"})</span>
                    </label>
                  </li>
                  {list.map((v) => (
                    <li key={v.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-a-line bg-a-p2 px-3 py-2">
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-callout text-a-ink">
                        <input type="radio" name={`voice-${lang}`} checked={chosen === v.id} onChange={() => setTab(lang === "de" ? { voice: v.id } : { voiceEn: v.id })} />
                        <span className="truncate">{v.label}</span>
                        <span className="text-caption text-a-mut">{v.engine === "pocket" ? t("natürlich") : t("schnell")}{v.ready ? "" : ` · ${t("lädt noch")}`}</span>
                      </label>
                      <ProbeButton id={`local-${v.id}`} probe={probe} onPlay={() => void probeLocal(v)} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </Block>
      )}

      {probe?.state === "failed" && probe.note && probe.key.startsWith("local-") && <p className="-mt-3 text-caption text-a-wait">{probe.note}</p>}

      {showLocalVoices && <ImportBlock importable={statusQ.data?.tts?.importable ?? []} localMode={localMode} onImported={() => void qc.invalidateQueries({ queryKey: VOICE_STATUS_FULL_KEY })} />}

      <Block title={t("Tempo")} hint={t("Gilt für alle Stimmen in diesem Browser.")}>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={RATE_MIN}
            max={RATE_MAX}
            step={0.05}
            value={tab.rate}
            onChange={(e) => setTab({ rate: Number(e.target.value) })}
            className="min-w-0 flex-1 accent-a-acc"
            aria-label={t("Sprechtempo")}
          />
          <span className="w-14 text-right font-mono text-caption text-a-ink">{tab.rate.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×</span>
        </div>
        <p className="text-caption text-a-mut">{t("Tonhöhe und eine eigene Lautstärke bieten die Stimmen nicht an – die Lautstärke regelst du am Gerät.")}</p>
      </Block>

      {s && <ElevenLabsBlock settings={s} onSaved={(res) => qc.setQueryData(VOICE_SETTINGS_KEY, res)} probe={probe} play={play} rate={tab.rate} userName={userName} />}
      {s && <LexiconBlock settings={s} probe={probe} play={play} rate={tab.rate} onSaved={(res) => qc.setQueryData(VOICE_SETTINGS_KEY, res)} />}
      {settingsQ.isLoading && <p className="text-caption text-a-mut">{t("Lädt …")}</p>}
    </section>
  );
}

type ProbeProps = { probe: ProbeState; play: (key: string, body: Record<string, unknown>) => Promise<void>; rate: number };

function ElevenLabsBlock({ settings, onSaved, probe, play, rate, userName }: { settings: NyxVoiceSettings; onSaved: (s: NyxVoiceSettings) => void; userName: string } & ProbeProps) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const el = settings.elevenlabs;
  const voicesQ = useQuery({ queryKey: ELEVEN_VOICES_KEY, queryFn: fetchElevenLabsVoices, enabled: el.keySet, retry: false, staleTime: 5 * 60_000 });
  const saveKey = useMutation({
    mutationFn: saveElevenLabsKey,
    onSuccess: (res) => {
      setKey("");
      onSaved(res);
      void qc.invalidateQueries({ queryKey: ELEVEN_VOICES_KEY });
    },
  });
  const removeKey = useMutation({ mutationFn: deleteElevenLabsKey, onSuccess: onSaved });
  const save = useMutation({ mutationFn: saveVoiceSettings, onSuccess: onSaved });

  return (
    <Block
      title="ElevenLabs"
      hint={t("Optional: sehr natürliche Stimmen von ElevenLabs. Der Schlüssel wird verschlüsselt auf dem Server gespeichert und nie wieder angezeigt. Kosten laufen über dein ElevenLabs-Konto.")}
    >
      {el.keySet ? (
        <div className="flex flex-wrap items-center gap-2 text-callout" data-nyx-risk="">
          <span className="text-a-ok">{t("Schlüssel gesetzt ✓")}</span>
          {el.last4 && <span className="font-mono text-caption text-a-mut">…{el.last4}</span>}
          <button type="button" className={BTN} disabled={removeKey.isPending} onClick={() => removeKey.mutate()}>
            {removeKey.isPending ? t("Entfernt …") : t("Schlüssel entfernen")}
          </button>
        </div>
      ) : null}
      <form
        className="flex min-w-0 flex-wrap gap-2"
        data-nyx-risk=""
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) saveKey.mutate(key.trim());
        }}
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={el.keySet ? t("Neuen Schlüssel eintragen (ersetzt den alten)") : t("ElevenLabs-API-Schlüssel einfügen")}
          className={cn(FIELD, "flex-1 basis-64")}
          aria-label={t("ElevenLabs-API-Schlüssel")}
        />
        <button type="submit" className={BTN_PRIMARY} disabled={!key.trim() || saveKey.isPending}>
          {saveKey.isPending ? t("Prüft …") : t("Prüfen und speichern")}
        </button>
      </form>
      {saveKey.isError && <p className="text-caption text-a-bad">{friendlyError(saveKey.error, t("Der Schlüssel ließ sich nicht speichern."))}</p>}

      {el.keySet && (
        <>
          <label className="grid gap-1 text-caption">
            <span className="text-a-ink">{t("Modell")}</span>
            <select value={el.model} onChange={(e) => save.mutate({ elevenlabsModel: e.target.value as ElevenLabsModel })} className={FIELD} aria-label={t("ElevenLabs-Modell")}>
              {ELEVENLABS_MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <span className="text-callout text-a-ink">{t("Stimme")}</span>
          {voicesQ.isLoading && <p className="text-caption text-a-mut">{t("Lädt die Stimmen von ElevenLabs …")}</p>}
          {voicesQ.isError && <p className="text-caption text-a-bad">{friendlyError(voicesQ.error, t("Die Stimmen von ElevenLabs ließen sich nicht laden."))}</p>}
          {voicesQ.data && voicesQ.data.length === 0 && <p className="text-caption text-a-mut">{t("In deinem ElevenLabs-Konto sind keine Stimmen.")}</p>}
          <ul className="grid max-h-96 gap-1.5 overflow-y-auto">
            {voicesQ.data?.map((v) => (
              <li key={v.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-a-line bg-a-p2 px-3 py-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-callout text-a-ink">
                  <input type="radio" name="eleven-voice" checked={el.voiceId === v.id} onChange={() => save.mutate({ elevenlabsVoiceId: v.id, elevenlabsVoiceName: v.name })} />
                  <span className="truncate">{v.name}</span>
                  {v.description && <span className="truncate text-caption text-a-mut">{v.description}</span>}
                </label>
                <ProbeButton id={`el-${v.id}`} probe={probe} onPlay={() => void play(`el-${v.id}`, { text: sample(getLang(), userName), provider: "elevenlabs", elevenVoice: v.id, language: getLang(), speed: rate })} />
              </li>
            ))}
          </ul>
          {save.isError && <p className="text-caption text-a-bad">{friendlyError(save.error, t("Nicht gespeichert – bitte noch einmal."))}</p>}
          <CloneForm
            onCloned={(id, name) => {
              void qc.invalidateQueries({ queryKey: ELEVEN_VOICES_KEY });
              save.mutate({ elevenlabsVoiceId: id, elevenlabsVoiceName: name });
            }}
          />
          {el.voiceId && settings.provider !== "elevenlabs" && (
            <button type="button" className={cn(BTN_PRIMARY, "w-fit")} onClick={() => save.mutate({ provider: "elevenlabs" })}>
              {t("ElevenLabs ab jetzt nutzen ({voice})", { voice: el.voiceName ?? el.voiceId })}
            </button>
          )}
        </>
      )}
      {probe?.note && probe.key.startsWith("el-") && <p className="text-caption text-a-wait">{probe.note}</p>}
    </Block>
  );
}

function LexiconBlock({ settings, onSaved, probe, play, rate }: { settings: NyxVoiceSettings; onSaved: (s: NyxVoiceSettings) => void } & ProbeProps) {
  const [rows, setRows] = useState<NyxLexiconEntry[]>(settings.lexicon);
  // Nur nachziehen, wenn sich das GESPEICHERTE Wörterbuch inhaltlich ändert – andere Speicherungen (Anbieter,
  // ElevenLabs-Stimme) liefern eine neue Liste mit gleichem Inhalt und dürfen ungespeicherte Eingaben nicht löschen.
  const savedJson = JSON.stringify(settings.lexicon);
  useEffect(() => setRows(JSON.parse(savedJson) as NyxLexiconEntry[]), [savedJson]);
  const valid = rows.filter((r) => r.word.trim() && r.say.trim());
  const dirty = JSON.stringify(valid) !== savedJson;
  const save = useMutation({ mutationFn: (lexicon: NyxLexiconEntry[]) => saveVoiceSettings({ lexicon }), onSuccess: onSaved });
  const set = (i: number, patch: Partial<NyxLexiconEntry>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Block
      title={t("Aussprache")}
      hint={t(
        "Spricht Nyx ein Wort falsch, schreib hier, wie es klingen soll – so, wie man es auf Deutsch liest (z. B. „Session“ → „Säschn“). Gilt für die eigenen deutschen Stimmen, überall. Fachwörter wie Build, Commit, Deploy, Claude oder Codex kennt Nyx schon.",
      )}
    >
      <ul className="grid gap-1.5">
        {rows.map((r, i) => (
          <li key={i} className="flex min-w-0 flex-wrap items-center gap-2">
            <input value={r.word} maxLength={60} onChange={(e) => set(i, { word: e.target.value })} placeholder={t("Wort")} className={cn(FIELD, "flex-1 basis-36")} aria-label={t("Wort {n}", { n: i + 1 })} />
            <span className="text-a-mut" aria-hidden>
              →
            </span>
            <input value={r.say} maxLength={120} onChange={(e) => set(i, { say: e.target.value })} placeholder={t("So soll es klingen")} className={cn(FIELD, "flex-1 basis-36")} aria-label={t("Aussprache {n}", { n: i + 1 })} />
            <ProbeButton
              id={`lex-${i}`}
              probe={probe}
              label={t("Anhören")}
              onPlay={() => r.word.trim() && r.say.trim() && void play(`lex-${i}`, { text: `Das Wort ${r.word.trim()}.`, provider: "local", language: "de", lexicon: [{ word: r.word.trim(), say: r.say.trim() }], speed: rate })}
            />
            <button type="button" className={BTN} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={t("Eintrag {n} löschen", { n: i + 1 })}>
              {t("Löschen")}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN} disabled={rows.length >= NYX_LEXICON_MAX_ENTRIES} onClick={() => setRows((rs) => [...rs, { word: "", say: "" }])}>
          {t("+ Wort hinzufügen")}
        </button>
        <button type="button" className={BTN_PRIMARY} disabled={!dirty || save.isPending} onClick={() => save.mutate(valid)}>
          {save.isPending ? t("Speichert …") : t("Aussprache speichern")}
        </button>
        <span className="text-caption" aria-live="polite">
          {save.isError && <span className="text-a-bad">{friendlyError(save.error, t("Nicht gespeichert – bitte noch einmal."))}</span>}
          {!save.isError && dirty && <span className="text-a-wait">{t("Noch nicht gespeichert")}</span>}
          {!save.isError && !dirty && save.isSuccess && <span className="text-a-ok">{t("Gespeichert")}</span>}
        </span>
      </div>
      {probe?.state === "failed" && probe.note && probe.key.startsWith("lex-") && <p className="text-caption text-a-wait">{probe.note}</p>}
    </Block>
  );
}

function ImportBlock({ importable, localMode, onImported }: { importable: NyxImportableVoice[]; localMode: boolean; onImported: () => void }) {
  const [url, setUrl] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: importVoice,
    onSuccess: (res) => {
      setUrl("");
      setDone(res.added ? t("{id} wird geladen – gleich steht sie oben in der Liste.", { id: res.id }) : t("{id} ist schon installiert.", { id: res.id }));
      onImported();
    },
  });
  const open = importable.filter((v) => !v.installed);
  const urlOk = NYX_VOICE_IMPORT_URL.test(url.trim());
  return (
    <Block
      title={t("Stimme importieren")}
      hint={
        localMode
          ? t("Weitere Stimmen auf diesen Computer holen. Es gibt nur Stimmen mit geprüfter freier Lizenz – echte deutsche Sprecher sind entsprechend markiert.")
          : t("Weitere Stimmen auf deinen Server holen. Es gibt nur Stimmen mit geprüfter freier Lizenz – echte deutsche Sprecher sind entsprechend markiert.")
      }
    >
      {open.length === 0 && <p className="text-caption text-a-mut">{t("Alle verfügbaren Stimmen sind schon installiert.")}</p>}
      <ul className="grid gap-1.5">
        {open.map((v) => (
          <li key={v.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-a-line bg-a-p2 px-3 py-2">
            <span className="grid min-w-0 flex-1">
              <span className="truncate text-callout text-a-ink">{v.label}</span>
              <span className="truncate text-caption text-a-mut">
                {v.language === "en" ? t("Englisch") : t("Deutsch")} · {Math.round(v.sizeBytes / 1_000_000)} MB · {v.license}
              </span>
            </span>
            <button type="button" className={BTN} disabled={run.isPending} onClick={() => run.mutate({ id: v.id })} data-nyx={`import-${v.id}`}>
              {t("Importieren")}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex min-w-0 flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (urlOk) run.mutate({ url: url.trim() });
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-….tar.bz2"
          className={cn(FIELD, "flex-1 basis-64")}
          aria-label={t("Adresse eines Piper-Stimmen-Pakets")}
          spellCheck={false}
        />
        <button type="submit" className={BTN_PRIMARY} disabled={!urlOk || run.isPending}>
          {run.isPending ? t("Importiert …") : t("Paket importieren")}
        </button>
      </form>
      {url.trim() && !urlOk && <p className="text-caption text-a-wait">{t("Nur Piper-Pakete von github.com/k2-fsa/sherpa-onnx (tts-models, vits-piper-….tar.bz2).")}</p>}
      {run.isError && <p className="text-caption text-a-bad">{friendlyError(run.error, t("Das Importieren hat nicht geklappt."))}</p>}
      {done && !run.isError && <p className="text-caption text-a-ok">{done}</p>}
    </Block>
  );
}

function CloneForm({ onCloned }: { onCloned: (id: string, name: string) => void }) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const tooBig = !!file && file.size > ELEVENLABS_CLONE_MAX_BYTES;
  const clone = useMutation({
    mutationFn: () => cloneElevenLabsVoice(name.trim(), file as File),
    onSuccess: (res) => {
      setName("");
      setFile(null);
      setConsent(false);
      onCloned(res.id, res.name);
    },
  });
  return (
    <form
      className="grid gap-2 rounded-lg border border-a-line bg-a-p2 p-3"
      aria-label={t("Eigene Stimme bei ElevenLabs anlegen")}
      onSubmit={(e) => {
        e.preventDefault();
        if (file && name.trim() && consent && !tooBig) clone.mutate();
      }}
    >
      <span className="text-callout text-a-ink">{t("Eigene Stimme anlegen (Stimmen-Klon)")}</span>
      <span className="text-caption text-a-mut">{t("Eine klare Aufnahme (WAV oder MP3, 1–3 Minuten, höchstens 10 MB). ElevenLabs baut daraus eine neue Stimme in deinem Konto.")}</span>
      <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t("Name der Stimme")} className={FIELD} aria-label={t("Name der neuen Stimme")} />
      <input
        type="file"
        accept=".wav,.mp3,audio/wav,audio/mpeg"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-caption text-a-ink"
        aria-label={t("Hörprobe (WAV oder MP3)")}
      />
      {tooBig && <span className="text-caption text-a-bad">{t("Die Datei ist größer als 10 MB.")}</span>}
      <label className="flex items-start gap-2 text-caption text-a-ink">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        {t("Das ist meine eigene Stimme oder ich habe die Erlaubnis der Person.")}
      </label>
      <button type="submit" className={cn(BTN_PRIMARY, "w-fit")} disabled={!file || !name.trim() || !consent || tooBig || clone.isPending}>
        {clone.isPending ? t("Wird angelegt …") : t("Stimme anlegen")}
      </button>
      {clone.isError && <span className="text-caption text-a-bad">{friendlyError(clone.error, t("Die Stimme ließ sich nicht anlegen."))}</span>}
      {clone.isSuccess && <span className="text-caption text-a-ok">{t("Angelegt – sie ist jetzt ausgewählt.")}</span>}
    </form>
  );
}
