// Ideen-Liste: Ideen sind normale Einträge (kind „idee“). Ablegen schickt Titel (erste Zeile) + Beschreibung
// an `/api/entries`, Stufen-Filter zählt richtig, „In Aufgaben übernehmen“ nur bei fertigem Konzept.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdeasView } from "../src/features/ideas/IdeasView";
import { splitIdeaText } from "../src/features/ideas/meta";
import { jsonResponse, renderWithClient, stubFetchRoutes } from "./helpers";
import { ideaEntry } from "./ideaFixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view() {
  renderWithClient(
    <MemoryRouter>
      <IdeasView />
    </MemoryRouter>,
  );
}

const IDEAS = [
  ideaEntry({ id: 1, title: "Roh", stage: "eingang" }),
  ideaEntry({ id: 2, title: "Mit Fragen", stage: "in_klaerung" }),
  ideaEntry({ id: 3, title: "Fertiges Konzept", stage: "konzept_fertig", priority: "p1" }),
];

describe("Ideen-Liste", () => {
  it("erste Zeile wird Titel, der Rest Beschreibung", () => {
    expect(splitIdeaText("  Filter nach Wochentag \n\nmit Vorschau ")).toEqual({ title: "Filter nach Wochentag", description: "mit Vorschau" });
    expect(splitIdeaText("Nur ein Titel")).toEqual({ title: "Nur ein Titel" });
    const long = splitIdeaText("x".repeat(250));
    expect(long.title.length).toBeLessThanOrEqual(200);
    expect(long.description).toBe("x".repeat(250));
  });

  it("zeigt alle Stufen, Konzept fertig zuerst, und filtert per Chip", async () => {
    stubFetchRoutes({ entries: () => jsonResponse({ entries: IDEAS }) });
    view();
    const cards = await screen.findAllByTestId("idea-card");
    expect(cards.map((c) => within(c).getByText(/Roh|Mit Fragen|Fertiges Konzept/).textContent)).toEqual(["Fertiges Konzept", "Mit Fragen", "Roh"]);
    expect(screen.getByTestId("stage-in_klaerung")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("stage-eingang"));
    await waitFor(() => expect(screen.getAllByTestId("idea-card")).toHaveLength(1));
    expect(screen.getByText("Roh")).toBeInTheDocument();
  });

  it("„In Aufgaben übernehmen“ nur bei fertigem Konzept und ruft promote", async () => {
    const posts: string[] = [];
    stubFetchRoutes({
      entries: (url, init) => {
        if (init?.method === "POST") {
          posts.push(url);
          return jsonResponse({ entry: { ...IDEAS[2], kind: "aufgabe", stage: "geplant" } });
        }
        return jsonResponse({ entries: IDEAS });
      },
    });
    view();
    const buttons = await screen.findAllByRole("button", { name: "In Aufgaben übernehmen" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(posts).toEqual(["/api/entries/3/promote"]));
    expect(await screen.findByTestId("idea-promoted")).toHaveTextContent("Übernommen");
  });

  it("Idee ablegen schickt kind „idee“ mit Titel und Beschreibung", async () => {
    const bodies: unknown[] = [];
    stubFetchRoutes({
      entries: (url, init) => {
        if (init?.method === "POST" && url === "/api/entries") {
          bodies.push(JSON.parse(String(init.body)));
          return jsonResponse({ entry: ideaEntry({ id: 9, title: "Filter nach Wochentag" }) }, { status: 201 });
        }
        return jsonResponse({ entries: [] });
      },
    });
    view();
    const box = await screen.findByPlaceholderText("Neue Idee – einfach drauflos schreiben …");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "Filter nach Wochentag\nmit Vorschau" } });
    fireEvent.click(screen.getByRole("button", { name: "Idee ablegen" }));
    await waitFor(() => expect(bodies).toEqual([{ kind: "idee", title: "Filter nach Wochentag", description: "mit Vorschau" }]));
  });
});
