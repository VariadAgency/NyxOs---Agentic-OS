// Nyx knows all of NyxOS. Regression: „Navigiere mal in Skills und öffne den Skill, der am meisten
// benutzt wurde“ → Nyx: „Es gibt in NyxOS keinen Skill-Tab … Das Konzept ‚Skill‘ passt nicht zu NyxOS.“ – falsch.
// Rot zuerst: Karte vollständig und aktuell, Suche findet Skills/Ruhezeit/Tabelle, die Werkzeugkette Karte → app_api →
// ui_navigate schickt den Klickpfad „nav:skills → Kachel des meistgenutzten Skills“ (kein Routensprung).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNyxosMap, MAP_OUT, renderNyxosMap, REPO_ROOT } from "../../../scripts/nyxos-map.mjs";
import { ToolRegistry, type ToolContext } from "../src/haiku/tools.js";
import { clickPathFor, nyxosMapOverview, registerNyxosMapTool, searchNyxosMap } from "../src/nyx/map/index.js";
import { NYXOS_MAP } from "../src/nyx/map/nyxosMap.generated.js";
import { buildNyxSystemPrompt } from "../src/nyx/prompt.js";
import { NyxUiBridge, registerNyxUiTools } from "../src/nyx/ui.js";

const ctx = { db: null, scope: "full", ideaLink: null, ideas: null, kind: "chat", channel: "web" } as unknown as ToolContext;

describe("Karte automatisch aus dem Code", () => {
  const map = buildNyxosMap(REPO_ROOT);

  it("jede Route, jeder Leisten-Eintrag, jeder Einstellungs-Bereich hat eine Beschreibung", () => {
    expect(map.problems).toEqual([]);
    for (const n of map.nav) expect(n.purpose, `Leiste ${n.id}`).not.toBe("");
    for (const p of map.pages) {
      expect(p.purpose.trim(), `Seite ${p.path}`).not.toBe("");
      expect(p.clickPath.length, `Klickpfad ${p.path}`).toBeGreaterThan(0);
    }
    const app = readFileSync(join(REPO_ROOT, "apps/web/src/App.tsx"), "utf8");
    for (const m of app.matchAll(/<Route path="([^"]+)" element=\{<(?!Navigate)/g)) expect(map.pages.some((p) => p.path === m[1]), `Route ${m[1]}`).toBe(true);
    const sections = readFileSync(join(REPO_ROOT, "apps/web/src/features/settings/sections.tsx"), "utf8");
    for (const m of sections.matchAll(/^ {4}path: "([^"]+)",$/gm)) expect(map.pages.some((p) => p.path === m[1]), `Einstellung ${m[1]}`).toBe(true);
  });

  it("die eingecheckte Karte ist aktuell (sonst: node scripts/nyxos-map.mjs)", () => {
    const committed = readFileSync(join(REPO_ROOT, MAP_OUT), "utf8");
    expect(committed === renderNyxosMap(map), "NyxOS-Karte veraltet – `node scripts/nyxos-map.mjs` ausführen").toBe(true);
  });

  it("enthält Tabellen mit Spalten und API-Wege mit Zweck", () => {
    const pushLog = NYXOS_MAP.tables.find((t) => t.name === "push_log");
    expect(pushLog?.description).toMatch(/Mitteilung/);
    expect(pushLog?.columns.length).toBeGreaterThan(3);
    expect(NYXOS_MAP.api.some((a) => a.path === "/api/skills" && a.method === "GET")).toBe(true);
    expect(NYXOS_MAP.pages.find((p) => p.path === "/skills")?.ids).toContain("skill-<…>");
  });
});

