// Einstellungen → Telegram: Bot-Token eintragen (Geheimnis-Speicher), Zustand (verbunden als @bot /
// wartet auf Token mit Anleitung), Kopplungs-Code (8 Zeichen, 1 h), Entkoppeln, Antwort-Einstellungen.
// Von oben nach unten, alles in einer Spalte (keine gequetschten Spalten).
import { locale, t, tc, timeZone, type TelegramPairingResult, type TelegramStatus, type TelegramVoiceReply } from "@nyxos/shared";
import { useEffect, useState } from "react";
import { SectionTitle } from "../../components/ui/Card";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { tRich } from "../haiku/richText";
import { useCreatePairing, usePatchTelegramSettings, useRemoveTelegramToken, useSaveTelegramToken, useTelegramStatus, useTelegramTest, useUnpairTelegram } from "./api";

const FIELD = "w-full rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5 font-mono text-callout text-a-ink focus:border-a-acc focus:outline-none";
const BTN = "rounded-lg border px-3 py-1.5 font-mono text-caption disabled:opacity-50";
const BTN_MAIN = cn(BTN, "border-a-acc/40 bg-a-acc/10 text-a-acc hover:bg-a-acc/20");
const BTN_SOFT = cn(BTN, "border-a-line bg-a-p2 text-a-mut hover:text-a-ink");
const BTN_BAD = cn(BTN, "border-a-bad/40 bg-a-bad/10 text-a-bad hover:bg-a-bad/20");
const LABEL = "font-mono text-label uppercase tracking-wide text-a-mut";

const VOICE_REPLY_LABEL: Record<TelegramVoiceReply, string> = {
  voice_only: t("Nur wenn ich selbst spreche"),
  always: t("Immer (auch auf Text)"),
  never: t("Nie – nur Text"),
};

function pill(st: TelegramStatus): { text: string; cls: string } {
  if (st.state === "connected" && st.paired) return { text: t("verbunden · gekoppelt"), cls: "border-a-ok/40 bg-a-ok/10 text-a-ok" };
  if (st.state === "connected") return { text: t("verbunden · nicht gekoppelt"), cls: "border-a-wait/40 bg-a-wait/10 text-a-wait" };
  if (st.state === "starting") return { text: t("verbindet …"), cls: "border-a-done/40 bg-a-done/10 text-a-done" };
  if (st.state === "error") return { text: t("Problem"), cls: "border-a-bad/40 bg-a-bad/10 text-a-bad" };
  return { text: t("wartet auf Token"), cls: "border-a-wait/40 bg-a-wait/10 text-a-wait" };
}

const timeFmt = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() });
const dateFmt = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: timeZone() });

function minutesLeft(iso: string | null, now: number): number {
  return iso ? Math.min(60, Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000))) : 0;
}

/** Schritt-für-Schritt: Bot bei @BotFather anlegen. */
function BotFatherGuide() {
  return (
    <ol className="grid list-decimal gap-1 pl-5 font-body text-callout text-a-ink">
      <li>
        {tRich("In Telegram {bot} öffnen und {cmd} schicken.", { bot: <b>@BotFather</b>, cmd: <code className="rounded bg-a-p3 px-1">/newbot</code> })}
      </li>
      <li>{t("Einen Namen wählen (z. B. „Nyx“) und einen Benutzernamen, der auf „bot“ endet (z. B. „mein_nyx_bot“).")}</li>
      <li>
        {tRich("BotFather schickt ein Token in der Form {token} – kopieren.", { token: <code className="rounded bg-a-p3 px-1">123456789:ABC…</code> })}
      </li>
      <li>{t("Unten einfügen und speichern. Danach erzeugst du hier einen Kopplungs-Code.")}</li>
    </ol>
  );
}

