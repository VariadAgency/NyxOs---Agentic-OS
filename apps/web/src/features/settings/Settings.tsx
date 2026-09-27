import { t } from "@nyxos/shared";
import { PageShell } from "../../components/PageShell";
import { Card, SectionTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/skeleton";
import { useRules, useSetRuleActive } from "../../hooks/useRules";
// Kontext-Wächter — eigener Abschnitt, Logik in features/context-guard/.
import { ContextGuardSettings } from "../context-guard/ContextGuardSettings";
import { PushSettingsPanel } from "../push/PushSettingsPanel";
import { NightSettingsPanel } from "../night/NightSettingsPanel";
// Nutzung (Standard-Zeitraum, Ziele, Warnschwellen) — dasselbe Formular wie das Blatt im Tab.
import { UsageSettingsSheet } from "../usage/UsageSettingsSheet";
import { AuthSettingsPanel } from "./AuthSettingsPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
// Modelle (Anbieter + Rollen) und Konnektoren (MCP).
import { ConnectorsPanel } from "./ConnectorsPanel";
import { ModelsPanel } from "./ModelsPanel";
// Zugänge (Schlüssel/Tokens als Karten + „Alles auf einmal einrichten“).
import { AccessPanel } from "./access/AccessPanel";
import { SessionStateSettingsPanel } from "./SessionStateSettingsPanel";
import { SettingsTabs } from "./SettingsTabs";
// Wegwerf-Chats – eigener Abschnitt (features/temporary/).
import { TemporarySettingsPanel } from "../temporary/TemporarySettingsPanel";
// Telegram (Bot-Token, Kopplung, Antworten) — features/telegram/.
import { TelegramSettingsPanel } from "../telegram/TelegramSettingsPanel";
// Nyx-Begleiter (an/aus, Zuhören, Vorlesen).
import { NyxCompanionSettings } from "../nyx/NyxCompanionSettings";

const KIND_LABEL: Record<string, string> = { sortierung: t("Sortierung"), reservierung: t("Reservierung"), konflikt: t("Konflikt"), freigabe: t("Freigabe") };

/** Einstellungen → Lernbuch. Jede gelernte Regel mit Herkunft, abschaltbar. */
export function Settings() {
  const { data, isLoading, isError, refetch } = useRules();
  const setActive = useSetRuleActive();

  return (
    <PageShell>
      <SettingsTabs />
      <header className="grid gap-1">
        <h1 className="font-display text-title font-semibold text-a-ink">{t("Einstellungen")}</h1>
      </header>

      {/* Anmeldung ganz oben: der Anmelde-Dialog öffnet sich sonst nur bei einem 401 von selbst,
          so ist der Passkey-Weg immer sichtbar. Ideen-Links haben eine eigene Route
          (`/einstellungen/ideen-links`, s. App.tsx). */}
      <AuthSettingsPanel />
      <NyxCompanionSettings />
      {/* Verbindungs-Prüfung (Ziel des Links in der Statuszeile, `#verbindungen`). */}
      <ConnectionsPanel />
      <AccessPanel />
      <ModelsPanel />
      <ConnectorsPanel />
      <TelegramSettingsPanel />
      <ContextGuardSettings />
      <SessionStateSettingsPanel />
      {/* Ziel der Zugänge-Karte „Push“ (`/settings#push`). */}
      <div id="push" className="scroll-mt-4">
        <PushSettingsPanel />
      </div>
      <UsageSettingsSheet variant="section" />
      <NightSettingsPanel />
      <TemporarySettingsPanel />

      <section className="grid gap-2">
        <SectionTitle>{t("Lernbuch")}</SectionTitle>
        <p className="text-callout text-a-mut">
          {t("Regeln, die NyxOS aus Wiederholungen gelernt hat (z. B. 3 Konflikte in 7 Tagen im selben Ordner). Jede Regel ist abschaltbar — abgeschaltet wirkt sie nicht mehr.")}
        </p>
        {isLoading && <Skeleton className="h-40 w-full" />}
        {isError && (
          <button type="button" onClick={() => void refetch()} className="w-fit rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
            {t("Erneut versuchen")}
          </button>
        )}
        {data && (
          <Card className="grid gap-1 p-2">
            {data.rules.length === 0 && <p className="p-2 text-callout text-a-mut">{t("Noch keine gelernte Regel.")}</p>}
            {data.rules.map((rule) => (
              <div key={rule.id} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 rounded-md px-2 py-2 text-callout hover:bg-a-p2">
                <span className="rounded-full bg-a-p3 px-2 py-0.5 text-label text-a-mut">{KIND_LABEL[rule.kind] ?? rule.kind}</span>
                <div className="min-w-0">
                  <div className="truncate text-a-ink">{typeof rule.action.message === "string" ? rule.action.message : JSON.stringify(rule.action)}</div>
                  <div className="truncate text-label text-a-mut">{rule.origin}</div>
                </div>
                <span className="font-mono text-label text-a-mut">{t("{n} Treffer", { n: rule.hitCount })}</span>
                <label className="flex items-center gap-1.5 text-caption text-a-mut">
                  <input type="checkbox" checked={rule.active} onChange={(e) => void setActive.mutateAsync({ id: rule.id, active: e.target.checked })} />
                  {t("aktiv")}
                </label>
              </div>
            ))}
          </Card>
        )}
      </section>
    </PageShell>
  );
}
