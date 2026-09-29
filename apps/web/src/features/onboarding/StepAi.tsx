// Schritt 2: KI verbinden. Zeigt live, was da ist (Claude-Programm, gespeicherte Schlüssel, lokale Modelle), und bietet
// jeden Weg an: Claude-Konto über `claude`, Codex-Anmeldung, Anthropic-/OpenAI-kompatibler Schlüssel, Ollama/LM Studio.
// Speichert über die bestehenden Wege (`/api/access`, Schlüssel verschlüsselt im Geheimnis-Speicher) und stellt Nyx
// danach mit `/api/onboarding/ai/use` auf den neuen Zugang um.
import { locale, t, type AccessId, type OnboardingAiState, type OnboardingProvider } from "@nyxos/shared";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { useAppInfo } from "../../hooks/useAppInfo";
import { friendlyError } from "../../lib/friendlyError";
import { FIELD, LABEL } from "../settings/fieldStyles";
import { useOnboardingAi, useSaveAccessKey, useSelftest, useSetupState, useUseProvider } from "./onboardingApi";
import { Block, CommandLine, ErrorLine, Segmented, StatusPill, StepHeader, Steps } from "./ui";

type KeyProvider = Extract<OnboardingProvider, "anthropic" | "openai" | "openrouter">;
type LocalProvider = Extract<OnboardingProvider, "ollama" | "lmstudio">;

const KEY_OPTIONS: { value: KeyProvider; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
];
const KEY_HINT: Record<KeyProvider, { placeholder: string; where: string; url: string }> = {
  anthropic: { placeholder: "sk-ant-…", where: "console.anthropic.com → API Keys", url: "https://console.anthropic.com/settings/keys" },
  openai: { placeholder: "sk-…", where: "platform.openai.com → API keys", url: "https://platform.openai.com/api-keys" },
  openrouter: { placeholder: "sk-or-…", where: "openrouter.ai → Keys", url: "https://openrouter.ai/keys" },
};
const LOCAL: { kind: LocalProvider; label: string; url: string; hint: string }[] = [
  { kind: "ollama", label: "Ollama", url: "http://127.0.0.1:11434", hint: t("Ollama starten und ein Modell laden, z. B. „ollama pull llama3.2“.") },
  { kind: "lmstudio", label: "LM Studio", url: "http://127.0.0.1:1234", hint: t("In LM Studio ein Modell laden und unter „Developer“ den lokalen Server starten.") },
];

function providerOf(ai: OnboardingAiState | undefined, kind: OnboardingProvider) {
  return ai?.providers.find((p) => p.kind === kind) ?? null;
}

function StatusBanner({ ai, loading, onRecheck, rechecking }: { ai: OnboardingAiState | undefined; loading: boolean; onRecheck: () => void; rechecking: boolean }) {
  return (
    <div aria-live="polite" className="flex flex-wrap items-center gap-3 rounded-xl border border-a-line bg-a-p2 px-4 py-3">
      {loading ? (
        <StatusPill tone="mut">{t("Prüfe …")}</StatusPill>
      ) : ai?.ready ? (
        <StatusPill tone="ok">{t("Nyx ist verbunden")}</StatusPill>
      ) : (
        <StatusPill tone="wait">{t("Noch keine KI verbunden")}</StatusPill>
      )}
      <p className="min-w-0 flex-1 basis-56 break-words text-callout text-a-mut">
        {ai?.ready ? t("Nyx nutzt gerade: {model}", { model: ai.modelLabel ?? "–" }) : (ai?.reason ?? t("Wähle unten einen Weg – einer reicht."))}
      </p>
      <Button onClick={onRecheck} disabled={rechecking}>
        {rechecking ? t("Prüfe …") : t("Erneut prüfen")}
      </Button>
    </div>
  );
}

