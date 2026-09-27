import { VaultNoteSchema } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { parseNote } from "../src/vault/parse.js";

const MTIME = Date.parse("2026-09-25T01:00:00Z");
const note = (path: string, content: string) => parseNote(path, content, MTIME, content.length);

describe("parseNote", () => {
  it("Titel = Dateiname, Ordner, Zeit, Größe, gültig laut Schema", () => {
    const n = note("04 Planung/Features/Heatmap Live.md", "Text");
    expect(n.title).toBe("Heatmap Live");
    expect(n.folder).toBe("04 Planung/Features");
    expect(n.path).toBe("04 Planung/Features/Heatmap Live.md");
    expect(n.mtime).toBe("2026-09-25T01:00:00.000Z");
    expect(n.size).toBe(4);
    expect(n.heading).toBeNull();
    expect(VaultNoteSchema.safeParse(n).success).toBe(true);
    expect(note("Wurzel.md", "").folder).toBe("");
  });

  it("Überschrift: Frontmatter-title vor erster #-Überschrift", () => {
    expect(note("a.md", "# Erste\n\n## Zweite").heading).toBe("Erste");
    expect(note("a.md", '---\ntitle: "Aus Frontmatter"\n---\n# Erste').heading).toBe("Aus Frontmatter");
    expect(note("a.md", "```\n# Kein Titel\n```\n## Zweite Ebene\n# Richtig").heading).toBe("Richtig");
  });

  it("Wiki-Links: Alias, Kopf, Einbettung, Pfad, .md-Endung, Duplikate", () => {
    const n = note(
      "x.md",
      "Siehe [[Ziel A]] und [[Ziel B|Alias]] sowie [[Ziel C#Abschnitt]] und [[Ziel D#Kopf|Alias]].\n" +
        "![[Eingebettet]] [[04 Planung/Unter/Tief.md]] [[Ziel A]] [[ Ziel E ]] [[#Nur Kopf]] [[Ziel F^block]]",
    );
    expect(n.links).toEqual(["Ziel A", "Ziel B", "Ziel C", "Ziel D", "Eingebettet", "04 Planung/Unter/Tief", "Ziel E", "Ziel F"]);
  });

  it("Anhänge (Bilder/PDF/Canvas) werden ignoriert", () => {
    const n = note("x.md", "![[bild.png]] [[plan.pdf]] ![alt](bild.jpg) [[Notiz]] [[Datei.canvas]] [[Version 1.2 Plan]]");
    expect(n.links).toEqual(["Notiz", "Version 1.2 Plan"]);
  });

  it("Links in Codeblöcken und Inline-Code zählen nicht", () => {
    const n = note("x.md", "```\n[[ImCode]]\n```\nText `[[InlineCode]]` und [[Echt]]\n~~~swift\n[[AuchCode]]\n~~~");
    expect(n.links).toEqual(["Echt"]);
  });

  it("Markdown-Links auf .md (relativ, dekodiert), keine http-Links", () => {
    const n = note(
      "a/b.md",
      "[Eins](Andere%20Notiz.md) [Zwei](../c/d.md#kopf) [Web](https://example.com/x.md) [Bild](x.png) [Mail](mailto:a@b.de) [Ohne](Ohne-Endung) [Drei](<Mit Leer.md>)",
    );
    expect(n.links).toEqual(["a/Andere Notiz", "c/d", "a/Mit Leer"]);
  });

  it("Frontmatter-Tags (Liste inline, Komma, Blockliste) + Inline-Tags", () => {
    expect(note("a.md", "---\ntags: [session, setup]\n---\nText").tags).toEqual(["session", "setup"]);
    expect(note("a.md", "---\ntags: bug, ios\n---\n").tags).toEqual(["bug", "ios"]);
    expect(note("a.md", '---\ntags:\n  - eins\n  - "#zwei"\ncreated: 2026-01-01\n---\n').tags).toEqual(["eins", "zwei"]);
    const n = note(
      "a.md",
      "# Überschrift ist kein Tag\n## Auch nicht\nText #idee und #bug/ios, #2026 ist keine, https://x.de/#anker nicht, `#code` nicht, Ende#nichts\n```\n#imcode\n```",
    );
    expect(n.tags).toEqual(["idee", "bug/ios"]);
  });

  it("Frontmatter-Tags und Inline-Tags werden zusammengeführt ohne Duplikate", () => {
    expect(note("a.md", "---\ntags: [idee]\n---\n#idee #neu").tags).toEqual(["idee", "neu"]);
  });

  it("Session-UUIDs werden als Erwähnung erkannt (klein, dedupliziert)", () => {
    const n = note(
      "a.md",
      "Session AAAAAAAA-0000-4000-8000-000000000001 und aaaaaaaa-0000-4000-8000-000000000001, codex 01a0c424-0000-7000-8000-00000000c0de",
    );
    expect(n.mentions).toEqual(["aaaaaaaa-0000-4000-8000-000000000001", "01a0c424-0000-7000-8000-00000000c0de"]);
  });

  it("hält die Obergrenzen des Schemas ein", () => {
    const many = Array.from({ length: 12_000 }, (_, i) => `[[N${i}]]`).join(" ");
    const n = note("a.md", many);
    expect(n.links.length).toBe(10_000);
    expect(VaultNoteSchema.safeParse(n).success).toBe(true);
    const long = note(`${"x".repeat(600)}.md`, "");
    expect(long.title.length).toBeLessThanOrEqual(512);
    expect(VaultNoteSchema.safeParse(long).success).toBe(true);
  });
  it("Notiz-Anfang als reiner Text (ohne Frontmatter, Titel, Code, Link-Klammern), begrenzt", () => {
    const n = note(
      "a.md",
      '---\ntitle: "X"\ntags: [a]\n---\n# Heatmap Live\n\n> Die **Heatmap** zeigt [[04 Planung/Live|live]], wo gefeiert wird.\n\n```swift\nlet geheim = 1\n```\n- Punkt [eins](Eins.md) und `code`\n<br/>',
    );
    expect(n.excerpt).toBe("Die Heatmap zeigt live, wo gefeiert wird. Punkt eins und code");
    expect(note("b.md", "").excerpt).toBeNull();
    const long = note("c.md", "Wort ".repeat(500));
    expect((long.excerpt ?? "").length).toBeLessThanOrEqual(400);
    expect(long.excerpt?.endsWith("…")).toBe(true);
    expect(VaultNoteSchema.safeParse(long).success).toBe(true);
  });
  it("Code-Notiz nennt ihre Quelldatei (Frontmatter `path`) → `source`; sonst null", () => {
    const code = note(
      "02 Code/Views/_BTree.md",
      "---\ntags: [code, view, backend]\ncreated: 2026-04-10\npath: App/backend/services/user-service/.build/checkouts/swift-collections/Sources/_BTree.swift\ntype: Swift Komponente\n---\n# _BTree\n",
    );
    expect(code.source).toBe("App/backend/services/user-service/.build/checkouts/swift-collections/Sources/_BTree.swift");
    expect(note("a.md", '---\npath: "App/Xcode/My App/A.swift"\n---\nText').source).toBe("App/Xcode/My App/A.swift");
    expect(note("b.md", "path: nicht im Frontmatter").source).toBeNull();
    expect(note("c.md", "---\npath:\n---\n").source).toBeNull();
    expect(VaultNoteSchema.safeParse(code).success).toBe(true);
  });
});
