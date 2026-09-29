// The payment page of the support service, embedded in the sheet. Sandboxed frame; it may only come from the
// support origin (the server checked `embedUrl`, the page's CSP `frame-src` allows only that origin). The page
// reports back with `postMessage` (`nyxos-support:paid` / `:cancelled` / `:resize` / `:error`, docs/support-api.md);
// messages from any other origin or window are ignored (`readSupportEmbedMessage`).
import { readSupportEmbedMessage, t, type SupportDonateResult } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Note } from "./parts";

/** Without a sign of life ("ready") after this long the sheet offers to try again. */
const LOAD_TIMEOUT_MS = 20_000;
const DEFAULT_HEIGHT = 560;

export function DonationFrame({ session, onPaid, onCancel }: { session: SupportDonateResult; onPaid: () => void; onCancel: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = readSupportEmbedMessage(event, { origin: session.origin, source: frame.current?.contentWindow ?? null });
      if (!msg) return;
      if (msg.type === "nyxos-support:ready") setReady(true);
      else if (msg.type === "nyxos-support:resize") setHeight(msg.height);
      else if (msg.type === "nyxos-support:paid") onPaid();
      else if (msg.type === "nyxos-support:cancelled") onCancel();
      else setError(msg.message ?? t("Bei der Bezahlung ist etwas schiefgegangen – es wurde nichts abgebucht."));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [session.origin, onPaid, onCancel]);

  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setSlow(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ready, attempt]);

  return (
    <div className="grid gap-3" data-testid="support-payment">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-a-mut">{t("Gesicherte Bezahlseite von {host}", { host: new URL(session.origin).host })}</p>
        <Button variant="ghost" className="min-h-11 sm:min-h-8" onClick={onCancel}>
          {t("Zurück")}
        </Button>
      </div>
      {error && (
        <Note tone="bad" role="alert">
          {error}
        </Note>
      )}
      {slow && !ready && (
        <Note tone="wait" role="status">
          <span>{t("Die Bezahlseite lädt ungewöhnlich lange.")}</span>
          <Button
            className="w-fit min-h-11 sm:min-h-8"
            onClick={() => {
              setSlow(false);
              setAttempt((n) => n + 1);
            }}
          >
            {t("Neu laden")}
          </Button>
        </Note>
      )}
      <div className="relative overflow-hidden rounded-xl border border-a-line bg-a-p">
        {!ready && (
          <div className="absolute inset-0 grid place-items-center text-caption text-a-mut" aria-hidden="true">
            {t("Bezahlseite lädt …")}
          </div>
        )}
        <iframe
          key={attempt}
          ref={frame}
          title={t("Bezahlseite")}
          src={session.embedUrl}
          // Scripts and forms for the payment provider; its own origin keeps its storage (that is NOT NyxOS' origin);
          // popups only for bank/PayPal confirmations. Never top navigation.
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          allow="payment"
          referrerPolicy="no-referrer"
          // `ready` from the page is better (it knows when the form stands); a finished load counts too.
          onLoad={() => setReady(true)}
          className="relative block w-full border-0 bg-transparent"
          style={{ height }}
        />
      </div>
    </div>
  );
}
