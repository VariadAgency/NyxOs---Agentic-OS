// „Ohne Baustelle“ erscheint je Art nur einmal (früher doppelt: 1 und 29). Ursache: Gruppierung nach
// (Art, Slug, Label) — eine Session ohne Slug, aber mit altem Label, bildete eine zweite Gruppe.
import { describe, expect, it } from "vitest";
import { sessions } from "../src/db/schema.js";
import { listCategories } from "../src/store.js";
import { setup } from "./helpers.js";

type Row = typeof sessions.$inferInsert;
const row = (id: string, over: Partial<Row> = {}): Row => ({ id: `claude:${id}`, tool: "claude", sessionId: id, machineId: "m1", status: "running", categoryArt: "coding", ...over });

describe("„Ohne Baustelle“ nur einmal je Art", () => {
  it("Sessions ohne Slug mit und ohne Rest-Label landen in EINER Gruppe", async () => {
    const t = await setup();
    await t.db.insert(sessions).values([
      row("a"),
      row("b"),
      row("c", { categoryBaustelleLabel: "Alte Baustelle" }),
      row("d", { categoryBaustelleSlug: "api", categoryBaustelleLabel: "API" }),
    ]);
    const coding = (await listCategories(t.db)).find((c) => c.art === "coding");
    expect(coding?.count).toBe(4);
    expect(coding?.baustellen.filter((b) => b.slug === null)).toEqual([{ slug: null, label: "Ohne Baustelle", count: 3 }]);
    expect(coding?.baustellen.filter((b) => b.slug === "api")).toEqual([{ slug: "api", label: "API", count: 1 }]);
  });
});
