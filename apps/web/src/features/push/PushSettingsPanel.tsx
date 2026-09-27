// Mitteilungen — Einstellungen. Drei Wege: Rechner (über die Brücke), Browser (offenes NyxOS-Fenster)
// und Handy (App ntfy). Der Test-Knopf schickt über alle eingeschalteten Wege und zeigt je Weg ✓/✗ mit Grund.
// Das geheime ntfy-Thema kommt nur über `GET /api/push/subscribe` (immer mit Anmeldung), nie über die Einstellungen.
import { friendlyError } from "../../lib/friendlyError";
import { t, type NtfyTarget, type PushChannel, type PushChannelResult, type PushSettings, type PushSubscribeInfo, type PushTestResponse } from "@nyxos/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { authFetch } from "../terminal/authClient";
import { AwaySettingsPanel } from "./AwaySettingsPanel";
import { browserPermission, requestBrowserPermission, type BrowserPermission } from "./browserNotify";

type PublicSettings = Omit<PushSettings, "topic">;
type Patch = Partial<Omit<PublicSettings, "channels" | "enabledKinds">> & { channels?: Partial<Record<PushChannel, boolean>>; enabledKinds?: Partial<PublicSettings["enabledKinds"]> };

const KIND_LABEL: Record<string, string> = {
  session_waiting: t("Session wartet auf dich"),
  session_crashed: t("Session abgestürzt"),
  build_red: t("Build rot"),
  night_run_done: t("Nachtlauf fertig"),
  deploy_failed: t("Deploy fehlgeschlagen"),
  approval_needed: t("Freigabe nötig"),
  context_guard_hinweis: t("Kontext einer Session fast voll"),
  // Warnschwellen der Nutzung (Einstellungen → Nutzung).
  usage_warning: t("Nutzung über Warnschwelle"),
};

const CHANNEL_LABEL: Record<PushChannel, { title: string; text: string }> = {
  mac: { title: t("Rechner"), text: t("Mitteilung oben rechts auf deinem Rechner – kommt über die Brücke, braucht nichts weiter.") },
  browser: { title: t("Browser"), text: t("Mitteilung, solange ein NyxOS-Fenster offen ist (auch am Handy, wenn NyxOS dort offen ist).") },
  ntfy: { title: t("Handy (App ntfy)"), text: t("Mitteilung aufs Handy, auch wenn NyxOS zu ist.") },
};

async function fetchSettings(): Promise<PublicSettings> {
  const res = await fetch("/api/push/settings");
  if (!res.ok) throw new Error(t("Einstellungen konnten nicht geladen werden ({status})", { status: res.status }));
  return res.json();
}

async function patchSettings(patch: Patch): Promise<PublicSettings> {
  const res = await authFetch("/api/push/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(t("Einstellungen konnten nicht gespeichert werden ({status})", { status: res.status }));
  return res.json();
}

async function fetchSubscribe(): Promise<PushSubscribeInfo> {
  const res = await authFetch("/api/push/subscribe");
  if (!res.ok) throw new Error(t("Handy-Daten konnten nicht geladen werden ({status})", { status: res.status }));
  return res.json();
}

async function sendTest(): Promise<PushTestResponse> {
  const res = await authFetch("/api/push/test", { method: "POST", headers: { "content-type": "application/json" } });
  if (!res.ok) throw new Error(t("Test fehlgeschlagen ({status})", { status: res.status }));
  const body = (await res.json().catch(() => null)) as Partial<PushTestResponse> | null;
  // Antwort absichern: fehlt die Liste (z. B. älterer Server), nie abstürzen — nur bekannte Wege mit Text zeigen.
  const results = Array.isArray(body?.results) ? body.results.filter((r): r is PushChannelResult => !!r && r.channel in CHANNEL_LABEL && typeof r.detail === "string") : [];
  return { results };
}

const FIELD = "w-full rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 font-mono text-callout text-a-ink focus:border-a-acc focus:outline-none";
const LABEL = "font-mono text-label uppercase tracking-wide text-a-mut";
const CARD = "min-w-0 space-y-2 rounded-lg border border-a-line bg-a-p2 px-3 py-2.5";
const BTN = "rounded-lg border border-a-line bg-a-p px-3 py-1.5 font-mono text-caption text-a-mut hover:text-a-ink disabled:opacity-50";

function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50", on ? "border-a-acc/60 bg-a-acc/30" : "border-a-line bg-a-p")}
    >
      <span className={cn("absolute top-0.5 h-4.5 w-4.5 rounded-full transition-all", on ? "left-5.5 bg-a-acc" : "left-0.5 bg-a-mut")} />
    </button>
  );
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 break-all rounded bg-a-p px-1.5 py-0.5 font-mono text-callout text-a-ink">{value}</code>
      <button
        type="button"
        className={BTN}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});
        }}
      >
        {copied ? t("Kopiert") : t("Kopieren")}
      </button>
    </span>
  );
}

