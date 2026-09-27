// „Anmeldung“ — der Anmelde-Dialog öffnet sich sonst nur von selbst (401 auf eine schreibende
// Anfrage). Dieser Abschnitt macht die Anmeldung sichtbar und bedienbar, statt sie erst bei einem
// Fehler zu erklären.
//
// „Code erzeugen" (Einrichtungs-Code für ein weiteres Gerät, nur auf einem angemeldeten
// Gerät und erst nach frischem Touch ID — s. `authClient.createDeviceSetupCode`) und „Überall
// abmelden" (Widerruf aller Sitzungen). Die Erklärung sagt in einem Satz, wofür der Code ist.
import { locale, t, timeZone } from "@nyxos/shared";
import { friendlyError } from "../../lib/friendlyError";
import { useState } from "react";
import { Card, SectionTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { createDeviceSetupCode, localhostUrl, logout, logoutEverywhere, openLoginDialog } from "../terminal/authClient";
import { useAppInfo } from "../../hooks/useAppInfo";
import { useAuthStatus } from "../../hooks/useAuthStatus";
import { PasskeyList } from "./PasskeyList";

const cancelled = (msg: string) => /NotAllowedError|abgebrochen|cancel|not allowed/i.test(msg);

/**
 * Local installation: there is only this computer, sign-in happens through the one-time link of `nyxos open`.
 * Passkeys, setup codes for more devices and the localhost hint belong to server mode.
 */
function LocalAuthPanel() {
  const { data } = useAuthStatus();
  const [busy, setBusy] = useState(false);
  return (
    <section className="grid gap-2">
      <SectionTitle>{t("Anmeldung")}</SectionTitle>
      <Card className="grid gap-2 p-3">
        <div className="flex items-center gap-2 text-callout text-a-ink">
          <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", data?.authenticated ? "bg-a-ok" : "bg-a-idle")} />
          {data?.authenticated ? t("Angemeldet auf diesem Rechner") : t("Nicht angemeldet")}
        </div>
        <p className="text-caption text-a-mut">
          {t("NyxOS läuft nur auf diesem Rechner. Die Anmeldung gilt 30 Tage und verlängert sich, solange du NyxOS nutzt. Abgemeldet? Im Terminal „nyxos open“ eingeben – NyxOS öffnet sich angemeldet.")}
        </p>
        {data?.authenticated && (
          <Button
            variant="ghost"
            className="w-fit"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void logout().finally(() => setBusy(false));
            }}
          >
            {busy ? t("Melde ab …") : t("Abmelden")}
          </Button>
        )}
      </Card>
    </section>
  );
}

export function AuthSettingsPanel() {
  const local = useAppInfo().data?.mode === "local";
  return local ? <LocalAuthPanel /> : <ServerAuthPanel />;
}

