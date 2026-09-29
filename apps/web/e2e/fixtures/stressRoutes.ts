// Leitet die Konflikt-Aufrufe der Seite auf eine künstliche Kollisionskarte um (Stresstest).
// Neue Schnittstelle (Zusammenfassung + Seiten) über DIESELBE reine Funktion wie der Server
// (`buildConflictModel`/`queryConflictEntries`) — keine zweite Nachbildung.
import type { CollisionEntry } from "@nyxos/shared";
import type { Page } from "@playwright/test";
import { buildConflictModel, queryConflictEntries } from "../../../../packages/shared/src/conflicts-model";

export async function stressRoutes(page: Page, map: CollisionEntry[]): Promise<void> {
  const generatedAt = new Date().toISOString();
  const model = buildConflictModel({ map, reservations: [], dismissals: new Map(), sessions: new Map(), version: "stress", generatedAt, bridgeOnline: true });
  // Ältere Schnittstelle: die ganze Karte auf einmal.
  await page.route(/\/api\/conflicts$/, (route) => route.fulfill({ json: { collisionMap: map, reservations: [], generatedAt } }));
  await page.route(/\/api\/conflicts\/summary/, (route) => route.fulfill({ json: model.summary }));
  await page.route(/\/api\/conflicts\/entries/, (route) => {
    const u = new URL(route.request().url());
    const q = (k: string) => u.searchParams.get(k);
    route.fulfill({ json: queryConflictEntries(model, { group: q("group"), q: q("q"), path: q("path"), offset: Number(q("offset") ?? 0), limit: Number(q("limit") ?? 50) }) });
  });
}