function BrowserPermissionRow() {
  const [perm, setPerm] = useState<BrowserPermission>(() => browserPermission());
  if (perm === "granted") return <p className="font-body text-caption text-a-ok">{t("Dieser Browser darf Mitteilungen zeigen.")}</p>;
  if (perm === "unsupported") return <p className="font-body text-caption text-a-mut">{t("Dieser Browser kann keine Mitteilungen zeigen. Am iPhone: NyxOS zum Home-Bildschirm hinzufügen und von dort öffnen.")}</p>;
  if (perm === "denied") return <p className="font-body text-caption text-a-bad">{t("Im Browser blockiert. Erlauben über das Schloss-Symbol neben der Adresse → Mitteilungen → Erlauben.")}</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={cn(BTN, "border-a-acc/40 text-a-acc")} onClick={() => void requestBrowserPermission().then(setPerm)}>
        {t("Mitteilungen in diesem Browser erlauben")}
      </button>
      <span className="font-body text-caption text-a-mut">{t("Einmal nötig, sonst bleibt der Browser still.")}</span>
    </div>
  );
}

function IphoneSetup({ target, onTarget, busy }: { target: NtfyTarget; onTarget: (target: NtfyTarget) => void; busy: boolean }) {
  const info = useQuery({ queryKey: ["push-subscribe", target], queryFn: fetchSubscribe });
  const choice = (option: NtfyTarget, label: string) => (
    <button
      type="button"
      disabled={busy}
      aria-pressed={target === option}
      onClick={() => target !== option && onTarget(option)}
      className={cn(BTN, target === option && "border-a-acc/60 bg-a-acc/10 text-a-acc")}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {choice("ntfy_sh", t("Über ntfy.sh (geht sofort, fremder Server)"))}
        {choice("own", t("Eigener Dienst (braucht Tailscale)"))}
      </div>
      {info.isLoading && <p className="font-body text-caption text-a-mut">{t("Lädt …")}</p>}
      {info.isError && <p className="font-body text-caption text-a-bad">{friendlyError(info.error, t("Handy-Daten konnten nicht geladen werden."))}</p>}
      {info.data && (
        <div className="space-y-2">
          {/* ntfy.sh = fremder Server – der Hinweis steht deshalb als Warnung da, nicht grau. */}
          <p className={cn("font-body text-caption", info.data.reachable && info.data.target !== "ntfy_sh" ? "text-a-mut" : "text-a-wait")}>{info.data.note}</p>
          {info.data.reachable && info.data.serverUrl ? (
            <ol className="list-decimal space-y-1.5 pl-5 font-body text-callout text-a-ink">
              <li>{t("App „ntfy“ aus dem App Store laden.")}</li>
              <li>
                {t("In der App auf „+“ tippen, „Anderen Server verwenden“ einschalten und eintragen:")}
                <div className="mt-1">
                  <CopyValue value={info.data.serverUrl} />
                </div>
              </li>
              <li>
                {t("Als Thema eintragen (geheim, nicht weitergeben):")}
                <div className="mt-1">
                  <CopyValue value={info.data.topic} />
                </div>
              </li>
              <li>{t("„Abonnieren“ tippen, Mitteilungen erlauben – dann unten „Test-Mitteilung senden“.")}</li>
            </ol>
          ) : (
            <p className="font-body text-caption text-a-mut">{t("Solange das so ist, kommen Mitteilungen über deinen Rechner und den Browser.")}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ResultRow({ r }: { r: PushChannelResult }) {
  const mark = r.skipped ? "–" : r.ok ? "✓" : "✗";
  return (
    <li className="flex min-w-0 items-start gap-2">
      <span className={cn("w-4 shrink-0 font-mono text-callout", r.skipped ? "text-a-mut" : r.ok ? "text-a-ok" : "text-a-bad")}>{mark}</span>
      <span className="min-w-0 font-body text-callout text-a-ink">
        <span className="font-medium">{CHANNEL_LABEL[r.channel].title}:</span> <span className="text-a-mut">{r.detail}</span>
      </span>
    </li>
  );
}

export function PushSettingsPanel() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({ queryKey: ["push-settings"], queryFn: fetchSettings });
  const [draft, setDraft] = useState<PublicSettings | null>(null);
  const current = draft ?? settings ?? null;

  const save = useMutation({
    mutationFn: patchSettings,
    onSuccess: (next) => {
      qc.setQueryData(["push-settings"], next);
      setDraft(null);
    },
  });
  // Wege + iPhone-Ziel speichern sofort; offene Änderungen an Ruhezeiten usw. bleiben dabei im Entwurf.
  const quick = useMutation({
    mutationFn: patchSettings,
    onSuccess: (next) => {
      qc.setQueryData(["push-settings"], next);
      setDraft((d) => (d ? { ...d, channels: next.channels, ntfyTarget: next.ntfyTarget } : null));
      void qc.invalidateQueries({ queryKey: ["push-subscribe"] });
    },
  });
  const test = useMutation({ mutationFn: sendTest });

  if (isLoading || !current) return <div className="font-body text-callout text-a-mut">{t("Lädt …")}</div>;

  const set = (patch: Partial<PublicSettings>) => setDraft({ ...current, ...patch });
  const toggleKind = (kind: string, value: boolean) => set({ enabledKinds: { ...current.enabledKinds, [kind]: value } });
  const channelOn = (c: PushChannel) => current.channels?.[c] !== false;
  const channelToggle = (c: PushChannel) => (
    <Toggle on={channelOn(c)} label={t("{channel} an/aus", { channel: CHANNEL_LABEL[c].title })} disabled={quick.isPending} onChange={(v) => quick.mutate({ channels: { [c]: v } })} />
  );
  const card = (c: PushChannel, extra?: ReactNode) => (
    <li className={CARD}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display text-callout text-a-ink">{CHANNEL_LABEL[c].title}</div>
          <p className="font-body text-caption text-a-mut">{CHANNEL_LABEL[c].text}</p>
        </div>
        {channelToggle(c)}
      </div>
      {channelOn(c) && extra}
    </li>
  );

  return (
    <section className="min-w-0 space-y-5 rounded-xl border border-a-line bg-a-p p-4">
      <div className="space-y-1">
        <h3 className="font-display text-headline text-a-ink">{t("Mitteilungen")}</h3>
        <p className="font-body text-caption text-a-mut">{t("NyxOS meldet sich, wenn eine Session auf dich wartet, ein Build rot ist oder eine Freigabe nötig ist.")}</p>
      </div>

      <div className="space-y-2">
        <span className={LABEL}>{t("Wege")}</span>
        <ul className="space-y-2">
          {card("mac")}
          {card("browser", <BrowserPermissionRow />)}
          {card("ntfy", <IphoneSetup target={current.ntfyTarget ?? "own"} busy={quick.isPending} onTarget={(target) => quick.mutate({ ntfyTarget: target })} />)}
        </ul>
        {quick.isError && <p className="font-body text-caption text-a-bad">{friendlyError(quick.error, t("Das hat nicht geklappt – bitte noch einmal versuchen."))}</p>}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={test.isPending} onClick={() => test.mutate()} className={cn(BTN, "border-a-acc/40 text-a-acc")}>
            {test.isPending ? t("Sendet …") : t("Test-Mitteilung senden")}
          </button>
          <span className="font-body text-caption text-a-mut">{t("Geht über alle eingeschalteten Wege, auch in der Ruhezeit.")}</span>
        </div>
        {test.data && test.data.results.length === 0 && (
          <p className="font-body text-caption text-a-wait">{t("Der Server hat keine Rückmeldung je Weg geschickt – bitte am Gerät nachsehen, ob die Mitteilung ankam.")}</p>
        )}
        {test.data && test.data.results.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-a-line bg-a-p2 px-3 py-2" data-testid="push-test-results">
            {test.data.results.map((r) => (
              <ResultRow key={r.channel} r={r} />
            ))}
          </ul>
        )}
        {test.isError && <p className="font-body text-caption text-a-bad">{friendlyError(test.error, t("Test hat nicht geklappt – bitte noch einmal versuchen."))}</p>}
      </div>

      {/* Abwesenheit: gebündelt aufs Handy, Fragen über Telegram – eigene Einstellungen, eigenes Speichern. */}
      <AwaySettingsPanel />

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={LABEL}>{t("Ruhezeit Start")}</span>
          <input className={FIELD} type="time" value={current.quietStart} onChange={(e) => set({ quietStart: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>{t("Ruhezeit Ende")}</span>
          <input className={FIELD} type="time" value={current.quietEnd} onChange={(e) => set({ quietEnd: e.target.value })} />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>{t("Bündelung (Sekunden)")}</span>
          <input className={FIELD} type="number" min={0} value={current.bundleWindowSeconds} onChange={(e) => set({ bundleWindowSeconds: Number(e.target.value) })} />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>{t("Wartend melden nach (Sekunden)")}</span>
          <input className={FIELD} type="number" min={0} value={current.waitingAfterSeconds} onChange={(e) => set({ waitingAfterSeconds: Number(e.target.value) })} />
        </label>
      </div>
      <p className="font-body text-caption text-a-mut">{t("In der Ruhezeit bleibt es still – außer bei dringenden Meldungen (Deploy fehlgeschlagen).")}</p>

      <div className="space-y-2">
        <span className={LABEL}>{t("Anlässe")}</span>
        <ul className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
          {Object.entries(KIND_LABEL).map(([kind, label]) => (
            <li key={kind} className="flex items-center justify-between gap-2 rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5">
              <span className="font-body text-callout text-a-ink">{label}</span>
              <input
                type="checkbox"
                checked={(current.enabledKinds as Record<string, boolean>)[kind] !== false}
                onChange={(e) => toggleKind(kind, e.target.checked)}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!draft || save.isPending}
          onClick={() => {
            if (!draft) return;
            // Wege/Ziel speichert `quick` selbst — hier nur die Felder dieses Formulars.
            const { channels: _c, ntfyTarget: _t, ...rest } = draft;
            save.mutate(rest);
          }}
          className={cn("rounded-lg border border-a-acc/40 bg-a-acc/10 px-3 py-1.5 font-mono text-caption text-a-acc", (!draft || save.isPending) && "opacity-50")}
        >
          {save.isPending ? t("Speichert …") : t("Speichern")}
        </button>
        {save.isError && <span className="font-body text-caption text-a-bad">{friendlyError(save.error, t("Das hat nicht geklappt – bitte noch einmal versuchen."))}</span>}
      </div>
    </section>
  );
}
