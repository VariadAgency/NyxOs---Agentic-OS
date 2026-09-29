// Fehlertexte nicht zu grob ersetzen, Mikrofon-Fehler auf Deutsch, eine Zahlen-Schreibweise.
import { describe, expect, it } from "vitest";
import { formatTokensCompact } from "@nyxos/shared";
import { ApiError } from "../src/lib/http";
import { DEFAULT_TEXT, errorDetail, friendlyError, micErrorText } from "../src/lib/friendlyError";
import { compactNumber } from "../src/features/session-chat/SessionInfoRail";
import { formatCompact } from "../src/components/charts/scale";

describe("friendlyError: gute deutsche Server-Sätze bleiben stehen", () => {
  // Stichprobe echter Texte aus apps/server/src/routes/* (+ Sätze mit „Status“, Zahlen 400–599, „null“, „nicht gefunden“)
  it.each([
    ["Diese Session gibt es nicht (mehr).", 404],
    ["Die Session arbeitet gerade. Komprimieren geht, sobald sie auf dich wartet.", 409],
    ["Die Anhänge sind zusammen zu groß (höchstens 20 MB).", 413],
    ["Die Aufnahme ist zu lang – bitte kürzer sprechen (höchstens etwa 5 Minuten).", 400],
    ["Bitte eine ganze Zahl zwischen 1 und 2160 Stunden (90 Tage) angeben.", 400],
    ["Die Logs sind gerade nicht lesbar: Der Docker-Lesezugang antwortet nicht.", 503],
    ["Diesen Commit kennt NyxOS (noch) nicht.", 404],
    ["Der Status der Prüfung ist noch offen – bitte kurz warten.", 409],
    ["Höchstens 500 Zeichen pro Notiz.", 400],
    ["Die Datei wurde nicht gefunden – bitte die Seite neu laden.", 404],
    ["Die Liste ist leer, weil noch null Einträge da sind.", 409],
  ])("„%s“ bleibt", (msg, status) => {
    expect(friendlyError(new ApiError(msg, status))).toBe(msg);
    expect(errorDetail(new ApiError(msg, status))).toBeNull();
  });
});

describe("friendlyError: Technik wird ersetzt, Details bleiben", () => {
  it.each([
    [new Error("spawn tmux ENOENT")],
    [new Error("CSRF-Token fehlt")],
    [new Error("Error: connect ECONNREFUSED 127.0.0.1:5432")],
    [new Error("Unexpected token < in JSON at position 0")],
    [new ApiError("Kein gültiges JSON", 400)],
    [new ApiError("Feld 'sessionKeys' fehlt", 400)],
    [new ApiError("Nicht gefunden", 404)],
    [new ApiError("Faden nicht gefunden", 404)],
    [new Error("Cannot read properties of undefined (reading 'id')")],
    [new Error("Request failed with status code 500")],
    [new Error("Permission denied")],
    [new Error("Internal Server Error")],
    [new Error("at Object.<anonymous> (/app/src/index.ts:12:5)")],
  ])("%s → Standardtext", (e) => {
    expect(friendlyError(e)).not.toBe(e.message);
    expect(errorDetail(e)).toContain(e.message);
  });

  it("„HTTP 503“ bleibt Technik", () => {
    expect(friendlyError(new Error("HTTP 503"))).toBe(DEFAULT_TEXT);
  });
});

describe("micErrorText: Mikrofon-Fehler auf Deutsch mit Hinweis", () => {
  const dom = (name: string, msg: string) => new DOMException(msg, name);
  it("NotAllowedError → erlauben, Schloss-Symbol", () => {
    const t = micErrorText(dom("NotAllowedError", "Permission denied"));
    expect(t).toMatch(/Mikrofon-Zugriff im Browser erlauben/);
    expect(t).toMatch(/Schloss-Symbol/);
    expect(t).not.toMatch(/permission|denied|error/i);
  });
  it("SecurityError und nackter „Permission denied“ → dasselbe", () => {
    expect(micErrorText(dom("SecurityError", "The request is not allowed"))).toMatch(/erlauben/);
    expect(micErrorText(new Error("Permission denied"))).toMatch(/erlauben/);
  });
  it("NotFoundError → kein Mikrofon, anschließen", () => {
    const t = micErrorText(dom("NotFoundError", "Requested device not found"));
    expect(t).toMatch(/Kein Mikrofon/);
    expect(t).toMatch(/anschließen/);
  });
  it("NotReadableError → andere App benutzt es", () => {
    expect(micErrorText(dom("NotReadableError", "Could not start audio source"))).toMatch(/andere[nr]? App/);
  });
  it("fehlendes navigator.mediaDevices (TypeError) ist KEIN „Keine Verbindung“", () => {
    const t = micErrorText(new TypeError("Cannot read properties of undefined (reading 'getUserMedia')"));
    expect(t).not.toMatch(/Verbindung zum Server/);
    expect(t).toMatch(/Mikrofon/);
  });
  it("alles andere → einfacher deutscher Satz", () => {
    expect(micErrorText(new Error("xyz"))).toMatch(/Mikrofon/);
  });
});

describe("Zahlen: eine Schreibweise aus shared", () => {
  it.each([3_874_200_000, 1_234_567, 12_345, 999, 0])("compactNumber(%d) = formatTokensCompact", (n) => {
    expect(compactNumber(n)).toBe(formatTokensCompact(n));
  });
  it("3,9 Mrd. mit Punkt, 12.345 statt „12 Tsd“", () => {
    expect(compactNumber(3_874_200_000).replace(/\s/g, " ")).toBe("3,9 Mrd."); // Intl setzt ein geschütztes Leerzeichen
    expect(compactNumber(12_345)).toBe("12.345");
  });
  it("Diagramm-Achsen nutzen dieselbe Schreibweise", () => {
    for (const n of [3_874_200_000, 1_234_567, 12_345, 999]) expect(formatCompact(n)).toBe(formatTokensCompact(n));
  });
});
