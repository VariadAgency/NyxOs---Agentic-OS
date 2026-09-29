// Notifications – reine Bausteine der Mitteilungen: Namen (nie roher Prompt), Vorlagen/Platzhalter, Regeln normalisieren.
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../src/i18n/index.js";
import { DEFAULT_NOTIFY_RULES, fillTemplate, normalizeNotifyRules, notificationName, renderNotification, topicFromPrompt } from "../src/notifications.js";

describe("notificationName", () => {
  it("echter Titel > Auftrag > Baustelle > Kurz-Thema > Ordner – nie „/goal …“ oder „Session vom …“", () => {
    expect(notificationName({ title: "Shop-Website Feedback", titleSource: "ai" })).toBe("Shop-Website Feedback");
    expect(notificationName({ title: "/goal lies auftraege/P3-terminal/GOAL.md", titleSource: "prompt" })).toBe("P3 · Terminal");
    expect(notificationName({ title: "/goal Erstelle für unser Tool NYX OS eine website", titleSource: "prompt", baustelleLabel: "Shop-Website" })).toBe("Shop-Website");
    expect(notificationName({ title: null, firstPrompt: "Bitte die Mitteilungen überarbeiten. Danach …" })).toBe("Bitte die Mitteilungen überarbeiten");
    expect(notificationName({ title: null, cwd: "/home/dev/projects/Webshop/.claude/worktrees/agent-1", startedAt: "2026-09-28T20:33:00Z" })).toBe("Webshop");
    expect(notificationName({ title: "claude:6c87442b-00de-4547", tool: "claude" })).toBe("Claude-Session");
  });

  it("Kurz-Thema: ohne Spitznamen der Unter-Agenten, ohne Pfade, am Wort-Ende gekürzt", () => {
    expect(topicFromPrompt("Locke: Welche dinge sind 10000% fertig geschrieben und welche pfade / topics werden noch benötigt")).toBe("Welche dinge sind 10000% fertig …");
    expect(topicFromPrompt("/review ~/projects/app/foo.swift prüfen")).toBe("Prüfen");
    expect(topicFromPrompt("ok")).toBeNull();
  });
});

describe("Vorlagen", () => {
  const v = { session: "Push umbauen", baustelle: "Webshop", was: "wartet auf dich", wann: "22:47", details: "Zuletzt: Tests grün." };
  it("drei Stile für „Session wartet“", () => {
    expect(renderNotification("session_waiting", "knapp", v)).toEqual({ title: "Wartet auf dich", body: "Push umbauen" });
    expect(renderNotification("session_waiting", "zusammenhang", v).body).toBe("„Push umbauen“ wartet seit 22:47 auf dich.");
    expect(renderNotification("session_waiting", "ausfuehrlich", v).body).toBe("„Push umbauen“ (Webshop) wartet seit 22:47 auf dich.\nZuletzt: Tests grün.");
  });

  it("leere Platzhalter hinterlassen keine Reste", () => {
    expect(fillTemplate("„{session}“ ({baustelle}) wartet.\n{details}", { ...v, baustelle: null, details: null })).toBe("„Push umbauen“ wartet.");
    expect(renderNotification("approval_needed", "zusammenhang", { ...v, session: null, was: "git push – Freigabe nötig" }).body).toBe("git push – Freigabe nötig");
  });

  it("eigene Vorlage (Titel + Text) mit allen Platzhaltern", () => {
    expect(renderNotification("session_waiting", "knapp", v, { title: "{baustelle}", body: "{session}: {was} ({wann})" })).toEqual({ title: "Webshop", body: "Push umbauen: wartet auf dich (22:47)" });
  });
});

describe("normalizeNotifyRules", () => {
  it("leer → Standard; kaputte Werte → Standard; alte Schalter „aus“ → „Nie“", () => {
    expect(normalizeNotifyRules({})).toEqual(DEFAULT_NOTIFY_RULES);
    const r = normalizeNotifyRules({ style: "laut", minGapMinutes: -3, when: { session_done: "always", build_red: "manchmal" } }, { enabledKinds: { usage_warning: false }, awayEvents: { bug_new: false } });
    expect(r.style).toBe("zusammenhang");
    expect(r.minGapMinutes).toBe(10);
    expect(r.when.session_done).toBe("always");
    expect(r.when.build_red).toBe("always");
    expect(r.when.usage_warning).toBe("never");
    expect(r.when.bug_new).toBe("never");
    expect(r.skipSubAgents).toBe(true);
  });
});

describe("English", () => {
  afterEach(() => setLang("de"));

  it("default templates, titles and names follow the language; own templates stay as written", () => {
    setLang("en");
    const v = { session: "Rework sign-in", baustelle: "Webshop", was: "waiting for you", wann: "22:47", details: null };
    expect(renderNotification("session_waiting", "zusammenhang", v)).toEqual({ title: "Waiting for you", body: "“Rework sign-in” has been waiting for you since 22:47." });
    expect(renderNotification("session_done", "ausfuehrlich", { ...v, details: "Last: tests pass." })).toEqual({ title: "Session done", body: "“Rework sign-in” (Webshop) is done (22:47).\nLast: tests pass." });
    expect(renderNotification("session_waiting", "zusammenhang", v, { title: "Hey", body: "{session} · {baustelle}" })).toEqual({ title: "Hey", body: "Rework sign-in · Webshop" });
    // Without a session the fact alone, no empty quotes.
    expect(renderNotification("session_waiting", "zusammenhang", { ...v, session: null, baustelle: null }).body).toBe("waiting for you");
    expect(notificationName({ title: null, tool: "codex" })).toBe("Codex session");
  });
});
