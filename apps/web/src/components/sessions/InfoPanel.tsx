import { t, locale } from "@nyxos/shared";
import type { SessionDetail } from "../../lib/api";
import { TemporaryControl } from "../../features/temporary/TemporaryControl";
import { formatDateTime, duration, shortenPath } from "../../lib/format";
import { useSessionContextThresholds } from "../../features/context-guard/api";
import { ContextRing } from "./ContextRing";
import { ChangedFiles } from "../../features/session-panels/ChangedFiles";
import { readableModel } from "../../lib/modelName";

function reasonSentence(detail: SessionDetail): string {
  const last = detail.session.reason.at(-1);
  if (!last) return t("noch nicht eingeordnet");
  return last.detail;
}

const numberFmt = new Intl.NumberFormat(locale());

/** Fakten-Liste der Session (Tokens, Modelle, Dateien, Einsortier-Grund, …). */
export function InfoPanel({ detail }: { detail: SessionDetail }) {
  const { session, files } = detail;
  const written = files.filter((f) => f.mode === "write").length;
  const read = files.filter((f) => f.mode === "read").length;
  const toolCallTotal = Object.values(session.toolCalls).reduce((a, b) => a + b, 0);
  const thresholds = useSessionContextThresholds(session.id, session.models);

  return (
    <div className="grid min-w-0 content-start gap-3">
      <TemporaryControl session={session} />
      {/* `grid-cols-[auto_1fr]` ohne `minmax(0, …)` lässt den Worktree-Pfad
          die ganze Spalte aufreißen (siehe Stack.tsx). */}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-caption">
        <dt className="text-a-mut">{t("Modelle")}</dt>
        <dd className="min-w-0 truncate" title={session.models.join(", ") || undefined}>
          {session.models.length ? session.models.map(readableModel).join(", ") : "–"}
        </dd>
        <dt className="text-a-mut">{t("Tokens")}</dt>
        <dd className="font-mono">{numberFmt.format(session.tokensTotal)}</dd>
        <dt className="text-a-mut">{t("Kontext voll")}</dt>
        <dd className="flex items-center gap-2">
          <ContextRing
            pct={session.contextPct}
            size={26}
            contextWindow={session.contextWindow}
            at={session.lastActivityAt}
            hinweisPct={thresholds?.hinweisPct}
            erzwingenPct={thresholds ? (thresholds.erzwingenEnabled ? thresholds.erzwingenPct : null) : undefined}
          />
          <span className="text-label text-a-mut">
            {session.contextPct === null ? t("unbekannt – für dieses Modell ist keine Fenstergröße bekannt") : t("{n} Tokens Fenster", { n: session.contextWindow?.toLocaleString(locale()) })}
          </span>
        </dd>
        <dt className="text-a-mut">{t("Werkzeug-Aufrufe")}</dt>
        <dd className="font-mono">{numberFmt.format(toolCallTotal)}</dd>
        <dt className="text-a-mut">{t("Sub-Agenten")}</dt>
        <dd className="font-mono">{session.subagents.length}</dd>
        <dt className="text-a-mut">{t("Dateien")}</dt>
        <dd className="font-mono">
          {t("{w} geschrieben · {r} gelesen", { w: written, r: read })}
        </dd>
        <dt className="text-a-mut">{t("Start")}</dt>
        <dd>{formatDateTime(session.startedAt)}</dd>
        <dt className="text-a-mut">{t("Ende")}</dt>
        <dd>{session.status === "running" ? t("läuft noch") : formatDateTime(session.endedAt)}</dd>
        <dt className="text-a-mut">{t("Dauer")}</dt>
        <dd className="font-mono">{duration(session.startedAt, session.status === "running" ? null : session.endedAt)}</dd>
        <dt className="text-a-mut">{t("Worktree")}</dt>
        <dd className="min-w-0 truncate font-mono" title={session.cwd ?? undefined}>
          {session.cwd ? shortenPath(session.cwd) : "–"}
        </dd>
      </dl>
      <div className="rounded-lg border border-a-acc/25 bg-a-acc/8 p-2.5 text-caption text-a-ink">
        {t("einsortiert wegen: {reason}", { reason: reasonSentence(detail) })}
      </div>
      <ChangedFiles detail={detail} />
    </div>
  );
}