function TokenForm({ status }: { status: TelegramStatus }) {
  const save = useSaveTelegramToken();
  const remove = useRemoveTelegramToken();
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(!status.token.set);
  const sourceLabel = status.token.source === "store" ? t("im Schlüssel-Speicher") : status.token.source === "env" ? t("in der Server-.env") : "";

  return (
    <div className="grid gap-2" data-nyx-risk="">
      <span className={LABEL}>{t("Bot-Token")}</span>
      {status.token.set && (
        <div className="flex flex-wrap items-center gap-2 font-body text-callout text-a-ink">
          <span>
            {tRich(sourceLabel ? "Gesetzt {where} · endet auf {last4}" : "Gesetzt · endet auf {last4}", { where: sourceLabel, last4: <span className="font-mono">…{status.token.last4 ?? "????"}</span> })}
          </span>
          {status.token.canEdit && !open && (
            <button type="button" className={BTN_SOFT} onClick={() => setOpen(true)} data-nyx="telegram-token-change">
              {t("Token ändern")}
            </button>
          )}
          {status.token.canEdit && status.token.source === "store" && (
            <button type="button" className={BTN_BAD} disabled={remove.isPending} onClick={() => remove.mutate()} data-nyx="telegram-token-remove">
              {t("Entfernen")}
            </button>
          )}
        </div>
      )}
      {!status.token.canEdit && <p className="rounded-lg border border-a-wait/40 bg-a-wait/10 px-3 py-2 font-body text-callout text-a-wait">{status.token.editHint}</p>}
      {status.token.canEdit && open && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!token.trim()) return;
            save.mutate(token.trim(), {
              onSuccess: () => {
                setToken("");
                setOpen(false);
              },
            });
          }}
        >
          <input
            className={cn(FIELD, "max-w-[460px] flex-1")}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="123456789:ABC…"
            aria-label={t("Bot-Token von BotFather")}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            data-nyx="telegram-token-input"
          />
          <button type="submit" className={BTN_MAIN} disabled={!token.trim() || save.isPending} data-nyx="telegram-token-save">
            {save.isPending ? t("Prüft …") : t("Speichern & verbinden")}
          </button>
        </form>
      )}
      {(save.isError || remove.isError) && <p className="font-body text-caption text-a-bad">{friendlyError(save.error ?? remove.error, t("Das hat nicht geklappt – bitte noch einmal versuchen."))}</p>}
    </div>
  );
}

function Pairing({ status }: { status: TelegramStatus }) {
  const create = useCreatePairing();
  const unpair = useUnpairTelegram();
  const test = useTelegramTest();
  const [code, setCode] = useState<TelegramPairingResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // Gekoppelt → den alten Code nicht weiter zeigen.
  useEffect(() => {
    if (status.paired) setCode(null);
  }, [status.paired]);

  if (status.state !== "connected") return null;
  const locked = status.pairing.lockedUntil;
  const shownCode = code && minutesLeft(code.expiresAt, now) > 0 ? code : null;

  return (
    <div className="grid gap-2" data-nyx-risk="">
      <span className={LABEL}>{t("Kopplung mit deinem Handy")}</span>
      {status.paired ? (
        <div className="grid gap-2">
          <p className="font-body text-callout text-a-ink">
            ✅ {tRich("Gekoppelt mit {name} seit {date}.", { name: <b>{status.paired.name}</b>, date: dateFmt.format(new Date(status.paired.since)) })} {t("Nur dieser Chat darf mit Nyx sprechen – alle anderen werden ignoriert.")}
          </p>
          <p className="font-body text-callout text-a-mut">
            {tRich("Nachrichten gehen gerade an: {target}", { target: <b className="text-a-ink">{status.target.kind === "nyx" ? "Nyx" : t("Session „{title}“", { title: status.target.title })}</b> })}
            {status.talkMode ? ` · 📞 ${t("Sprachmodus an")}` : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN_SOFT} disabled={test.isPending} onClick={() => test.mutate()} data-nyx="telegram-test">
              {test.isPending ? t("Sendet …") : t("Test-Nachricht senden")}
            </button>
            {!confirm ? (
              <button type="button" className={BTN_BAD} onClick={() => setConfirm(true)} data-nyx="telegram-unpair">
                {t("Entkoppeln")}
              </button>
            ) : (
              <span className="flex flex-wrap items-center gap-2 font-body text-callout text-a-ink">
                {t("Wirklich entkoppeln? Danach hört der Bot auf niemanden mehr.")}
                <button type="button" className={BTN_BAD} disabled={unpair.isPending} onClick={() => unpair.mutate(undefined, { onSuccess: () => setConfirm(false) })}>
                  {t("Ja, entkoppeln")}
                </button>
                <button type="button" className={BTN_SOFT} onClick={() => setConfirm(false)}>
                  {t("Abbrechen")}
                </button>
              </span>
            )}
          </div>
          {test.data?.sent && <p className="font-body text-caption text-a-ok">{t("Gesendet – schau in Telegram.")}</p>}
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="font-body text-callout text-a-mut">{t("Erzeuge einen Code und schick ihn deinem Bot. Er gilt 1 Stunde; nach 5 falschen Versuchen ist die Kopplung eine Stunde gesperrt.")}</p>
          {locked && <p className="font-body text-callout text-a-bad">{t("Zu viele falsche Codes – gesperrt bis {time} Uhr.", { time: timeFmt.format(new Date(locked)) })}</p>}
          {shownCode ? (
            <div className="grid gap-2 rounded-xl border border-a-acc/40 bg-a-acc/5 p-3">
              <div className="font-mono text-title tracking-[0.3em] text-a-acc" data-nyx="telegram-pairing-code">
                {shownCode.code}
              </div>
              <p className="font-body text-callout text-a-ink">
                {tRich("Schick dem Bot: {cmd} · gilt noch {m} Min.", { cmd: <code className="rounded bg-a-p3 px-1">/start {shownCode.code}</code>, m: minutesLeft(shownCode.expiresAt, now) })}
              </p>
              {shownCode.link && (
                <a href={shownCode.link} target="_blank" rel="noreferrer" className={cn(BTN_MAIN, "w-fit")} data-nyx="telegram-open-bot">
                  {t("In Telegram öffnen (Code ist schon drin)")}
                </a>
              )}
            </div>
          ) : (
            <button type="button" className={cn(BTN_MAIN, "w-fit")} disabled={create.isPending || !!locked} onClick={() => create.mutate(undefined, { onSuccess: setCode })} data-nyx="telegram-pairing-create">
              {create.isPending ? t("Erzeugt …") : t("Kopplungs-Code erzeugen")}
            </button>
          )}
        </div>
      )}
      {(create.isError || unpair.isError || test.isError) && <p className="font-body text-caption text-a-bad">{friendlyError(create.error ?? unpair.error ?? test.error, t("Das hat nicht geklappt – bitte noch einmal versuchen."))}</p>}
    </div>
  );
}

