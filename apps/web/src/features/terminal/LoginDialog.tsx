import { t, type AppInfo } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { APP_INFO_KEY } from "../../hooks/useAppInfo";
import { friendlyError } from "../../lib/friendlyError";
import { Button } from "../../components/ui/button";
import { fetchAuthStatus, localhostUrl, LOGIN_EVENT, loginDialogClosed, loginWithPasskey, registerPasskey, type LoginDialogDetail } from "./authClient";

/** Name des Geräts für den neuen Passkey (nur zur Wiedererkennung in den Einstellungen). */
function deviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone/iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return t("Gerät");
}

/**
 * Anmelde-Dialog. Öffnet sich von selbst, sobald eine schreibende Anfrage oder der
 * Terminal-Kanal mit 401 abgelehnt wird — dann als „Bitte anmelden": ein Touch-ID-Knopf,
 * und nach der Anmeldung läuft die wartende Aktion von selbst weiter (`authClient.ensureSignedIn`).
 * Wenn noch kein Passkey existiert bzw. für ein neues Gerät: Einrichtungs-Code (einmalig, 15 Min).
 */
export function LoginDialog() {
  const [open, setOpen] = useState(false);
  const [forAction, setForAction] = useState(false);
  const [hasPasskey, setHasPasskey] = useState<boolean | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDevice, setNewDevice] = useState(false);
  // Local mode: `nyxos open` opens an already signed-in browser – the easiest way back in (app info from the cache, no fetch).
  const localMode = useQueryClient().getQueryData<AppInfo>(APP_INFO_KEY)?.mode === "local";

  useEffect(() => {
    // Von den Einstellungen aus ("Neues Gerät einrichten") trägt das Ereignis ein Detail, das den
    // Dialog direkt im Einrichtungs-Code-Modus öffnet, statt erst beim Passkey-Login-Screen.
    const show = (e: Event) => {
      const detail = (e as CustomEvent<LoginDialogDetail | undefined>).detail;
      setOpen(true);
      setError(null);
      setNewDevice(Boolean(detail?.newDevice));
      setForAction(Boolean(detail?.forAction));
      fetchAuthStatus(true).then(
        (s) => setHasPasskey(s.hasPasskey),
        // Server gerade nicht erreichbar: vom Normalfall ausgehen (Passkey existiert) statt zu hängen.
        () => setHasPasskey((prev) => prev ?? true),
      );
    };
    window.addEventListener(LOGIN_EVENT, show);
    return () => window.removeEventListener(LOGIN_EVENT, show);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) return null;
  const moveTo = localhostUrl();

  function close() {
    setOpen(false);
    loginDialogClosed();
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setOpen(false);
    } catch (e) {
      const msg = friendlyError(e);
      setError(/NotAllowedError|abgebrochen|cancel|not allowed/i.test(msg) ? t("Abgebrochen – bitte noch einmal versuchen.") : msg);
    } finally {
      setBusy(false);
    }
  };

  const title = forAction && !newDevice ? t("Bitte anmelden") : t("Anmelden");

  return (
    <div className="fixed inset-0 z-50 grid place-items-center cc-scrim p-4" role="presentation" data-nyx-risk="" onClick={() => !busy && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
        className="grid w-full max-w-sm gap-3 rounded-2xl border border-a-line bg-a-p2 p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="login-title" className="font-display text-callout font-semibold text-a-ink">
          {title}
        </h2>
        <p className="text-caption text-a-mut">
          {forAction
            ? t("Kurz mit Touch ID bestätigen – danach geht es genau da weiter, wo du warst.")
            : t("Tippen im Terminal und Starten von Sessions bedeutet vollen Zugriff auf deinen Rechner. Dafür bitte kurz mit dem Passkey bestätigen.")}
        </p>
        {localMode && (
          <p className="rounded-lg border border-a-line bg-a-p px-2.5 py-2 text-caption text-a-mut">
            {t("Am einfachsten: im Terminal")} <code className="font-mono text-a-ink">nyxos open</code> {t("eingeben – das öffnet NyxOS gleich angemeldet.")}
          </p>
        )}
        {moveTo ? (
          <div className="grid gap-2 text-caption">
            <p className="text-a-wait">{t("Passkeys funktionieren nicht mit einer IP-Adresse.")}</p>
            <a className="text-a-acc underline" href={moveTo}>
              {t("Hier über „localhost“ öffnen")}
            </a>
          </div>
        ) : hasPasskey === false || newDevice ? (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => registerPasskey(setupCode.trim(), deviceName()));
            }}
          >
            <p className="text-caption text-a-mut">
              {t("Der Einrichtungs-Code verbindet ein neues Gerät mit deinem Passkey. Du bekommst ihn auf einem schon angemeldeten Gerät unter Einstellungen → Anmeldung → „Code erzeugen“; für das allererste Gerät gibt ihn dir Claude.")}
            </p>
            <label className="grid gap-1 text-caption text-a-mut">
              {t("Einrichtungs-Code (einmalig, 15 Min gültig)")}
              <input
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                className="rounded-md border border-a-line bg-a-p2 px-2 py-1.5 font-mono text-caption text-a-ink outline-none focus:border-a-acc"
                autoFocus
              />
            </label>
            <Button variant="primary" type="submit" disabled={busy || setupCode.trim().length < 8}>
              {busy ? t("Warte auf Passkey …") : t("Passkey einrichten")}
            </Button>
            {hasPasskey && (
              <button type="button" className="justify-self-start text-caption text-a-mut underline hover:text-a-ink" onClick={() => setNewDevice(false)}>
                {t("Zurück zur Anmeldung mit Touch ID")}
              </button>
            )}
          </form>
        ) : (
          <>
            <Button variant="primary" onClick={() => void run(loginWithPasskey)} disabled={busy || hasPasskey === null} autoFocus>
              {busy ? t("Warte auf Touch ID …") : t("Mit Touch ID anmelden")}
            </Button>
            <button type="button" className="justify-self-start text-caption text-a-mut underline hover:text-a-ink" onClick={() => setNewDevice(true)}>
              {t("Neues Gerät einrichten (mit Einrichtungs-Code)")}
            </button>
          </>
        )}
        {error && (
          <p role="alert" className="text-caption text-a-bad">
            {error}
          </p>
        )}
        <Button variant="ghost" className="justify-self-end" onClick={close} disabled={busy}>
          {t("Später")}
        </Button>
      </div>
    </div>
  );
}