function ClaudeAccount({ ai, serverMode }: { ai: OnboardingAiState | undefined; serverMode: boolean }) {
  const selftest = useSelftest();
  const found = ai?.cli.found ?? false;
  // Nyx already runs on the Claude program: the account works (the banner above says "verbunden" too).
  const proven = !!ai?.lastAnswerAt || selftest.data?.ok === true || (ai?.ready === true && ai.via === "claude-cli");
  const status = proven ? <StatusPill tone="ok">{t("angemeldet")}</StatusPill> : found ? <StatusPill tone="wait">{t("gefunden – Anmeldung prüfen")}</StatusPill> : <StatusPill tone="mut">{t("nicht gefunden")}</StatusPill>;
  return (
    <Block title={t("Claude-Konto")} badge={<StatusPill tone="mut">{t("empfohlen")}</StatusPill>} status={status}>
      <p className="text-callout text-a-mut">
        {t("Wenn du ein Claude-Abo hast (Pro oder Max), nutzt Nyx einfach das Claude-Programm auf deinem Rechner. Es kostet dann nichts extra – es zählt nur zu den Grenzen deines Abos.")}
      </p>
      {found && ai?.cli.version && <p className="text-caption text-a-mut">{t("Claude-Programm gefunden (Version {version}).", { version: ai.cli.version })}</p>}
      {!found && (
        <div className="grid gap-2">
          <p className="text-callout text-a-ink">{t("Das Claude-Programm ist noch nicht installiert. So geht es:")}</p>
          <CommandLine command="curl -fsSL https://claude.ai/install.sh | bash" />
        </div>
      )}
      {serverMode ? (
        <Steps
          items={[
            t("Auf deinem Rechner ein Terminal öffnen."),
            <>
              {t("Diesen Befehl ausführen und im Browser anmelden:")} <CommandLine command="claude setup-token" />
            </>,
            t("Den angezeigten Token auf dem Server als CLAUDE_CODE_OAUTH_TOKEN eintragen (steht in der Server-Anleitung) und NyxOS neu starten."),
          ]}
        />
      ) : (
        <Steps
          items={[
            t("Ein Terminal öffnen (Mac: Programm „Terminal“)."),
            <>
              {t("„claude“ eintippen und Enter drücken:")} <CommandLine command="claude" />
            </>,
            t("Im Browser mit deinem Claude-Konto anmelden. Danach das Terminal einfach schließen."),
            t("Hier auf „Verbindung testen“ drücken."),
          ]}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => selftest.mutate()} disabled={selftest.isPending}>
          {selftest.isPending ? t("Nyx antwortet gleich …") : t("Verbindung testen")}
        </Button>
        {selftest.data?.ok && <span className="text-callout text-a-ok">{t("Klappt! Nyx hat geantwortet.")}</span>}
      </div>
      {selftest.data && !selftest.data.ok && <ErrorLine text={selftest.data.reason ?? t("Nyx konnte nicht antworten.")} />}
      {selftest.error && <ErrorLine text={friendlyError(selftest.error)} />}
    </Block>
  );
}

function CodexAccount() {
  const setup = useSetupState();
  const installed = setup.data?.tools.codex;
  return (
    <Block
      title={t("Codex")}
      badge={<StatusPill tone="mut">{t("optional")}</StatusPill>}
      status={installed === undefined ? null : installed ? <StatusPill tone="ok">{t("installiert")}</StatusPill> : <StatusPill tone="mut">{t("nicht installiert")}</StatusPill>}
    >
      <p className="text-callout text-a-mut">{t("Nur wichtig, wenn du auch mit Codex (von OpenAI) arbeitest. NyxOS zeigt dann auch diese Sessions. Nyx selbst braucht es nicht.")}</p>
      {installed === false && <CommandLine command="npm install -g @openai/codex" />}
      <p className="text-callout text-a-ink">{t("Anmelden im Terminal:")}</p>
      <CommandLine command="codex login" />
    </Block>
  );
}

function ApiKey({ ai, onSaved }: { ai: OnboardingAiState | undefined; onSaved: (kind: OnboardingProvider) => Promise<void> }) {
  const [kind, setKind] = useState<KeyProvider>("anthropic");
  const [value, setValue] = useState("");
  const save = useSaveAccessKey();
  const [note, setNote] = useState<string | null>(null);
  const state = providerOf(ai, kind);
  const hint = KEY_HINT[kind];
  const submit = async () => {
    setNote(null);
    try {
      const check = await save.mutateAsync({ id: kind as AccessId, value: value.trim() });
      setValue("");
      if (!check.ok) {
        setNote(check.message);
        return;
      }
      await onSaved(kind);
    } catch {
      // Fehler steht in `save.error`
    }
  };
  return (
    <Block
      title={t("API-Schlüssel")}
      status={state?.configured ? state.ok === false ? <StatusPill tone="bad">{t("Prüfung fehlgeschlagen")}</StatusPill> : <StatusPill tone="ok">{t("gespeichert")}</StatusPill> : null}
    >
      <p className="text-callout text-a-mut">
        {t("Ohne Claude-Abo: ein Schlüssel von Anthropic, OpenAI oder OpenRouter (dort gibt es viele Modelle, auch Claude). Du zahlst dann je Nutzung direkt beim Anbieter.")}
      </p>
      <Segmented value={kind} options={KEY_OPTIONS} onChange={setKind} label={t("Anbieter")} />
      <form
        className="grid gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void submit();
        }}
      >
        <label htmlFor="onboarding-key" className={LABEL}>
          {t("Schlüssel")}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="onboarding-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={hint.placeholder}
            className={`${FIELD} min-w-0 flex-1 basis-60 font-mono`}
          />
          <Button variant="primary" type="submit" disabled={!value.trim() || save.isPending}>
            {save.isPending ? t("Prüfe …") : t("Speichern & prüfen")}
          </Button>
        </div>
        <p className="text-caption text-a-mut">
          {t("Zu finden unter:")}{" "}
          <a href={hint.url} target="_blank" rel="noreferrer" className="text-a-acc underline">
            {hint.where}
          </a>
          {" · "}
          {t("Der Schlüssel wird verschlüsselt gespeichert und nie wieder angezeigt.")}
        </p>
      </form>
      <ErrorLine text={note ?? (save.error ? friendlyError(save.error) : null)} />
    </Block>
  );
}

