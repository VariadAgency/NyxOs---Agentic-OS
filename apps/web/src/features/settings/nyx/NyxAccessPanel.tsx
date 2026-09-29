// Einstellungen → Nyx → Zugriff & Freigaben. Explains in three levels what Nyx may do in NyxOS (Nyx operates
// everything; the confirm list only after „Ausführen“; sign-in and keys never). The rules themselves live on the
// server (`apps/server/src/nyx/appApi/rules.ts`) – nothing to switch here, only to understand. If that table changes,
// update these lists too.
import { t } from "@nyxos/shared";
import { Link } from "react-router";

const LEVELS: { id: string; title: string; dot: string; text: string; items: string[] }[] = [
  {
    id: "direkt",
    title: t("Macht Nyx direkt"),
    dot: "bg-a-ok",
    text: t("Alles, was du in NyxOS auch klicken kannst – im Browser, per Stimme und aus Telegram."),
    items: [t("Seiten öffnen, suchen, vorlesen"), t("Sessions starten und Nachrichten schicken"), t("Aufgaben und Ideen anlegen"), t("Einstellungen ändern – außer Budget und allem mit Schlüsseln"), t("Eine Fehlermeldung oder Idee vorbereiten")],
  },
  {
    id: "freigabe",
    title: t("Nur nach deinem „Ausführen“"),
    dot: "bg-a-wait",
    text: t("Nyx legt dir eine Karte hin und wartet – ohne deinen Tipp passiert nichts."),
    items: [
      t("Löschen"),
      t("Session beenden, schließen oder übernehmen"),
      t("Freigaben, Entscheidungen, Konflikte"),
      t("Nyx-Budget und Grenzen ändern"),
      t("Aufträge autonom starten, Dateien speichern, Einrichtung ändern"),
      t("Fehlermeldung oder Idee an den Entwickler senden"),
    ],
  },
  {
    id: "nie",
    title: t("Fasst Nyx nie an"),
    dot: "bg-a-bad",
    text: t("Das bleibt immer bei dir, auch wenn du Nyx ausdrücklich darum bittest."),
    items: [t("Anmeldung und Passkeys"), t("Schlüssel und Tokens (Zugänge, Anbieter, Konnektoren)"), t("Telegram-Kopplung"), t("Ideen-Links"), t("Spenden und wohin Meldungen gehen"), t("Eine Shell auf dem Server")],
  },
];

export function NyxAccessPanel() {
  return (
    <div className="grid min-w-0 gap-3">
      {LEVELS.map((l) => (
        <section key={l.id} aria-labelledby={`nyx-zugriff-${l.id}`} className="grid min-w-0 gap-2 rounded-xl border border-a-line bg-a-p p-4">
          <h2 id={`nyx-zugriff-${l.id}`} className="flex items-center gap-2 font-display text-headline text-a-ink">
            <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${l.dot}`} />
            {l.title}
          </h2>
          <p className="text-caption text-a-mut">{l.text}</p>
          <ul className="grid gap-1 text-callout text-a-ink">
            {l.items.map((i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="text-a-mut">
                  ·
                </span>
                {i}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="text-caption text-a-mut">
        {t("Wartende Karten findest du unter")}{" "}
        <Link to="/inbox" className="text-a-acc underline-offset-2 hover:underline">
          {t("Entscheidungen")}
        </Link>
        .
      </p>
    </div>
  );
}
