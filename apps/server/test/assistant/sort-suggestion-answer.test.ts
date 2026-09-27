// Antworten auf Sortier-Vorschläge (Fingerabdruck „sort:…“) gehen NICHT als Text in die Session.
// Vorher bekam die sortierte Session „Antwort vom Nutzer (Entscheidungs-Inbox): „Sortier-Vorschlag …“ – Ja“
// in ihr Terminal geschrieben – eine Nachricht, mit der sie nichts anfangen kann und die sie womöglich weckt.
// Richtig: nur die Sortierung anwenden (onAnswered) und den Eintrag schließen.
import type { InboxAnswer, InboxItem } from "@nyxos/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { inboxItems } from "../../src/db/schema.js";
import { answerInboxItem, createInboxItem, isSortSuggestion, parseSortFingerprint, YES_NO, type DeliveryDeps } from "../../src/haiku/inbox.js";
import { sharedAssistantDb } from "./assistant-helpers.js";

function recordingDeps() {
  const sent: [string, string][] = [];
  const answered: [string | null, string | null | undefined][] = [];
  const deps: DeliveryDeps = {
    sendToSession: async (key, text) => {
      sent.push([key, text]);
      return "sent";
    },
    decisionsRoot: null,
    onAnswered: async (item: InboxItem & { fingerprint: string | null }, answer: InboxAnswer) => {
      answered.push([item.fingerprint, answer.optionId]);
      return answer.optionId === "ja" ? "Session zugeordnet (ohne Regel)" : null;
    },
  };
  return { deps, sent, answered };
}

describe("Sortier-Vorschlag beantworten", () => {
  it("„Ja“ wendet die Sortierung an, schließt den Eintrag und schreibt NICHTS in die Session", async () => {
    const db = await sharedAssistantDb();
    const { deps, sent, answered } = recordingDeps();
    const { item } = await createInboxItem(db, {
      kind: "frage",
      title: "Sortier-Vorschlag von Nyx: „Recherche Tools“ → Recherche?",
      options: YES_NO,
      sessionKey: "claude:u1",
      createdBy: "haiku",
      fingerprint: "sort:claude:u1:recherche",
    });
    const r = await answerInboxItem(db, item.id, { optionId: "ja" }, deps);
    expect("item" in r).toBe(true);
    if (!("item" in r)) return;
    expect(r.item.status).toBe("answered");
    expect(sent).toEqual([]);
    expect(r.item.delivery?.toSession).toBeNull();
    expect(answered).toEqual([["sort:claude:u1:recherche", "ja"]]);
    expect(r.item.delivery?.note).toBe("Session zugeordnet (ohne Regel)");
    const [row] = await db.select({ status: inboxItems.status }).from(inboxItems).where(eq(inboxItems.id, item.id));
    expect(row?.status).toBe("answered");
  });

  it("„Nein“ schließt ebenfalls still (keine Nachricht an die Session)", async () => {
    const db = await sharedAssistantDb();
    const { deps, sent } = recordingDeps();
    const { item } = await createInboxItem(db, {
      kind: "frage",
      title: "Sortier-Vorschlag von Nyx: „Build prüfen“ → Server & Deploy?",
      options: YES_NO,
      sessionKey: "claude:u2",
      createdBy: "haiku",
      fingerprint: "sort:claude:u2:server",
    });
    const r = await answerInboxItem(db, item.id, { optionId: "nein" }, deps);
    expect("item" in r && r.item.status).toBe("answered");
    expect(sent).toEqual([]);
  });

  it("gewöhnliche Fragen einer Session gehen weiterhin an die Session", async () => {
    const db = await sharedAssistantDb();
    const { deps, sent } = recordingDeps();
    const { item } = await createInboxItem(db, { kind: "frage", title: "Tabelle umbenennen?", options: YES_NO, sessionKey: "claude:w1", createdBy: "session" });
    await answerInboxItem(db, item.id, { optionId: "ja" }, deps);
    expect(sent).toEqual([["claude:w1", "Antwort vom Nutzer (Entscheidungs-Inbox): Ja"]]);
  });

  it("nur das echte Format zählt – falsches „sort:“ oder fremde Session geht weiter an die Session", async () => {
    const db = await sharedAssistantDb();
    const { deps, sent } = recordingDeps();
    // Session im Fingerabdruck ≠ Session des Eintrags
    const { item: a } = await createInboxItem(db, { kind: "frage", title: "Wirklich sortieren?", options: YES_NO, sessionKey: "claude:x1", createdBy: "haiku", fingerprint: "sort:claude:andere:coding" });
    // von einer Session angelegt (nicht von Nyx)
    const { item: b } = await createInboxItem(db, { kind: "frage", title: "Sortieren?", options: YES_NO, sessionKey: "claude:x2", createdBy: "session", fingerprint: "sort:claude:x2:coding" });
    await answerInboxItem(db, a.id, { optionId: "ja" }, deps);
    await answerInboxItem(db, b.id, { optionId: "ja" }, deps);
    expect(sent.map(([k]) => k)).toEqual(["claude:x1", "claude:x2"]);
  });
});

describe("Fingerabdruck-Format", () => {
  it("parseSortFingerprint / isSortSuggestion", () => {
    expect(parseSortFingerprint("sort:claude:u1:recherche")).toEqual({ sessionKey: "claude:u1", art: "recherche" });
    expect(parseSortFingerprint("sort:")).toBeNull();
    expect(parseSortFingerprint("sortieren:claude:u1:x")).toBeNull();
    expect(parseSortFingerprint("sort:claude:u1:Recherche!")).toBeNull();
    expect(parseSortFingerprint(null)).toBeNull();
    expect(isSortSuggestion({ createdBy: "haiku", sessionKey: "claude:u1" }, "sort:claude:u1:recherche")).toBe(true);
    expect(isSortSuggestion({ createdBy: "haiku", sessionKey: "claude:u2" }, "sort:claude:u1:recherche")).toBe(false);
    expect(isSortSuggestion({ createdBy: "session", sessionKey: "claude:u1" }, "sort:claude:u1:recherche")).toBe(false);
  });
});
