// Einstellungen → „Info & Hilfe“: App-Name, Version, Betriebsart, Daten-Ordner, Updates (suchen, installieren,
// automatisch), Links zu GitHub, Sprache, eine kleine Hilfe (was NyxOS tut, Befehle, häufige Probleme) und
// „Onboarding erneut starten“. Route `/einstellungen/info`.
import { locale, t, timeZone, type AppInfo } from "@nyxos/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { PageShell } from "../../../components/PageShell";
import { Card, SectionTitle } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { APP_INFO_KEY, useAppInfo, useSaveAppSettings } from "../../../hooks/useAppInfo";
import { cn } from "../../../lib/cn";
import { friendlyError } from "../../../lib/friendlyError";
import { authFetch } from "../../terminal/authClient";
import { CommandLine, StatusPill } from "../../onboarding/ui";
import { clearWizardState } from "../../onboarding/wizardState";
import { SettingsTabs } from "../SettingsTabs";
import { LanguagePanel } from "./LanguagePanel";

async function postInfo(url: string): Promise<AppInfo> {
  const res = await authFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const data = (await res.json().catch(() => null)) as (AppInfo & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? t("Das hat nicht geklappt – bitte noch einmal versuchen."));
  return data as AppInfo;
}

function modeLabel(info: AppInfo): string {
  if (info.demo) return t("Demo (erfundene Beispieldaten)");
  return info.mode === "server" ? t("Server (läuft auf einem eigenen Server)") : t("Lokal (alles auf diesem Rechner)");
}

function when(iso: string | null): string {
  if (!iso) return t("noch nie");
  return new Date(iso).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: timeZone() });
}

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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-callout text-a-mut">{label}</dt>
      <dd className="min-w-0 break-words text-callout text-a-ink">{children}</dd>
    </div>
  );
}

function AboutPanel({ info }: { info: AppInfo }) {
  const qc = useQueryClient();
  const save = useSaveAppSettings();
  const onInfo = (next: AppInfo) => qc.setQueryData(APP_INFO_KEY, next);
  const check = useMutation({ mutationFn: () => postInfo("/api/app/update/check"), onSuccess: onInfo });
  const install = useMutation({ mutationFn: () => postInfo("/api/app/update/install"), onSuccess: onInfo });
  const u = info.update;
  const repoUrl = `https://github.com/${info.repo}`;
  const error = check.error ?? install.error ?? save.error;
  return (
    <section className="grid gap-2">
      <SectionTitle>{t("Über NyxOS")}</SectionTitle>
      <Card className="grid gap-4">
        <dl className="grid gap-2.5">
          <Row label={t("App")}>
            <span className="font-medium">{info.name}</span> <span className="font-mono text-caption text-a-mut">v{info.version}</span>
            {info.demo && (
              <span className="ml-2">
                <StatusPill tone="wait">DEMO</StatusPill>
              </span>
            )}
          </Row>
          <Row label={t("Betriebsart")}>{modeLabel(info)}</Row>
          {info.dataDir && (
            <Row label={t("Daten-Ordner")}>
              <code className="font-mono text-caption">{info.dataDir}</code>
            </Row>
          )}
          <Row label={t("Updates")}>
            <div className="grid gap-1">
              {u.installing ? (
                <StatusPill tone="wait">{t("Update wird installiert …")}</StatusPill>
              ) : u.available && u.latest ? (
                <StatusPill tone="wait">{t("Version {v} ist da", { v: u.latest })}</StatusPill>
              ) : u.latest ? (
                <StatusPill tone="ok">{t("Aktuell")}</StatusPill>
              ) : (
                <StatusPill tone="mut">{t("Noch nicht geprüft")}</StatusPill>
              )}
              <span className="text-caption text-a-mut">{t("Zuletzt geprüft: {when}", { when: when(u.checkedAt) })}</span>
              {u.error && <span className="text-caption text-a-bad">{u.error}</span>}
            </div>
          </Row>
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => check.mutate()} disabled={check.isPending || u.installing}>
            {check.isPending ? t("Suche …") : t("Nach Updates suchen")}
          </Button>
          {u.available && u.canInstall && !info.demo && (
            <Button variant="primary" onClick={() => install.mutate()} disabled={install.isPending || u.installing}>
              {t("Jetzt aktualisieren")}
            </Button>
          )}
        </div>
        {u.available && !u.canInstall && (
          <div className="grid gap-1.5">
            <p className="text-caption text-a-mut">{t("Im Server-Betrieb aktualisierst du auf dem Server:")}</p>
            <CommandLine command="nyxos update" />
          </div>
        )}

        <label className="flex items-center justify-between gap-3 border-t border-a-line pt-3">
          <span className="grid gap-0.5">
            <span className="text-callout text-a-ink">{t("Automatische Updates")}</span>
            <span className="text-caption text-a-mut">{t("Neue Versionen werden von selbst installiert. Aus: NyxOS zeigt nur einen Hinweis.")}</span>
          </span>
          <Toggle on={info.settings.autoUpdate} label={t("Automatische Updates")} onChange={(v) => save.mutate({ autoUpdate: v })} disabled={save.isPending} />
        </label>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-a-line pt-3 text-callout">
          <a className="text-a-acc underline" href={repoUrl} target="_blank" rel="noreferrer">
            {t("GitHub")}
          </a>
          <a className="text-a-acc underline" href={`${repoUrl}/releases`} target="_blank" rel="noreferrer">
            {t("Neuerungen (Releases)")}
          </a>
          <a className="text-a-acc underline" href={`${repoUrl}/issues`} target="_blank" rel="noreferrer">
            {t("Fehler melden (Issues)")}
          </a>
        </div>
        {error && (
          <p role="alert" className="text-caption text-a-bad">
            {friendlyError(error)}
          </p>
        )}
      </Card>
    </section>
  );
}

