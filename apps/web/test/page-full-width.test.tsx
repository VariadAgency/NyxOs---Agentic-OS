// Volle Breite: Rechts und links von Tabs soll kein leerer Platz bleiben –
// kein Tab kappt seine Breite mehr auf eine schmale Mittelspalte.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageShell } from "../src/components/PageShell";

const PAGE_FILES = [
  "components/PageShell.tsx",
  "features/inbox/InboxView.tsx",
  "features/settings/Settings.tsx",
  "features/settings/nyx/NyxSettingsPage.tsx",
  "features/idealink/IdeaLinksPanel.tsx",
  "features/haiku/HaikuSettingsPanel.tsx",
  "features/haiku/Briefing.tsx",
  "features/agents/AgentsView.tsx",
  "features/usage/UsageView.tsx",
  "features/overview/Overview.tsx",
  "features/tasks/TasksView.tsx",
  "features/ideas/IdeasView.tsx",
  "features/git/Git.tsx",
  "features/conflicts/Conflicts.tsx",
  "features/server/Server.tsx",
  "features/skills/SkillsView.tsx",
];
// Seitenweite Kappen (Spalte in der Mitte, schwarze Ränder links/rechts). Kleine Kappen (Tooltips, Dialoge,
// Textabsätze in Karten) bleiben erlaubt.
const PAGE_CAP = /max-w-\[(?:8[0-9]{2}|9[0-9]{2}|1[0-9]{3})px\]/;

describe("volle Breite auf allen Tabs", () => {
  it("PageShell nutzt die volle Breite (keine Kappe, keine Mittelspalte)", () => {
    const { container } = render(<PageShell>x</PageShell>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toMatch(/max-w-/);
    expect(root.className).not.toMatch(/mx-auto/);
    expect(root.className).toMatch(/\bw-full\b/);
  });

  it.each(PAGE_FILES)("%s kappt die Seite nicht auf eine Mittelspalte", (f) => {
    const src = readFileSync(join(__dirname, "..", "src", f), "utf8");
    const pageCaps = src.split("\n").filter((l) => PAGE_CAP.test(l) && !/max-w-\[(?:62ch|70ch)\]/.test(l));
    // Erlaubt: Lese-Kappen für Fließtext innerhalb einer Karte (Skills-Beschreibung) – nicht auf Seitenebene.
    expect(pageCaps.filter((l) => /mx-auto|PageShell|className="grid w-full/.test(l))).toEqual([]);
  });
});
