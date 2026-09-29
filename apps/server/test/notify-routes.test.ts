// Notifications – Routen der Seite „Mitteilungen“: Einstellungen (GET/PATCH, eine Ruhezeit für beide Systeme), Verlauf mit
// Grund, Rückmeldung → Regel-Vorschlag (annehmen/ablehnen), Vorschau (mit und ohne Nyx), Anmeldung, Nyx' app_api.
import type { NotifyFeedbackResponse, NotifyHistoryResponse, NotifyPreviewResponse, NotifySettingsResponse } from "@nyxos/shared";
import { describe, expect, it } from "vitest";
import { pushLog, sessions } from "../src/db/schema.js";
import { classifyApiRequest } from "../src/nyx/appApi/rules.js";
import { listDeliveries } from "../src/push/log.js";
import { setup } from "./helpers.js";
import { answer, FakeEngine, setupAssistant } from "./assistant/assistant-helpers.js";

async function j<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
const patch = (body: unknown) => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Routen · Einstellungen", () => {
  it("GET liefert Standardwerte (Unter-Agenten aus, Mit Zusammenhang, Nyx aus) ohne das geheime Thema", async () => {
    const t = await setup();
    const res = await t.app.request("/api/notifications/settings");
    expect(res.status).toBe(200);
    const body = await j<NotifySettingsResponse>(res);
    expect(body.rules).toMatchObject({ skipSubAgents: true, style: "zusammenhang", nyxReview: false, nyxWrite: false, protectUrgent: true, minGapMinutes: 10 });
    expect(body.rules.when.session_done).toBe("away");
    expect(body.rules.when.session_waiting).toBe("always");
    expect(JSON.stringify(body)).not.toContain("nyxos-"); // Thema bleibt geheim
    expect(body.sample.session).toBeTruthy();
  });

  it("PATCH speichert Stufe + Stil + Nyx und hält die Ruhezeit beider Systeme gleich; bleibt nach neuem Laden", async () => {
    const t = await setup();
    const res = await t.app.request(
      "/api/notifications/settings",
      patch({ rules: { when: { context_guard_hinweis: "never" }, style: "knapp", nyxReview: true, important: "Nur Blocker" }, push: { quietStart: "23:00", quietEnd: "07:00" }, away: { quietStart: "23:00", quietEnd: "07:00", quietEnabled: true } }),
    );
    expect(res.status).toBe(200);
    const again = await j<NotifySettingsResponse>(await t.app.request("/api/notifications/settings"));
    expect(again.rules).toMatchObject({ style: "knapp", nyxReview: true, important: "Nur Blocker" });
    expect(again.rules.when.context_guard_hinweis).toBe("never");
    expect(again.push).toMatchObject({ quietStart: "23:00", quietEnd: "07:00" });
    expect(again.away).toMatchObject({ quietStart: "23:00", quietEnd: "07:00", quietEnabled: true });
  });

  it("ungültig → 400; ohne Anmeldung → abgewiesen", async () => {
    const t = await setup();
    expect((await t.app.request("/api/notifications/settings", patch({ rules: { style: "laut" } }))).status).toBe(400);
    expect((await t.app.request("/api/notifications/settings", patch({ unbekannt: 1 }))).status).toBe(400);
    const anon = await setup({ signedIn: false });
    expect((await anon.app.request("/api/notifications/settings", patch({ rules: { style: "knapp" } }))).status).toBeGreaterThanOrEqual(401);
  });

  it("alter Push-Schalter (früheres Panel) wirkt weiter als „Nie“", async () => {
    const t = await setup();
    await t.app.request("/api/push/settings", patch({ enabledKinds: { usage_warning: false } }));
    const body = await j<NotifySettingsResponse>(await t.app.request("/api/notifications/settings"));
    expect(body.rules.when.usage_warning).toBe("never");
  });
});