function LocalModel({ ai, onSaved }: { ai: OnboardingAiState | undefined; onSaved: (kind: OnboardingProvider) => Promise<void> }) {
  const save = useSaveAccessKey();
  const [busy, setBusy] = useState<LocalProvider | null>(null);
  const [notes, setNotes] = useState<Partial<Record<LocalProvider, string>>>({});
  const find = async (kind: LocalProvider, url: string) => {
    setBusy(kind);
    setNotes((n) => ({ ...n, [kind]: undefined }));
    try {
      const check = await save.mutateAsync({ id: kind, value: url });
      if (!check.ok) setNotes((n) => ({ ...n, [kind]: check.message }));
      else await onSaved(kind);
    } catch (e) {
      setNotes((n) => ({ ...n, [kind]: friendlyError(e) }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Block title={t("Lokales Modell")} badge={<StatusPill tone="mut">{t("kostenlos")}</StatusPill>}>
      <p className="text-callout text-a-mut">{t("Modelle, die direkt auf deinem Rechner laufen. Nichts verlässt den Rechner – dafür sind sie langsamer und weniger schlau als Claude.")}</p>
      <div className="grid gap-3">
        {LOCAL.map((l) => {
          const st = providerOf(ai, l.kind);
          return (
            <div key={l.kind} className="grid gap-1.5 rounded-lg border border-a-line bg-a-p2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-callout font-medium text-a-ink">{l.label}</span>
                {st?.configured && st.ok && <StatusPill tone="ok">{t("{n} Modelle gefunden", { n: st.models })}</StatusPill>}
                <Button className="ml-auto" onClick={() => void find(l.kind, l.url)} disabled={busy !== null}>
                  {busy === l.kind ? t("Suche …") : t("Suchen & verbinden")}
                </Button>
              </div>
              <p className="text-caption text-a-mut">{l.hint}</p>
              <ErrorLine text={notes[l.kind]} />
            </div>
          );
        })}
      </div>
    </Block>
  );
}

function CostNote({ ai }: { ai: OnboardingAiState | undefined }) {
  const usd = (v: number) => v.toLocaleString(locale(), { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  return (
    <Block title={t("Was kostet das?")}>
      <ul className="grid list-disc gap-1.5 pl-5 text-callout text-a-ink marker:text-a-mut">
        <li>{t("Claude-Konto: keine Extra-Kosten. Nyx nutzt ein schnelles, kleines Modell und zählt zu den Grenzen deines Abos.")}</li>
        <li>{t("API-Schlüssel: du zahlst je Nutzung. Eine Frage an Nyx kostet meist weniger als einen Cent.")}</li>
        <li>{t("Lokales Modell: kostenlos.")}</li>
        {ai && <li>{t("Sicherheitsgrenze: Nyx hört pro Tag bei {budget} auf (änderbar in den Einstellungen).", { budget: usd(ai.budgetUsd) })}</li>}
      </ul>
      <p className="text-callout text-a-mut">
        {t("Nyx arbeitet mit diesem Zugang auch im Hintergrund: ein Briefing am Morgen und ein kurzer Rundgang über deine Sessions. Das kannst du später unter Einstellungen → Nyx ausschalten.")}
      </p>
    </Block>
  );
}

export function StepAi() {
  const ai = useOnboardingAi();
  const info = useAppInfo();
  const use = useUseProvider();
  const [useNote, setUseNote] = useState<string | null>(null);
  const [useError, setUseError] = useState<string | null>(null);

  /** After a successful key/local check: let Nyx run on it (the Claude account keeps priority if it already works). */
  const onSaved = async (kind: OnboardingProvider) => {
    setUseError(null);
    setUseNote(null);
    if (ai.data?.ready && ai.data.via === "claude-cli") {
      setUseNote(t("Gespeichert. Nyx nutzt weiter dein Claude-Konto – umstellen kannst du jederzeit in den Einstellungen unter „Modelle“."));
      return;
    }
    try {
      const r = await use.mutateAsync({ provider: kind });
      setUseNote(t("Nyx nutzt jetzt {label}.", { label: r.label }));
    } catch (e) {
      setUseError(friendlyError(e));
    }
  };

  return (
    <div className="grid gap-5">
      <StepHeader title={t("KI verbinden")} lead={t("Nyx braucht Zugang zu einer KI, um zu antworten und mitzudenken. Wähle einen Weg – einer reicht, du kannst später weitere hinzufügen.")} />
      <StatusBanner ai={ai.data} loading={ai.isLoading} onRecheck={() => void ai.refetch()} rechecking={ai.isFetching} />
      {ai.error && <ErrorLine text={friendlyError(ai.error)} />}
      {useNote && <p className="text-callout text-a-ok">{useNote}</p>}
      <ErrorLine text={useError} />
      <ClaudeAccount ai={ai.data} serverMode={info.data?.mode === "server"} />
      <ApiKey ai={ai.data} onSaved={onSaved} />
      <LocalModel ai={ai.data} onSaved={onSaved} />
      <CodexAccount />
      <CostNote ai={ai.data} />
      {ai.data && !ai.data.ready && ai.data.providers.some((p) => p.configured && p.ok !== false) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-callout text-a-mut">{t("Ein Zugang ist gespeichert, aber Nyx nutzt ihn noch nicht:")}</span>
          {ai.data.providers
            .filter((p) => p.configured && p.ok !== false)
            .map((p) => (
              <Button key={p.kind} onClick={() => void onSaved(p.kind)} disabled={use.isPending}>
                {t("{name} für Nyx nutzen", { name: providerName(p.kind) })}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}

function providerName(kind: OnboardingProvider): string {
  return KEY_OPTIONS.find((o) => o.value === kind)?.label ?? LOCAL.find((l) => l.kind === kind)?.label ?? kind;
}