export const WHAT_NYXOS_DOES: string[] = [
  t("Zeigt alle deine Claude-Code- und Codex-Sessions an einem Ort – live, mit Zustand und Verlauf."),
  t("Sammelt Aufgaben, Ideen und offene Fragen aus deinen Sessions."),
  t("Behält Git, Konflikte und Server im Blick."),
  t("Zeigt, was deine KI-Nutzung kostet und wann Grenzen erreicht sind."),
  t("Nyx, deine Assistentin, fasst zusammen, beantwortet Fragen und bedient NyxOS für dich."),
];

export const NYXOS_COMMANDS: { cmd: string; text: string }[] = [
  { cmd: "nyxos open", text: t("Öffnet NyxOS im Browser – schon angemeldet.") },
  { cmd: "nyxos status", text: t("Zeigt, ob alles läuft.") },
  { cmd: "nyxos restart", text: t("Startet NyxOS und die Brücke neu.") },
  { cmd: "nyxos update", text: t("Holt die neueste Version.") },
  { cmd: "nyxos logs", text: t("Zeigt die letzten Meldungen (für die Fehlersuche).") },
  { cmd: "nyxos doctor", text: t("Prüft deine Einrichtung und sagt, was fehlt.") },
  { cmd: "nyxos demo", text: t("Startet eine Demo mit erfundenen Daten zum Ausprobieren.") },
  { cmd: "nyxos uninstall", text: t("Entfernt NyxOS wieder (fragt vorher nach deinen Daten).") },
];

export const TROUBLESHOOTING: { problem: string; fix: string; cmd?: string }[] = [
  { problem: t("„Brücke offline“"), fix: t("Das Hintergrundprogramm neu starten:"), cmd: "nyxos restart" },
  { problem: t("Es erscheinen keine Sessions"), fix: t("Prüfe unter „Onboarding erneut starten“ → Einrichten, ob deine Projekt-Ordner und die Hooks eingerichtet sind.") },
  { problem: t("Nyx antwortet nicht"), fix: t("Prüfe den KI-Zugang: Einstellungen → Allgemein → Zugänge und Modelle, oder „Verbindung testen“ in der Einrichtung.") },
  { problem: t("Anmeldung vergessen"), fix: t("Im Terminal öffnen – der Browser ist dann gleich angemeldet:"), cmd: "nyxos open" },
];

function HelpPanel({ info }: { info: AppInfo }) {
  const navigate = useNavigate();
  const restart = () => {
    clearWizardState();
    navigate("/onboarding");
  };
  return (
    <section className="grid gap-2">
      <SectionTitle>{t("Hilfe")}</SectionTitle>
      <Card className="grid gap-5">
        <div className="grid gap-2">
          <h3 className="text-headline font-semibold text-a-ink">{t("Was NyxOS macht")}</h3>
          <ul className="grid list-disc gap-1 pl-5 text-callout text-a-ink marker:text-a-mut">
            {WHAT_NYXOS_DOES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>

        <div className="grid gap-2">
          <h3 className="text-headline font-semibold text-a-ink">{t("Wo anfangen?")}</h3>
          <p className="text-callout text-a-mut">
            {t("Starte im Überblick: dort siehst du, was läuft und was auf dich wartet. Mit ⌘K findest du alles, mit ⌘J fragst du Nyx.")}
          </p>
        </div>

        <div className="grid gap-2">
          <h3 className="text-headline font-semibold text-a-ink">{t("Befehle im Terminal")}</h3>
          <dl className="grid gap-1.5">
            {NYXOS_COMMANDS.map((c) => (
              <div key={c.cmd} className="grid gap-0.5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
                <dt>
                  <code className="font-mono text-caption text-a-ink">{c.cmd}</code>
                </dt>
                <dd className="text-callout text-a-mut">{c.text}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="grid gap-2">
          <h3 className="text-headline font-semibold text-a-ink">{t("Wenn etwas nicht klappt")}</h3>
          <ul className="grid gap-2.5">
            {TROUBLESHOOTING.map((p) => (
              <li key={p.problem} className="grid gap-1">
                <span className="text-callout font-medium text-a-ink">{p.problem}</span>
                <span className="text-callout text-a-mut">{p.fix}</span>
                {p.cmd && <CommandLine command={p.cmd} />}
              </li>
            ))}
          </ul>
          <a className="w-fit text-callout text-a-acc underline" href={`https://github.com/${info.repo}/tree/main/docs`} target="_blank" rel="noreferrer">
            {t("Ausführliche Anleitung (docs auf GitHub)")}
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-a-line pt-4">
          <Button onClick={restart}>{t("Onboarding erneut starten")}</Button>
          <span className="text-caption text-a-mut">{t("Geht die Einrichtung noch einmal durch. Deine Daten bleiben.")}</span>
        </div>
      </Card>
    </section>
  );
}

export function InfoPage() {
  const info = useAppInfo();
  return (
    <PageShell>
      <SettingsTabs />
      <header className="grid gap-1">
        <h1 className="font-display text-title font-semibold text-a-ink">{t("Info & Hilfe")}</h1>
      </header>
      {info.isLoading && <Skeleton className="h-48 w-full" />}
      {info.error && (
        <p role="alert" className="text-callout text-a-bad">
          {friendlyError(info.error)}
        </p>
      )}
      {info.data && <AboutPanel info={info.data} />}
      <LanguagePanel />
      {info.data && <HelpPanel info={info.data} />}
    </PageShell>
  );
}
