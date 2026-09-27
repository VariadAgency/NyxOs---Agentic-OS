// gemeinsame Regeln für das Schreiben aus dem Session-Chat (Web zeigt, Server prüft dasselbe).
import { describe, expect, it } from "vitest";
import { chatAvailability, ChatSendRequestSchema, composeChatInput, safeUploadName, sanitizePasteText } from "../src/session-chat.js";

const TECH = /tmux|CSRF|ENOENT|nicht gefunden|bridge/i;
const inNyxOS = { tool: "claude" as const, status: "running", state: "waiting", attachable: true, tmuxName: "zc-claude-abcd1234" };
const ok = { online: true, supportsChat: true };

describe("Wann darf Alex schreiben?", () => {
  it("Session in der NyxOS, Mac verbunden → frei; arbeitet sie, landet es in der Warteschlange", () => {
    expect(chatAvailability(inNyxOS, ok)).toEqual({ canSend: true, reason: null, message: null, busy: false });
    expect(chatAvailability({ ...inNyxOS, state: "running" }, ok).busy).toBe(true);
  });

  it("gesperrt mit einem Satz ohne Technik-Wörter: Mac weg, eigenes Fenster, beendet, alte Brücke", () => {
    const cases = [
      chatAvailability(inNyxOS, { online: false, supportsChat: true }),
      chatAvailability({ ...inNyxOS, attachable: false, tmuxName: null }, ok),
      chatAvailability({ ...inNyxOS, attachable: false, tmuxName: null, status: "ended", state: "crashed" }, ok),
      chatAvailability(inNyxOS, { online: true, supportsChat: false }),
    ];
    expect(cases.map((c) => c.reason)).toEqual(["bridge_offline", "not_in_nyxos", "ended", "bridge_outdated"]);
    for (const c of cases) {
      expect(c.canSend).toBe(false);
      expect(c.message).toBeTruthy();
      expect(c.message).not.toMatch(TECH);
    }
  });

  it("ein fremder tmux-Name zählt nie als „in der NyxOS“", () => {
    expect(chatAvailability({ ...inNyxOS, tmuxName: "irgendwas; rm -rf" }, ok).canSend).toBe(false);
  });
});

describe("Nachricht zusammensetzen", () => {
  it("Bilder als eigene Einfügungen, andere Dateien als @\"pfad\" (Claude) bzw. Pfad (Codex)", () => {
    const files = [
      { path: "/u/a b/bild.png", image: true },
      { path: "/u/a b/notiz.txt", image: false },
    ];
    expect(composeChatInput("claude", "Schau mal", files)).toEqual({ images: ["/u/a b/bild.png"], text: 'Schau mal\n\nAnhang: @"/u/a b/notiz.txt"' });
    expect(composeChatInput("codex", "Schau mal", files)).toEqual({ images: ["/u/a b/bild.png"], text: "Schau mal\n\nAnhang: /u/a b/notiz.txt" });
    expect(composeChatInput("claude", "", [{ path: "/u/x.png", image: true }])).toEqual({ images: ["/u/x.png"], text: "" });
  });

  it("Steuerzeichen fliegen raus (kein Ausbruch aus dem Einfügen), Zeilenumbrüche bleiben", () => {
    expect(sanitizePasteText("a\u001b[201~b\r\nc\u0003")).toBe("a[201~b\nc");
  });

  it("Dateinamen werden harmlos, Endung bleibt", () => {
    expect(safeUploadName("../../etc/passwd")).toBe("passwd");
    expect(safeUploadName("Screenshot 2026-09-25 um 10.37.27.png")).toBe("Screenshot-2026-09-25-um-10.37.27.png");
    expect(safeUploadName(".png")).toBe("anhang.png");
  });

  it("leere Nachricht ohne Anhang ist ungültig", () => {
    expect(ChatSendRequestSchema.safeParse({ text: "   " }).success).toBe(false);
    expect(ChatSendRequestSchema.safeParse({ text: "", attachments: [{ name: "a.png", dataBase64: "iVBORw0KGgo=" }] }).success).toBe(true);
  });
});
