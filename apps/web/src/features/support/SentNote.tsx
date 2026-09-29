// After sending a bug report or an idea: honest about what happened — arrived, or waiting in the outbox (and why).
import { t, type SupportSendResult } from "@nyxos/shared";
import { Button } from "../../components/ui/button";
import { Note } from "./parts";

export function SentNote({ result, configured, onAgain, againLabel }: { result: SupportSendResult; configured: boolean; onAgain: () => void; againLabel: string }) {
  const sent = result.status === "sent";
  return (
    <div className="grid gap-4" data-testid="support-result" data-status={result.status}>
      <Note tone={sent ? "ok" : "wait"} role="status">
        <strong className="font-semibold">{sent ? t("Danke! Deine Meldung ist angekommen.") : t("Gespeichert im Postausgang.")}</strong>
        {sent && result.item.reference && <span className="text-caption text-a-mut">{t("Nummer: {ref}", { ref: result.item.reference })}</span>}
        {result.message && <span>{result.message}</span>}
        {!sent && !result.message && (
          <span>{configured ? t("Die Meldestelle ist gerade nicht erreichbar – die Meldung geht von selbst raus.") : t("Sie geht raus, sobald die Meldestelle eingerichtet ist.")}</span>
        )}
      </Note>
      <Button className="w-fit min-h-11 sm:min-h-9" onClick={onAgain}>
        {againLabel}
      </Button>
    </div>
  );
}
