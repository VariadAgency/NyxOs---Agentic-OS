// Fehler beim Laden eines Ordners. Fragt macOS gerade, ob NyxOS den Ordner lesen
// darf, steht hier ein verständlicher Satz mit „Erneut versuchen“, und der Finder versucht es alle 5 s selbst
// (höchstens 2 Min) — nach dem Klick auf „Erlauben“ erscheint die Liste ohne weiteres Zutun.
import { FINDER_ERR, finderPermissionText, t } from "@nyxos/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { FinderApiError } from "./api";
import { errorText } from "./hooks";

const RETRY_EVERY_MS = 5_000;
const RETRY_FOR_MS = 120_000;

export function isMacPermissionError(e: unknown): boolean {
  return e instanceof FinderApiError && e.code === FINDER_ERR.macosPermission;
}

export function ListError({ error, label, onRetry, compact = false }: { error: unknown; label: string; onRetry: () => void; compact?: boolean }) {
  if (!isMacPermissionError(error)) {
    return <p className={compact ? "px-3 py-2 text-caption text-a-mut" : "p-6 text-center text-callout text-a-mut"}>{errorText(error)}</p>;
  }
  return <PermissionWait error={error} label={label} onRetry={onRetry} compact={compact} />;
}

function PermissionWait({ error, label, onRetry, compact }: { error: unknown; label: string; onRetry: () => void; compact: boolean }) {
  const [since, setSince] = useState(() => Date.now());
  const [gaveUp, setGaveUp] = useState(false);
  const retry = useRef(onRetry);
  useEffect(() => {
    retry.current = onRetry;
  });

  useEffect(() => {
    if (gaveUp) return;
    const iv = setInterval(() => {
      if (Date.now() - since >= RETRY_FOR_MS) {
        setGaveUp(true);
        return;
      }
      retry.current();
    }, RETRY_EVERY_MS);
    return () => clearInterval(iv);
  }, [since, gaveUp]);

  const again = () => {
    setSince(Date.now());
    setGaveUp(false);
    onRetry();
  };
  // Der Server reicht den Satz der Brücke durch; fehlt er, sagt die Oberfläche dasselbe.
  const text = error instanceof Error && error.message.startsWith("macOS") ? error.message : finderPermissionText(label);

  return (
    <div role="status" className={cn("rounded-lg border border-a-wait/40 bg-a-wait/10 text-a-ink", compact ? "m-2 space-y-2 p-2 text-caption" : "mx-auto my-6 max-w-[460px] space-y-3 p-4 text-callout")}>
      <p>{text}</p>
      {gaveUp && <p className="text-caption text-a-mut">{t("Ich versuche es nicht mehr von selbst. Nach dem Erlauben bitte auf „Erneut versuchen“ tippen.")}</p>}
      <button type="button" onClick={again} className="inline-flex h-(--a-ctl-h) items-center rounded-lg border border-a-acc/50 bg-a-acc/10 px-3 text-caption font-medium text-a-acc hover:bg-a-acc/20">
        {t("Erneut versuchen")}
      </button>
    </div>
  );
}
