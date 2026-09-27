// „Behalten“ bzw. „Zurückholen“ an einer Session (Reiter „Info“). Ohne diesen Knopf verschwand
// eine fälschlich automatisch markierte Session nach X Stunden ohne Ausweg. Behalten sperrt die Automatik.
import { formatRemaining, t, TEMPORARY_REASON_LABEL } from "@nyxos/shared";
import { useId } from "react";
import type { Session } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useSetSessionTemporary } from "./api";
import { useMinuteNow } from "./TempBadge";

export const TEMP_BUTTON =
  "h-7 shrink-0 rounded-md border border-a-temp/50 bg-a-temp/15 px-2.5 text-caption font-semibold text-a-temp hover:bg-a-temp/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc disabled:opacity-50";

type TemporaryFields = Pick<Session, "id" | "temporarySince" | "temporaryReason" | "temporaryExpiresAt" | "archivedAt">;

export function TemporaryControl({ session }: { session: TemporaryFields }) {
  const titleId = useId();
  const now = useMinuteNow();
  const keep = useSetSessionTemporary();
  const archived = !!session.archivedAt;
  if (!archived && !session.temporarySince) return null;

  const why = session.temporaryReason ? TEMPORARY_REASON_LABEL[session.temporaryReason] : null;
  const text = archived
    ? t("Seit {when} aus allen Listen ausgeblendet. Der Verlauf ist vollständig erhalten.", { when: formatDateTime(session.archivedAt ?? null) })
    : session.temporaryExpiresAt
      ? t("Wandert in {left} ohne Aktivität ins Archiv.", { left: formatRemaining(session.temporaryExpiresAt, now) })
      : t("Wandert nach der eingestellten Zeit ohne Aktivität ins Archiv.");

  return (
    <section aria-labelledby={titleId} className="grid gap-1.5 rounded-md border border-a-temp/35 bg-a-temp/10 p-2.5 text-caption text-a-ink">
      <div className="flex items-center gap-2">
        <b id={titleId} className="flex-1 text-a-temp">
          {archived ? t("Im Archiv") : t("⏳ Temporär")}
        </b>
        <button type="button" className={TEMP_BUTTON} disabled={keep.isPending} onClick={() => keep.mutate({ id: session.id, temporary: false })}>
          {archived ? t("Zurückholen") : t("Behalten")}
        </button>
      </div>
      <p className="text-a-mut">
        {text}
        {why && <> {t("Grund: {why}.", { why })}</>}
      </p>
      {keep.isError && <p className="text-a-bad">{t("Das hat nicht geklappt. Bitte noch einmal versuchen.")}</p>}
    </section>
  );
}
