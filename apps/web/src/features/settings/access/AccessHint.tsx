// Hinweis im Überblick, wenn ein eingetragener Zugang einen Fehler hat – ein Klick öffnet die Zugänge.
// Fehlende Zugänge sind optional und nicht bindend – dafür gibt es keinen Hinweis („6 Zugänge fehlen noch“).
// Was fehlt, steht weiter unter Einstellungen → Zugänge. Ohne Antwort vom Server (oder kein Fehler): nichts anzeigen.
import { ACCESS_ITEMS, t } from "@nyxos/shared";
import { Link } from "react-router";
import { Card } from "../../../components/ui/Card";
import { useAccess } from "./accessApi";

export function AccessHint() {
  const { data } = useAccess();
  if (!data?.items) return null;
  const byId = new Map(data.items.map((s) => [s.id, s]));
  const broken = ACCESS_ITEMS.filter((i) => byId.get(i.id)?.state === "error");
  if (!broken.length) return null;
  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3" data-testid="access-hint">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <b className="text-callout font-semibold text-a-ink">{broken.length === 1 ? t("1 Zugang mit Fehler") : t("{n} Zugänge mit Fehler", { n: broken.length })}</b>
        <span className="truncate text-caption text-a-mut">{broken.map((i) => i.label).join(" · ")}</span>
      </div>
      <Link to="/settings#zugaenge" className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
        {t("Zugänge prüfen →")}
      </Link>
    </Card>
  );
}
