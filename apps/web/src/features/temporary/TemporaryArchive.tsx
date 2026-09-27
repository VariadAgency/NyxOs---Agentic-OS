// Das Archiv in den Einstellungen – abgelaufene temporäre Sessions ansehen und zurückholen.
// Ohne diese Liste waren archivierte Sessions nur noch über einen alten Link erreichbar.
import { t, TEMPORARY_REASON_LABEL } from "@nyxos/shared";
import { Link } from "react-router";
import { formatDateTime } from "../../lib/format";
import { useSetSessionTemporary, useTemporaryArchive } from "./api";
import { TEMP_BUTTON } from "./TemporaryControl";
import { sessionLabel } from "../../lib/sessionLabel";

export function TemporaryArchive() {
  const archive = useTemporaryArchive();
  const back = useSetSessionTemporary();
  const items = archive.data ?? [];

  return (
    <div className="grid gap-1.5">
      <h4 id="temp-archive-title" className="font-mono text-label font-semibold uppercase tracking-wide text-a-mut">
        {t("Im Archiv")} {archive.data ? `(${items.length})` : ""}
      </h4>
      {archive.isPending && <div className="h-10 animate-pulse rounded-lg bg-a-p2 motion-reduce:animate-none" aria-label={t("Archiv lädt")} />}
      {archive.isError && (
        <p className="text-caption text-a-bad">
          {t("Das Archiv konnte nicht geladen werden.")}{" "}
          <button type="button" className="underline" onClick={() => void archive.refetch()}>
            {t("Erneut versuchen")}
          </button>
        </p>
      )}
      {archive.data && items.length === 0 && <p className="text-caption text-a-mut">{t("Das Archiv ist leer.")}</p>}
      {items.length > 0 && (
        <ul aria-labelledby="temp-archive-title" className="grid max-h-[320px] gap-1 overflow-y-auto rounded-xl border border-a-line bg-a-p p-1.5">
          {items.map((s) => (
            <li key={s.id} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-a-p2">
              <div className="grid min-w-0 flex-1">
                <Link to={s.href} className="truncate text-caption text-a-ink hover:underline">
                  {sessionLabel(s)}
                </Link>
                <span className="truncate text-label text-a-mut">
                  {t("archiviert {when}", { when: formatDateTime(s.archivedAt) })}
                  {s.temporaryReason && ` · ${TEMPORARY_REASON_LABEL[s.temporaryReason]}`}
                </span>
              </div>
              <button
                type="button"
                className={TEMP_BUTTON}
                disabled={back.isPending}
                aria-label={t("Zurückholen: {name}", { name: sessionLabel(s) })}
                onClick={() => back.mutate({ id: s.id, temporary: false })}
              >
                {t("Zurückholen")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {back.isError && <p className="text-caption text-a-bad">{t("Zurückholen hat nicht geklappt. Bitte noch einmal versuchen.")}</p>}
    </div>
  );
}
