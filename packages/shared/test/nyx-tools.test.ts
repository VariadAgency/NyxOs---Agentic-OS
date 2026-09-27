// Werkzeug-Namen sichtbar machen: eine Zuordnung Werkzeug-ID → einfache deutsche Wörter.
// Leiste, Ausgabe-Feld, Nyx-Tab, Nyx-Zentrum und Telegram zeigen nie rohe IDs wie „server_lage“.
import { describe, expect, it } from "vitest";
import { NYX_TOOL_WORDS, nyxToolDoing, nyxToolName } from "../src/nyx-tools.js";

// Alle Werkzeuge, die der Server Nyx heute gibt (apps/server/src/nyx/tools.ts, routes/haiku.ts).
const SERVER_TOOLS = [
  "auftrag_starten", "briefing_vorlesen", "builds_liste", "eintrag_lesen", "eintrag_suchen", "frage_stellen",
  "freigabe_anfragen", "freigaben_liste", "git_lage", "idee_anlegen", "ideen_suchen", "inbox_liste", "konflikte",
  "lage", "letzte_aktivitaet", "memory", "memory_suggest", "nachtlaeufe", "nutzung", "plan_vorschlagen", "schedule", "screenshot_simulator",
  "server_lage", "session_ergebnisse", "session_lesen", "session_search", "sessions_suchen", "sessions_zaehlen",
  "show_image", "show_link", "telegram", "todo", "ui_click", "ui_navigate", "ui_read_screen", "ui_type", "was_ist_neu",
];

describe("Werkzeug → einfache Wörter", () => {
  it("jedes Server-Werkzeug hat Tätigkeit und Namen, ohne rohe ID", () => {
    for (const id of SERVER_TOOLS) {
      const w = NYX_TOOL_WORDS[id];
      expect(w, id).toBeDefined();
      for (const text of [nyxToolDoing(id), nyxToolName(id)]) {
        expect(text, id).not.toContain("_");
        expect(text, id).not.toContain(id);
        expect(text.length, id).toBeGreaterThan(2);
      }
    }
  });

  it("typische Werkzeuge in Alltagssprache", () => {
    expect(nyxToolDoing("nutzung")).toBe("schaut in die Nutzung");
    expect(nyxToolDoing("server_lage")).toBe("prüft den Server");
    expect(nyxToolDoing("session_ergebnisse")).toBe("fasst eine Session zusammen");
    expect(nyxToolDoing("sessions_suchen")).toBe("sucht Sessions");
    expect(nyxToolName("git_lage")).toBe("Git");
  });

  it("unbekannt: erst ein passendes Stichwort, sonst „arbeitet“ – nie die ID", () => {
    expect(nyxToolDoing("sessions_lesen")).toBe("liest Sessions");
    expect(nyxToolDoing("build_status_neu")).toBe("prüft die Builds");
    expect(nyxToolDoing("frobnicate_xyz")).toBe("arbeitet");
    expect(nyxToolName("frobnicate_xyz")).toBe("Werkzeug");
    expect(nyxToolDoing(null)).toBe("arbeitet");
    expect(nyxToolDoing(undefined)).toBe("arbeitet");
    expect(nyxToolDoing("")).toBe("arbeitet");
  });

  it("Konnektoren (MCP): Name des Konnektors statt der ganzen Kennung", () => {
    expect(nyxToolDoing("mcp__higgsfield__generate_image")).toBe("nutzt Higgsfield");
    expect(nyxToolName("mcp__github__list_issues")).toBe("Github");
  });

  it("keine geerbten Objekt-Schlüssel („constructor“ ist kein Werkzeug)", () => {
    expect(nyxToolDoing("constructor")).toBe("arbeitet");
    expect(nyxToolName("toString")).toBe("Werkzeug");
  });
});