describe("nyxos_karte finds what the user means", () => {
  it("„Skills“ → Seite /skills mit Klickpfad nav:skills, Kachel-Kennung und API", () => {
    const r = searchNyxosMap("Navigiere mal in Skills und öffne den Skill, der am meisten benutzt wurde");
    expect(r.gefunden).toBe(true);
    const first = r.seiten?.[0];
    expect(first?.route).toBe("/skills");
    expect(first?.klickpfad).toEqual(["nav:skills"]);
    expect(first?.kennungen).toContain("skill-<…>");
    expect(first?.api?.join(" ")).toContain("/api/skills");
  });

  it("„wo stelle ich Ruhezeit ein“ → Mitteilungen, genau an die Stelle", () => {
    const first = searchNyxosMap("wo stelle ich Ruhezeit ein").seiten?.[0];
    expect(first?.route).toBe("/settings/mitteilungen#erweitert-ruhezeit");
    expect(first?.klickpfad).toEqual(["nav:settings", "settings:mitteilungen", "#erweitert-ruhezeit"]);
  });

  it("„welche Tabelle speichert Mitteilungen“ → push_log mit Spalten", () => {
    const r = searchNyxosMap("welche Tabelle speichert Mitteilungen");
    expect(r.tabellen?.map((t) => t.name)).toContain("push_log");
  });

  it("englisch: „where are the notification settings“ → Mitteilungen", () => {
    expect(searchNyxosMap("where are the notification settings").seiten?.[0]?.route).toMatch(/^\/settings\/mitteilungen/);
  });

  it("Telegram (Unterseite von Mitteilungen) → Klickpfad über den Eltern-Bereich", () => {
    expect(clickPathFor("/settings/telegram")).toEqual(["nav:settings", "settings:mitteilungen", "settings-sub:telegram"]);
    expect(clickPathFor("/einstellungen/nyx/stimme")).toEqual(["nav:settings", "settings:nyx", "settings:stimme"]);
    expect(clickPathFor("/skills/web%20design")).toEqual(["nav:skills", "skill-web design"]);
  });
});

describe("System-Prompt", () => {
  it("knappe Übersicht aller Tabs + Regel „nie ‚gibt es nicht‘ ohne Karte“", () => {
    const p = buildNyxSystemPrompt({ memoryBlock: "", tools: ["nyxos_karte", "ui_navigate", "ui_click", "ui_type", "ui_read_screen", "app_api"], channel: "web" });
    expect(p).toContain("Skills /skills");
    expect(p).toMatch(/NIE, etwas gebe es in NyxOS nicht/);
    expect(p).not.toMatch(/welche Skills er am meisten nutzt/);
    // Token sparen: die Übersicht bleibt klein.
    expect(nyxosMapOverview().length).toBeLessThan(1400);
  });
});

describe("Skill-Fall als Werkzeugkette (Attrappe)", () => {
  it("Karte → Skill-Nutzung → ui_navigate mit Klickpfad nav:skills → Kachel des meistgenutzten Skills", async () => {
    const sent: Record<string, unknown>[] = [];
    const hub = { size: 1, broadcast: (m: unknown) => void sent.push(m as Record<string, unknown>) };
    const bridge = new NyxUiBridge({ hub, timeoutMs: 300 });
    const reg = new ToolRegistry();
    registerNyxosMapTool(reg);
    registerNyxUiTools(reg, bridge);

    // 1) Karte: gibt es Skills? Ja – Seite, Klickpfad, API-Weg.
    const karte = (await reg.call("full", "nyxos_karte", { frage: "skills" }, ctx)) as ReturnType<typeof searchNyxosMap>;
    expect(karte.seiten?.[0]?.route).toBe("/skills");

    // 2) Daten (app_api-Attrappe, Form wie GET /api/skills): der meistgenutzte Skill.
    const skills = [
      { key: "review", uses: 3 },
      { key: "web-design", uses: 41 },
      { key: "simplify", uses: 12 },
    ];
    const top = [...skills].sort((a, b) => b.uses - a.uses)[0];

    // 3) Hin per Cursor: der Browser bekommt den Klickpfad, nicht nur eine Route.
    const pending = reg.call("full", "ui_navigate", { route: `/skills/${top?.key}` }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0]).toMatchObject({ type: "nyx.ui", action: "navigate", route: "/skills/web-design", via: ["nav:skills", "skill-web-design"] });
    bridge.receive({ type: "nyx.ui.result", requestId: sent[0]?.requestId, ok: true, route: "/skills/web-design" });
    expect(await pending).toMatchObject({ erledigt: true });
  });

  it("briefing_vorlesen geht ebenfalls per Cursor (Klickpfad nav:brief)", async () => {
    const sent: Record<string, unknown>[] = [];
    const bridge = new NyxUiBridge({ hub: { size: 1, broadcast: (m: unknown) => void sent.push(m as Record<string, unknown>) }, timeoutMs: 50 });
    const reg = new ToolRegistry();
    registerNyxUiTools(reg, bridge);
    await reg.call("full", "briefing_vorlesen", {}, ctx);
    expect(sent[0]).toMatchObject({ action: "navigate", route: "/briefing?vorlesen=1", via: ["nav:brief"] });
  });
});
