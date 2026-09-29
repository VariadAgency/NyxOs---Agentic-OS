// "Wege": computer, browser, phone (ntfy) on/off, Telegram status, test over all channels.
// Taken over from the former push panel; setting up the phone (ntfy target, QR) sits under "Erweitert".
import { t, type NotifySettingsPatch, type NotifySettingsResponse, type PushChannel } from "@nyxos/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { friendlyError } from "../../lib/friendlyError";
import { useTelegramStatus } from "../telegram/api";
import { usePushTest } from "./api";
import { BrowserPermissionRow, BTN, BTN_ACCENT, channelLabel, ResultRow, Section, SwitchRow } from "./parts";

export function NotificationChannels({ data, save, busy }: { data: NotifySettingsResponse; save: (p: NotifySettingsPatch) => void; busy: boolean }) {
  const test = usePushTest();
  const telegram = useTelegramStatus();
  const on = (c: PushChannel) => data.push.channels?.[c] !== false;
  const row = (c: PushChannel, extra?: ReactNode) => (
    <li className="rounded-xl border border-a-line bg-a-p px-3 py-1">
      <SwitchRow title={channelLabel(c).title} hint={channelLabel(c).text} on={on(c)} disabled={busy} testId={`channel-${c}`} onChange={(v) => save({ push: { channels: { [c]: v } } })} />
      {on(c) && extra && <div className="pb-2.5 pl-1">{extra}</div>}
    </li>
  );
  const tg = telegram.data;
  const tgPaired = !!tg?.paired;
  return (
    <Section id="wege" title={t("Wege")} intro={t("Wohin Mitteilungen gehen. Bist du weg, kommt aufs Handy eine gesammelte Mitteilung statt jeder einzeln – Dringendes sofort.")}>
      <ul className="grid gap-1.5">
        {row("mac")}
        {row("browser", <BrowserPermissionRow />)}
        {row(
          "ntfy",
          <a href="#erweitert-iphone" className="inline-flex min-h-11 items-center text-caption text-a-acc underline-offset-2 hover:underline sm:min-h-0">
            {t("Handy einrichten (ntfy, QR-Code) → Erweitert")}
          </a>,
        )}
        <li className="flex min-h-11 flex-col gap-1 rounded-xl border border-a-line bg-a-p px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-callout text-a-ink">Telegram</div>
            <p className="text-caption text-a-mut">
              {telegram.isLoading
                ? t("Lädt …")
                : tgPaired
                  ? t("Gekoppelt mit {name}. Fragen und Freigaben kommen mit Antwort-Knöpfen, wenn du weg bist.", { name: tg?.paired?.name ?? "Telegram" })
                  : t("Nicht gekoppelt. Mit Telegram kannst du Fragen und Freigaben direkt beantworten.")}
            </p>
          </div>
          <Link to="/settings/telegram" state={{ fromParent: true }} data-nyx="settings-sub:telegram" className={cn(BTN, "shrink-0")}>
            {tgPaired ? t("Telegram-Einstellungen") : t("Telegram einrichten")}
          </Link>
        </li>
      </ul>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={test.isPending} onClick={() => test.mutate()} className={cn(BTN, BTN_ACCENT)} data-testid="push-test">
            {test.isPending ? t("Sendet …") : t("Test-Mitteilung senden")}
          </button>
          <span className="text-caption text-a-mut">{t("Geht über alle eingeschalteten Wege, auch in der Ruhezeit.")}</span>
        </div>
        {test.data && test.data.results.length === 0 && <p className="text-caption text-a-wait">{t("Der Server hat keine Rückmeldung je Weg geschickt – bitte am Gerät nachsehen, ob die Mitteilung ankam.")}</p>}
        {test.data && test.data.results.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-a-line bg-a-p2 px-3 py-2" data-testid="push-test-results" aria-live="polite">
            {test.data.results.map((r) => (
              <ResultRow key={r.channel} r={r} />
            ))}
          </ul>
        )}
        {test.isError && <p className="text-caption text-a-bad">{friendlyError(test.error, t("Test hat nicht geklappt – bitte noch einmal versuchen."))}</p>}
      </div>
    </Section>
  );
}
