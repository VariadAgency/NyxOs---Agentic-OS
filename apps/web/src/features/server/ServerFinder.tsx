// „Dateien auf dem Server“ — derselbe Finder wie im Dateien-Tab (Symbole/Liste/Spalten/Galerie, Sortieren,
// Versteckte, Suche, Vorschau, Übersicht mit Leertaste, Enter öffnet), nur mit der Server-Quelle
// (finder/serverSource.ts, NUR LESEN) und eigenem Verlauf statt der Adresse (die Seite gehört dem Server-Tab).
import { t } from "@nyxos/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Card } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/skeleton";
import { FinderBrowser } from "../finder/FinderView";
import { errorText, useRoots } from "../finder/hooks";
import { useMemoryNav } from "../finder/nav";
import { FinderSourceProvider, useFinderSource } from "../finder/source";
import { authFetch } from "../terminal/authClient";
import { createServerSource } from "./finder/serverSource";

export function ServerFinder() {
  const client = useQueryClient();
  const source = useMemo(
    () =>
      createServerSource(() => {
        // Anmelde-Dialog über authFetch, danach alles neu laden.
        void authFetch("/api/server/files/roots")
          .then(() => client.invalidateQueries({ queryKey: ["server-finder"] }))
          .catch(() => undefined);
      }),
    [client],
  );
  return (
    <FinderSourceProvider source={source}>
      <ServerFinderFrame />
    </FinderSourceProvider>
  );
}

function ServerFinderFrame() {
  const src = useFinderSource();
  const roots = useRoots();
  const nav = useMemoryNav();

  if (roots.isLoading) return <Skeleton className="h-[min(78vh,760px)] w-full rounded-xl" />;
  if (roots.error) {
    const login = src.isLoginError(roots.error);
    return (
      <Card className="flex flex-wrap items-center justify-between gap-2 text-callout text-a-mut">
        <span>{login ? src.loginText : errorText(roots.error)}</span>
        {login && (
          <button type="button" onClick={src.login} className="rounded-md border border-a-line px-3 py-1.5 text-caption text-a-ink hover:bg-a-p2">
            {t("Anmelden")}
          </button>
        )}
      </Card>
    );
  }
  if (!(roots.data?.roots ?? []).some((r) => r.exists)) {
    return <Card className="text-callout text-a-mut">{t("Noch keine Server-Ordner eingehängt. Der nächste Deploy hängt Home, /srv, /opt und /var/log nur lesend ein.")}</Card>;
  }
  return (
    <div data-testid="server-finder" className="h-[min(78vh,760px)] min-h-[480px] overflow-hidden rounded-xl border border-a-line bg-a-bg">
      <FinderBrowser nav={nav} />
    </div>
  );
}
