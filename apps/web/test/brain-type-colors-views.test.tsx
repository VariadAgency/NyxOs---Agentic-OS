// Gehirn: Farben je Art als Standard, Notiz-Kategorien, Ansichten/eigenes Gehirn je Session.
import type { GraphLink, GraphNode } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { colorKeyOf, DEFAULT_COLORS, familyOf, groupColor, hexToRgb, leavesOf, NOTE_CATEGORIES, nodeColor, noteCategory, SHARED_COLOR_PAIRS, type ColorKey } from "../src/features/brain/colors";
import { computeView } from "../src/features/brain/filter";
import { defaultSettings, loadSettings, saveSettings, type BrainSettings } from "../src/features/brain/settings";
import { applyPreset, applySavedView, PRESETS, sessionBrain, snapshotView } from "../src/features/brain/views";

const note = (path: string | null, over: Partial<GraphNode> = {}): GraphNode => ({
  id: `note:${path ?? "?x"}`,
  type: "note",
  label: path ?? "x",
  group: path?.includes("/") ? (path.split("/")[0] ?? "") : "(Wurzel)",
  degree: 1,
  ref: { kind: "note", path },
  ...over,
});

// --- Farbmathe für den Palettentest (CIEDE2000) -----------------------------------------------
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function lab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => lin(v / 255)) as [number, number, number];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function de2000([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
  const rad = Math.PI / 180;
  const [l1, l2, A1, A2, B1, B2] = [L1 ?? 0, L2 ?? 0, a1 ?? 0, a2 ?? 0, b1 ?? 0, b2 ?? 0];
  const Cm = (Math.hypot(A1, B1) + Math.hypot(A2, B2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = A1 * (1 + G);
  const a2p = A2 * (1 + G);
  const C1p = Math.hypot(a1p, B1);
  const C2p = Math.hypot(a2p, B2);
  const h = (bb: number, aa: number) => {
    const v = Math.atan2(bb, aa) / rad;
    return v < 0 ? v + 360 : v;
  };
  const h1p = h(B1, a1p);
  const h2p = h(B2, a2p);
  let dh = h2p - h1p;
  if (C1p * C2p === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh * rad) / 2);
  const Lm = (l1 + l2) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hm += h1p + h2p < 360 ? 360 : -360;
    hm /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTh = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const SC = 1 + 0.045 * Cmp;
  const SH = 1 + 0.015 * Cmp * T;
  const RT = -Math.sin(2 * dTh * rad) * RC;
  const dC = C2p - C1p;
  return Math.sqrt(((l2 - l1) / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => lin(v / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("Farbe je Art ist Standard", () => {
  it("colorByType ist in der Vorgabe an", () => {
    expect(defaultSettings().colorByType).toBe(true);
  });

  it("alte gemerkte Einstellungen (v1, colorByType=false) werden auf Farbe umgestellt, eigene Farben bleiben", () => {
    const old = { ...defaultSettings(), colorByType: false, schema: undefined } as unknown as BrainSettings;
    const store = new Map<string, string>([["nyxos.brain.settings.v1", JSON.stringify(old)]]);
    const loaded = loadSettings({ getItem: (k: string) => store.get(k) ?? null });
    expect(loaded.colorByType).toBe(true);
    // Nach dem Umstellen darf man es selbst wieder ausschalten (bleibt dann aus).
    const saved = new Map<string, string>();
    saveSettings({ ...loaded, colorByType: false, colors: { session: "#ff0000" } }, { setItem: (k: string, v: string) => void saved.set(k, v) });
    const again = loadSettings({ getItem: (k: string) => saved.get(k) ?? null });
    expect(again.colorByType).toBe(false);
    expect(again.colors.session).toBe("#ff0000");
  });

  it("Obsidian-Notizen bekommen ihre Kategorie aus dem Ordner", () => {
    const cases: Array<[string | null, string]> = [
      ["02 Code/Views/HomeView.md", "code"],
      ["04 Planung/07c_API_Design/Endpoints.md", "planung"],
      ["04 Planung/Entscheidungen/2026-09-01 Mapbox.md", "entscheidung"],
      ["05 Bugs & Fixes/Crash beim Start.md", "bugs"],
      ["03 Architektur/Schichten.md", "architektur"],
      ["04_StateManagement/Store.md", "architektur"],
      ["01 Sessions/2026-09-24 Gehirn.md", "sessions"],
      ["26_Endpoints/GET events.md", "schnittstellen"],
      ["33_MCPServer/Tools.md", "schnittstellen"],
      ["04_DataPoints/Heatmap.md", "daten"],
      ["25_UserInteractions/Like.md", "daten"],
      ["27_Screens/Home.md", "screens"],
      ["32_Audit/Befund 1.md", "audit"],
      ["06 Dokumentation/Setup.md", "doku"],
      ["Willkommen.md", "doku"],
    ];
    for (const [path, cat] of cases) expect([path, noteCategory(note(path))]).toEqual([path, cat]);
    expect(noteCategory(note(null, { state: "unresolved", group: "(nicht erstellt)" }))).toBe("offen");
    expect(colorKeyOf(note("02 Code/a.md"))).toBe("note.code.weitere"); // Code nach Unterordner
    expect(colorKeyOf({ type: "session", group: "coding", ref: { kind: "art", art: "coding" } })).toBe("session");
  });

  it("jede Kategorie-Farbe ist bunt: kein Grau, Weiß oder Schwarz, gut lesbar auf dunklem Grund", () => {
    const bg = luminance("#050505");
    for (const [key, hex] of Object.entries(DEFAULT_COLORS)) {
      const [, a, b] = lab(hex);
      const chroma = Math.hypot(a, b);
      const contrast = (luminance(hex) + 0.05) / (bg + 0.05);
      expect({ key, bunt: chroma >= 25, lesbar: contrast >= 4.5 }).toEqual({ key, bunt: true, lesbar: true });
    }
    for (const c of NOTE_CATEGORIES) for (const k of leavesOf(`note.${c}`)) expect(DEFAULT_COLORS[k]).toBeDefined();
  });

  it("Palette ist unterscheidbar (ΔE2000 ≥ 9 je Paar, außer bewusst gleichen Bedeutungen; Töne einer Familie ≥ 6)", () => {
    const shared = new Set(SHARED_COLOR_PAIRS.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
    const keys = Object.keys(DEFAULT_COLORS) as ColorKey[];
    const tooClose: string[] = [];
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i] as ColorKey;
        const b = keys[j] as ColorKey;
        if (shared.has(`${a}|${b}`)) continue;
        const d = de2000(lab(DEFAULT_COLORS[a]), lab(DEFAULT_COLORS[b]));
        if (d < (familyOf(a) === familyOf(b) ? 6 : 9)) tooClose.push(`${a}/${b} ${d.toFixed(1)}`);
      }
    expect(tooClose).toEqual([]);
  });

  it("eigene Farbe je Gruppe (Farbwähler) gewinnt, kaputte Werte fallen auf die Vorgabe zurück", () => {
    const n = note("02 Code/a.md");
    expect(nodeColor(n, true, {})).toBe(DEFAULT_COLORS["note.code.weitere"]);
    expect(nodeColor(n, true, { "note.code.weitere": "#FF8800" })).toBe("#ff8800");
    expect(groupColor("session", { session: "rot" })).toBe(DEFAULT_COLORS.session);
    // Aus = eine Einheitsfarbe, aber auch dann kein Grau
    const [, a, b] = lab(nodeColor(n, false, {}));
    expect(Math.hypot(a, b)).toBeGreaterThan(25);
  });
});

// --- Ansichten -------------------------------------------------------------------------------
const nodes: GraphNode[] = [
  note("02 Code/A.md"),
  note("04 Planung/P.md"),
  { id: "session:claude:s1", type: "session", label: "S1", group: "coding", degree: 3, state: "running", ref: { kind: "session", sessionKey: "claude:s1", sessionId: "s1", tool: "claude", art: "coding", baustelleSlug: "b1" } },
  { id: "session:claude:s2", type: "session", label: "S2", group: "coding", degree: 2, state: "idle", ref: { kind: "session", sessionKey: "claude:s2", sessionId: "s2", tool: "claude", art: "coding", baustelleSlug: "b1" } },
  { id: "session:claude:s3", type: "session", label: "S3", group: "coding", degree: 1, state: "idle", ref: { kind: "session", sessionKey: "claude:s3", sessionId: "s3", tool: "claude", art: "coding", baustelleSlug: null } },
  { id: "subagent:x", type: "subagent", label: "Sub", group: "coding", degree: 1, ref: { kind: "session", sessionKey: "claude:x", sessionId: "x", tool: "claude", art: "coding", baustelleSlug: "b1" } },
  { id: "baustelle:b1", type: "baustelle", label: "B1", group: "b1", degree: 2, ref: { kind: "baustelle", slug: "b1" } },
  { id: "art:coding", type: "art", label: "Coding", group: "coding", degree: 3, ref: { kind: "art", art: "coding" } },
  { id: "commit:r:abc", type: "commit", label: "fix", group: "r", degree: 1, ref: { kind: "commit", sha: "abc", repo: "r" } },
  { id: "file:/a.ts", type: "file", label: "a.ts", group: "src", degree: 1, ref: { kind: "file", path: "/a.ts" } },
];
const L = (source: string, target: string, kind: GraphLink["kind"]): GraphLink => ({ source, target, kind, weight: 1 });
const links: GraphLink[] = [
  L("session:claude:s1", "baustelle:b1", "baustelle"),
  L("session:claude:s2", "baustelle:b1", "baustelle"),
  L("session:claude:s1", "art:coding", "art"),
  L("session:claude:s2", "art:coding", "art"),
  L("session:claude:s3", "art:coding", "art"),
  L("session:claude:s1", "subagent:x", "parent"),
  L("session:claude:s1", "commit:r:abc", "commit"),
  L("session:claude:s1", "note:04 Planung/P.md", "note_session"),
  L("note:04 Planung/P.md", "note:02 Code/A.md", "wikilink"),
  L("session:claude:s2", "file:/a.ts", "touched_file"),
];
const visible = (s: BrainSettings) => {
  const v = computeView(nodes, links, s);
  return nodes.filter((n) => !v.hidden.has(n.id)).map((n) => n.id);
};

describe("mehrere Gehirne", () => {
  it("Vorgefertigte Ansichten gibt es als Knöpfe", () => {
    expect(PRESETS.map((p) => p.label)).toEqual(["Alles", "Nur Code", "Planung/Obsidian", "Sessions & Agenten", "Pro Baustelle"]);
  });

  it("„Nur Code“ zeigt Code-Notizen, Commits — keine Planung, keine Sessions", () => {
    const s = applyPreset(defaultSettings(), "code");
    expect(s.activeView).toBe("code");
    const ids = visible(s);
    expect(ids).toContain("note:02 Code/A.md");
    expect(ids).toContain("commit:r:abc");
    expect(ids).not.toContain("note:04 Planung/P.md");
    expect(ids).not.toContain("session:claude:s1");
  });

  it("„Alles“ ist eine Obermenge jeder Ansicht (vorher fehlten dort die Dateien: „Nur Code“ 6836 > „Alles“ 6751)", () => {
    const all = visible(applyPreset(defaultSettings(), "all"));
    for (const id of ["code", "planung", "sessions"] as const) {
      for (const n of visible(applyPreset(defaultSettings(), id))) expect(all).toContain(n);
    }
  });

  // Dateien in „Alles“ kosteten live +2234 Punkte (+33 %), +1,3 MB und 0,1–0,2 s mehr
  // Ladezeit, und die Kraft-Simulation rechnet jeden Punkt mit. Das Gehirn darf nicht langsamer werden:
  // keine Vorgabe-Ansicht lädt Dateien (Schalter „Dateien“ bleibt im Bedienfeld), die Obermenge hält.
  it("keine Vorgabe-Ansicht blendet Dateien ein (das Gehirn bleibt so schnell wie vorher)", () => {
    for (const id of ["all", "code", "planung", "sessions", "baustelle"] as const) {
      expect(applyPreset(defaultSettings(), id).groups.file).toBe("hide");
    }
  });

  it("„Planung/Obsidian“ zeigt Notizen ohne Code, „Sessions & Agenten“ nur Sessions/Sub-Agenten/Baustellen/Arten", () => {
    const plan = visible(applyPreset(defaultSettings(), "planung"));
    expect(plan).toContain("note:04 Planung/P.md");
    expect(plan).not.toContain("note:02 Code/A.md");
    expect(plan).not.toContain("session:claude:s1");
    const sess = visible(applyPreset(defaultSettings(), "sessions"));
    expect(sess.sort()).toEqual(["art:coding", "baustelle:b1", "session:claude:s1", "session:claude:s2", "session:claude:s3", "subagent:x"].sort());
  });

  it("„Pro Baustelle“ zeigt die Baustelle mit Nachbarn bis Tiefe 2, geht aber nicht über die Art-Knoten weiter", () => {
    const s = applyPreset(defaultSettings(), "baustelle", { focusId: "baustelle:b1" });
    expect(s.focus).toMatchObject({ id: "baustelle:b1", depth: 2 });
    const ids = visible(s);
    expect(ids).toEqual(expect.arrayContaining(["baustelle:b1", "session:claude:s1", "session:claude:s2", "subagent:x", "commit:r:abc", "note:04 Planung/P.md", "art:coding"]));
    expect(ids).not.toContain("session:claude:s3"); // hängt nur über die Art dran
    expect(ids).not.toContain("note:02 Code/A.md"); // Tiefe 3
  });

  it("Eigenes Gehirn je Session: Session + Nachbarn Tiefe 2 (Dateien nur, wenn eingeblendet)", () => {
    const s = sessionBrain(defaultSettings(), "session:claude:s2", "S2");
    expect(s.focus).toMatchObject({ id: "session:claude:s2", depth: 2, label: "S2", transient: true });
    const ids = visible(s);
    expect(ids).toEqual(expect.arrayContaining(["session:claude:s2", "baustelle:b1", "session:claude:s1", "art:coding"]));
    expect(ids).not.toContain("file:/a.ts");
    expect(ids).not.toContain("subagent:x"); // Tiefe 3
    const d = defaultSettings();
    expect(visible(sessionBrain({ ...d, groups: { ...d.groups, file: "show" } }, "session:claude:s2"))).toContain("file:/a.ts");
    // Session-Gehirn wird nicht dauerhaft gemerkt (sonst wundert man sich beim nächsten Öffnen)
    const saved = new Map<string, string>();
    saveSettings(s, { setItem: (k: string, v: string) => void saved.set(k, v) });
    const back = loadSettings({ getItem: (k: string) => saved.get(k) ?? null });
    expect(back.focus).toBeNull();
    expect(back.activeView).toBe("all");
  });

  it("eigene Ansicht speichern (Name + aktuelle Filter) und wieder anwenden", () => {
    const code = applyPreset(defaultSettings(), "code");
    const view = snapshotView({ ...code, period: "7d", search: "abc" }, "Mein Code");
    expect(view.name).toBe("Mein Code");
    const restored = applySavedView(defaultSettings(), view);
    expect(restored.activeView).toBe("saved:Mein Code");
    expect(restored.period).toBe("7d");
    expect(restored.groups).toEqual(code.groups);
    expect(restored.noteGroups).toEqual(code.noteGroups);
    // Farben/Kräfte/Darstellung gehören nicht zur Ansicht
    expect(restored.forces).toEqual(defaultSettings().forces);
  });
});