describe("Routen · Verlauf, Rückmeldung, Regel-Vorschlag", () => {
  it("Verlauf mit Grund; 2× „Brauche ich nicht“ → Vorschlag; annehmen → weg; Nyx' Werkzeug liefert den Grund mit", async () => {
    const t = await setup();
    await t.db.insert(sessions).values({ id: "claude:a", tool: "claude", sessionId: "a", title: "Push", titleSource: "ai" });
    const rows = await t.db
      .insert(pushLog)
      .values([
        { kind: "context_guard_hinweis", sessionKey: "claude:a", title: "Kontext fast voll", message: "„Push“: Kontext 65 %", priority: "default", decision: "sent", channels: [{ channel: "mac", ok: true }] },
        { kind: "context_guard_hinweis", sessionKey: "claude:a", title: "Kontext fast voll", message: "„Push“: Kontext 70 %", priority: "default", decision: "nyx_skip", suppressedReason: "nyx_skip", decisionNote: "Nicht dringend" },
        { kind: "session_waiting", sessionKey: "claude:a", title: "Wartet auf dich", message: "x", priority: "default", decision: "sub_agent", suppressedReason: "sub_agent" },
      ])
      .returning({ id: pushLog.id });
    const hist = await j<NotifyHistoryResponse>(await t.app.request("/api/notifications/history"));
    expect(hist.items).toHaveLength(3);
    const byId = new Map(hist.items.map((i) => [i.id, i]));
    expect(byId.get(rows[0]?.id ?? 0)).toMatchObject({ decision: "sent", delivered: true, reason: "Gesendet", kindLabel: "Kontext-Wächter" });
    expect(byId.get(rows[1]?.id ?? 0)?.reason).toBe("Nyx hat sie weggelassen – Nicht dringend");
    expect(byId.get(rows[2]?.id ?? 0)?.reason).toBe("Unter-Agent – nicht gemeldet");
    expect(hist.suggestions).toEqual([]);

    const first = await j<NotifyFeedbackResponse>(await t.app.request(`/api/notifications/history/${rows[0]?.id}/feedback`, post({ value: "unnoetig" })));
    expect(first.suggestion).toBeNull();
    const second = await j<NotifyFeedbackResponse>(await t.app.request(`/api/notifications/history/${rows[1]?.id}/feedback`, post({ value: "unnoetig" })));
    expect(second.suggestion).toMatchObject({ kind: "context_guard_hinweis", when: "away", text: "„Kontext-Wächter“ nur, wenn ich weg bin?" });
    expect((await j<NotifyHistoryResponse>(await t.app.request("/api/notifications/history"))).suggestions).toHaveLength(1);

    // Nyx' Werkzeug `mitteilungen_liste` sieht Grund und Rückmeldung
    const nyxView = await listDeliveries(t.db, 5, (s) => s);
    expect(nyxView.find((d) => d.grund.startsWith("Nyx hat sie weggelassen"))?.rueckmeldung).toBe("brauche ich nicht");

    await t.app.request("/api/notifications/settings", patch({ rules: { when: { context_guard_hinweis: "away" } } }));
    expect((await j<NotifyHistoryResponse>(await t.app.request("/api/notifications/history"))).suggestions).toEqual([]);
  });

  it("„Nein danke“ blendet den Vorschlag aus; unbekannte Mitteilung → 404, falscher Wert → 400", async () => {
    const t = await setup();
    const rows = await t.db
      .insert(pushLog)
      .values([1, 2].map((n) => ({ kind: "usage_warning", title: "Nutzung", message: `m${n}`, priority: "default", decision: "sent" })))
      .returning({ id: pushLog.id });
    for (const r of rows) await t.app.request(`/api/notifications/history/${r.id}/feedback`, post({ value: "unnoetig" }));
    expect((await j<NotifyHistoryResponse>(await t.app.request("/api/notifications/history"))).suggestions).toHaveLength(1);
    await t.app.request("/api/notifications/settings", patch({ rules: { dismissSuggestion: "usage_warning" } }));
    expect((await j<NotifyHistoryResponse>(await t.app.request("/api/notifications/history"))).suggestions).toEqual([]);
    expect((await t.app.request("/api/notifications/history/999999/feedback", post({ value: "passt" }))).status).toBe(404);
    expect((await t.app.request(`/api/notifications/history/${rows[0]?.id}/feedback`, post({ value: "super" }))).status).toBe(400);
  });
});

describe("Routen · Vorschau", () => {
  it("rendert den Beispiel-Anlass im gewünschten Stil mit der zuletzt aktiven echten Session", async () => {
    const t = await setup();
    await t.db.insert(sessions).values({ id: "claude:v", tool: "claude", sessionId: "v", title: "Mitteilungen umbauen", titleSource: "ai", categoryBaustelleLabel: "Webshop", lastActivityAt: new Date().toISOString() });
    const knapp = await j<NotifyPreviewResponse>(await t.app.request("/api/notifications/preview", post({ kind: "session_waiting", style: "knapp" })));
    expect(knapp).toMatchObject({ title: "Wartet auf dich", body: "Mitteilungen umbauen" });
    const lang = await j<NotifyPreviewResponse>(await t.app.request("/api/notifications/preview", post({ kind: "session_waiting", style: "ausfuehrlich" })));
    expect(lang.body).toMatch(/^„Mitteilungen umbauen“ \(Webshop\) wartet seit \d{2}:\d{2} auf dich\./);
    const eigene = await j<NotifyPreviewResponse>(await t.app.request("/api/notifications/preview", post({ kind: "session_waiting", template: { title: "Hey", body: "{session} · {baustelle}" } })));
    expect(eigene).toMatchObject({ title: "Hey", body: "Mitteilungen umbauen · Webshop" });
    expect(lang.nyx).toBeNull();
  });

  it("mit Nyx: prüft und schreibt über die Nyx-Laufzeit (Budget/Protokoll wie jeder Nyx-Lauf)", async () => {
    const engine = new FakeEngine(answer(JSON.stringify({ entscheidung: "senden", grund: "der Nutzer wartet darauf", titel: "Fertig zum Prüfen", text: "„Anmeldung umbauen“ wartet auf dein OK." })));
    const t = await setupAssistant({ engine });
    const res = await j<NotifyPreviewResponse>(await t.app.request("/api/notifications/preview", post({ kind: "session_waiting", withNyx: true })));
    expect(res).toMatchObject({ title: "Fertig zum Prüfen", body: "„Anmeldung umbauen“ wartet auf dein OK.", nyx: { decision: "senden", wrote: "nyx" } });
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]?.kind).toBe("mitteilung");
  });
});

describe("Nyx darf die Mitteilungs-Einstellungen bedienen wie der Nutzer", () => {
  it("app_api: lesen, ändern, Rückmeldung, Vorschau direkt; das geheime Thema bleibt gesperrt", () => {
    expect(classifyApiRequest("GET", "/api/notifications/settings").access).toBe("direkt");
    expect(classifyApiRequest("PATCH", "/api/notifications/settings").access).toBe("direkt");
    expect(classifyApiRequest("GET", "/api/notifications/history").access).toBe("direkt");
    expect(classifyApiRequest("POST", "/api/notifications/history/5/feedback").access).toBe("direkt");
    expect(classifyApiRequest("POST", "/api/notifications/preview").access).toBe("direkt");
    expect(classifyApiRequest("GET", "/api/push/subscribe").access).toBe("gesperrt");
  });
});