function ServerAuthPanel() {
  const { data, isLoading, isError, refetch } = useAuthStatus();
  const [busy, setBusy] = useState<null | "logout" | "logout-all" | "code">(null);
  const [error, setError] = useState<string | null>(null);
  const [setupCode, setSetupCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  const moveTo = localhostUrl();

  const statusText = !data
    ? null
    : data.authenticated
      ? t("Angemeldet auf diesem Gerät")
      : data.hasPasskey
        ? t("Nicht angemeldet – ansehen geht, Aktionen brauchen die Anmeldung")
        : t("Noch kein Passkey eingerichtet");

  const act = async (kind: "logout" | "logout-all" | "code", fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = friendlyError(e);
      setError(cancelled(msg) ? t("Abgebrochen – bitte noch einmal versuchen.") : msg);
    } finally {
      setBusy(null);
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Zwischenablage gesperrt — Code steht ja sichtbar da.
    }
  };

  return (
    <section className="grid gap-2" data-nyx-risk="">
      <SectionTitle>{t("Anmeldung")}</SectionTitle>
      <p className="text-callout text-a-mut">
        {t(
          "Ohne Anmeldung kannst du alles ansehen, aber nichts auslösen (Tippen im Terminal, Sessions starten, Regeln ändern). Die Anmeldung gilt 30 Tage und verlängert sich, solange du NyxOS nutzt. Ein Einrichtungs-Code verbindet ein weiteres Gerät (z. B. iPhone) mit deinem Passkey: Du erzeugst ihn hier auf einem schon angemeldeten Gerät, für das allererste Gerät gibt ihn dir Claude.",
        )}
      </p>
      {moveTo && (
        <p className="text-callout text-a-wait">
          {t("Passkeys funktionieren nicht über die IP-Adresse.")}{" "}
          <a className="text-a-acc underline" href={moveTo}>
            {t("Hier über „localhost“ öffnen")}
          </a>
          .
        </p>
      )}

      {isLoading && <Skeleton className="h-16 w-full" />}
      {isError && !data && (
        <Button onClick={() => void refetch()} className="w-fit">
          {t("Erneut versuchen")}
        </Button>
      )}

      {data && (
        <Card className="grid gap-3 p-3">
          <div className="flex items-center gap-2 text-callout text-a-ink">
            <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", data.authenticated ? "bg-a-ok" : "bg-a-idle")} />
            {statusText}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!data.authenticated && (
              <Button variant="primary" onClick={() => openLoginDialog()}>
                {data.hasPasskey ? t("Anmelden") : t("Passkey einrichten")}
              </Button>
            )}
            {data.authenticated && (
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() =>
                  void act("code", async () => {
                    setSetupCode(await createDeviceSetupCode());
                  })
                }
              >
                {busy === "code" ? t("Warte auf Touch ID …") : t("Code erzeugen")}
              </Button>
            )}
            {data.hasPasskey && (
              <Button variant="ghost" onClick={() => openLoginDialog({ newDevice: true })}>
                {t("Neues Gerät einrichten")}
              </Button>
            )}
            {data.authenticated && (
              <Button variant="ghost" disabled={busy !== null} onClick={() => void act("logout", logout)}>
                {busy === "logout" ? t("Melde ab …") : t("Abmelden")}
              </Button>
            )}
            {data.authenticated && !confirmAll && (
              <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmAll(true)}>
                {t("Überall abmelden")}
              </Button>
            )}
          </div>
          {data.authenticated && confirmAll && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-a-line bg-a-p2 p-2.5 text-caption text-a-ink" role="group" aria-label={t("Überall abmelden bestätigen")}>
              <span>{t("Alle Geräte abmelden, auch dieses? Danach auf jedem Gerät einmal Touch ID.")}</span>
              <Button variant="primary" disabled={busy !== null} onClick={() => void act("logout-all", logoutEverywhere).finally(() => setConfirmAll(false))}>
                {busy === "logout-all" ? t("Melde überall ab …") : t("Ja, überall abmelden")}
              </Button>
              <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmAll(false)}>
                {t("Abbrechen")}
              </Button>
            </div>
          )}
          {setupCode && (
            <div className="grid gap-1.5 rounded-md border border-a-line bg-a-p2 p-2.5" data-testid="setup-code">
              <span className="text-caption text-a-mut">
                {t("Auf dem neuen Gerät NyxOS öffnen → „Neues Gerät einrichten“ → diesen Code eingeben. Gilt 15 Minuten (bis {time} Uhr), nur einmal.", {
                  time: new Date(setupCode.expiresAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: timeZone() }),
                })}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <code className="select-all break-all font-mono text-callout text-a-ink">{setupCode.code}</code>
                <Button variant="ghost" onClick={() => void copy(setupCode.code)}>
                  {copied ? t("Kopiert") : t("Kopieren")}
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-caption text-a-bad">
              {error}
            </p>
          )}
          {data.authenticated && <PasskeyList />}
        </Card>
      )}
    </section>
  );
}