function ReplySettings({ status }: { status: TelegramStatus }) {
  const patch = usePatchTelegramSettings();
  const s = status.settings;
  const toggles: { key: "echoTranscript" | "notifyApprovals" | "notifySessions" | "respectQuietHours"; label: string }[] = [
    { key: "echoTranscript", label: t("Erkannten Text meiner Sprachnachricht kurz zurückschicken (📝)") },
    { key: "notifyApprovals", label: t("Freigaben als Knöpfe schicken (Freigeben / Ablehnen)") },
    { key: "notifySessions", label: t("Antwort der gewählten Session schicken, wenn sie fertig ist") },
    { key: "respectQuietHours", label: t("Ruhezeit aus „Mitteilungen“ beachten (Dringendes kommt trotzdem)") },
  ];
  return (
    <div className="grid gap-2">
      <span className={LABEL}>{tc("telegram", "Antworten")}</span>
      <label className="grid max-w-[460px] gap-1 font-body text-callout text-a-ink">
        {t("Nyx antwortet auch als Sprachnachricht:")}
        <select className={FIELD} value={s.voiceReply} disabled={patch.isPending} onChange={(e) => patch.mutate({ voiceReply: e.target.value as TelegramVoiceReply })} data-nyx="telegram-voice-reply">
          {(Object.keys(VOICE_REPLY_LABEL) as TelegramVoiceReply[]).map((k) => (
            <option key={k} value={k}>
              {VOICE_REPLY_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <ul className="grid gap-1.5">
        {toggles.map((tg) => (
          <li key={tg.key} className="flex items-center justify-between gap-3 rounded-lg border border-a-line bg-a-p2 px-2.5 py-1.5">
            <span className="font-body text-callout text-a-ink">{tg.label}</span>
            <input type="checkbox" checked={s[tg.key]} disabled={patch.isPending} onChange={(e) => patch.mutate({ [tg.key]: e.target.checked })} aria-label={tg.label} />
          </li>
        ))}
      </ul>
      <p className="font-body text-caption text-a-mut">🎙 {status.voice.sentence}</p>
      <p className="font-body text-caption text-a-mut">
        📞 {t("„Anrufen“: Ein Telegram-Bot kann keine Anrufe annehmen. Stattdessen gibt es im Bot den Knopf „Sprechen“ – dann beantwortet Nyx jede Sprachnachricht sofort, nur mit Stimme.")} {status.miniApp.sentence}
      </p>
    </div>
  );
}

export function TelegramSettingsPanel() {
  const { data: status, isLoading, isError, refetch } = useTelegramStatus();

  return (
    <section id="telegram" className="grid gap-2" aria-labelledby="telegram-settings-title">
      <SectionTitle>
        <span id="telegram-settings-title">Telegram</span>
      </SectionTitle>
      <p className="text-callout text-a-mut">{t("Mit Nyx vom Handy aus sprechen: schreiben, Sprachnachrichten schicken, Sessions wählen und starten, /compact, Freigaben per Knopf.")}</p>
      {isLoading && <div className="font-body text-callout text-a-mut">{t("Lädt …")}</div>}
      {isError && (
        <button type="button" onClick={() => void refetch()} className={cn(BTN_SOFT, "w-fit")}>
          {t("Erneut versuchen")}
        </button>
      )}
      {status && (
        <div className="grid min-w-0 gap-4 rounded-xl border border-a-line bg-a-p p-4" data-nyx="telegram-settings">
          <div className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full border px-2 py-0.5 font-mono text-label", pill(status).cls)}>{pill(status).text}</span>
              <span className="font-body text-callout text-a-ink">{status.sentence}</span>
            </div>
            {status.fix && status.state === "error" && <p className="font-body text-callout text-a-mut">{status.fix}</p>}
          </div>
          {status.state === "no_token" && <BotFatherGuide />}
          <TokenForm status={status} />
          <Pairing status={status} />
          {status.paired && <ReplySettings status={status} />}
        </div>
      )}
    </section>
  );
}
