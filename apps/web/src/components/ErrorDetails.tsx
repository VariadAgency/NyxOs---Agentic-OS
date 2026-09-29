// Der Originaltext eines Fehlers, eingeklappt unter „Details“ — nicht im Blickfeld, aber nicht
// verloren (zur Fehlersuche oder zum Weitergeben an einen Agenten). Leer, wenn es nichts Zusätzliches gibt.
import { t } from "@nyxos/shared";
import { errorDetail } from "../lib/friendlyError";

export function ErrorDetails({ error }: { error: unknown }) {
  const detail = errorDetail(error);
  if (!detail) return null;
  return (
    <details className="w-full min-w-0 text-label text-a-mut">
      <summary className="w-fit cursor-pointer select-none hover:text-a-ink">{t("Details")}</summary>
      <code className="mt-1 block whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">{detail}</code>
    </details>
  );
}
