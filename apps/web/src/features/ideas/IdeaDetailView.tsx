// Alte Adresse `/ideas/<id>` (Links aus Suche, Nyx oder Lesezeichen): Ideen öffnen sich in der
// Großansicht der Einträge (`/ideas?e=<id>`). Unbekannte Adressen sagen das ehrlich.
import { t } from "@nyxos/shared";
import { Link, Navigate, useParams } from "react-router";
import { PageShell } from "../../components/PageShell";

export function IdeaDetailView() {
  const { id = "" } = useParams();
  const n = Number(id);
  if (/^\d{1,12}$/.test(id) && Number.isSafeInteger(n) && n > 0) return <Navigate to={`/ideas?e=${n}`} replace />;
  return (
    <PageShell gap="gap-4">
      <div className="cc-card-deep grid gap-2 border border-a-line p-6" data-testid="idea-missing">
        <b className="text-a-ink">{t("Diese Idee gibt es hier nicht (mehr).")}</b>
        <span className="text-callout text-a-mut">{t("Vielleicht stammt der Link aus einer älteren Version. Alle Ideen stehen in der Liste.")}</span>
        <Link to="/ideas" className="w-fit text-caption text-a-acc hover:underline">
          {t("Zur Ideen-Liste")}
        </Link>
      </div>
    </PageShell>
  );
}
