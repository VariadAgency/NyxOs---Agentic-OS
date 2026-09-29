// Katalog für `app_api_katalog`: alle /api-Wege, die die App wirklich registriert hat (`app.routes`), plus ein
// kurzer deutscher Zweck für die wichtigen. Gesperrte Wege tauchen gar nicht auf.
import { classifyApiRequest, type ApiAccess } from "./rules.js";

/** Zweck je „METHODE Weg“ (Weg genau wie registriert, mit Platzhaltern). */
export const ROUTE_PURPOSES: Record<string, string> = {
  // Sessions
  "GET /api/sessions": "Alle Sessions (Claude/Codex) mit Zustand, Titel, Baustelle – `limit` in query",
  "GET /api/sessions/:id": "Eine Session im Detail (Ereignisse, Dateien)",
  "GET /api/sessions/:id/transcript": "Chat-Verlauf einer Session, seitenweise (query: direction, limit, cursor)",
  "GET /api/sessions/:id/chat": "Chat-Ansicht einer Session",
  "POST /api/sessions/:id/message": "Text in eine laufende Session schreiben (body: { text }) – wie das Eingabefeld im Session-Chat",
  "GET /api/sessions/:id/deliveries": "Wartende Nachrichten an eine Session (Zustell-Warteschlange)",
  "POST /api/sessions/:id/assign": "Session einsortieren (body: { art?, baustelle? })",
  "POST /api/sessions/:id/unassign": "Einsortieren rückgängig",
  "POST /api/sessions/:id/close": "Session als geschlossen markieren (braucht Bestätigung)",
  "POST /api/sessions/:id/reopen": "Geschlossene Session wieder öffnen",
  "POST /api/sessions/:id/opened": "Session als geöffnet merken (zuletzt geöffnet)",
  "POST /api/sessions/:id/temporary": "Session als temporär markieren bzw. behalten",
  "GET /api/sessions/:id/outcomes": "Was in einer Session erledigt/behoben/offen ist",
  "GET /api/sessions/:id/changes": "Geänderte Dateien einer Session",
  "GET /api/sessions/:id/agents": "Sub-Agenten einer Session",
  "GET /api/sessions/:id/agents-live": "Agenten einer Session live (laufend, fertig, Archiv je Lauf) mit Laufzeit, Tokens, letzter Aktion",
  "GET /api/sessions/:id/agents-live/:agentId": "Ein Agent einer Session im Detail (letzte Schritte, Auftrag, Ergebnis)",
  "POST /api/sessions/:id/agents/:agentId/hide": "Agent aus einem früheren Lauf im Archiv aus- bzw. einblenden (body: { hidden: true|false })",
  "POST /api/sessions/:id/agents/:agentId/task": "Auftrag + Ergebnis eines Agenten als Aufgabe übernehmen (zweimal = dieselbe Aufgabe)",
  "GET /api/sessions/:id/audits": "Prüfberichte einer Session",
  "POST /api/sessions/:id/audits": "Session zusammenfassen & prüfen lassen",
  "GET /api/sessions/:id/summary": "Letzte ausführliche Zusammenfassung einer Session (Markdown) + neue Nachrichten seitdem",
  "POST /api/sessions/:id/summary": "Nyx fasst die Session ausführlich zusammen (Ziel, erledigt, läuft, offen, nächster Schritt) – erscheint oben im Session-Chat",
  "GET /api/sessions/:id/controls": "Was sich in einer Session steuern lässt: aktuelles Modell, mögliche Modelle (nur die des Werkzeugs), Denkaufwand-Stufen, Komprimieren",
  "POST /api/sessions/:id/controls": "Modell wechseln ({ kind: \"model\", model: <id aus GET …/controls> }) oder Denkaufwand setzen ({ kind: \"effort\", level }) – geht raus, sobald die Session wartet",
  "POST /api/sessions/:id/prompt-assist": "Prompt für eine Session verbessern lassen",
  "GET /api/recent-sessions": "Zuletzt geöffnete Sessions",
  "GET /api/search": "Sessions durchsuchen (query: q)",
  // Terminal
  "GET /api/terminal/status": "Ist die Brücke verbunden?",
  "GET /api/terminal/folders": "Ordner, in denen eine neue Session starten kann",
  "POST /api/terminal/start": "Neue Session starten (body: { tool: claude|codex, model z. B. claude-opus-5-5, cwd, prompt })",
  "POST /api/sessions/:id/resume": "Beendete Session fortsetzen",
  "POST /api/sessions/:id/kill": "Session-Prozess beenden (body: { confirm: true }, braucht Bestätigung)",
  "POST /api/sessions/:id/takeover/preview": "Übernahme einer Session vorab prüfen",
  // Aufgaben, Ideen, Inbox
  "GET /api/entries": "Aufgaben, Bugs, Ideen, Fragen, Audit-Befunde (query: kind, stage, q)",
  "POST /api/entries": "Aufgabe/Bug/Idee anlegen (body: { kind, title, description? })",
  "GET /api/entries/:id": "Einen Eintrag lesen",
  "PATCH /api/entries/:id": "Eintrag ändern (Titel, Stufe, Priorität …)",
  "POST /api/entries/:id/start": "Auftrag starten (autonome Session)",
  "GET /api/entries/:id/start-plan": "Start-Plan eines Auftrags",
  "POST /api/entries/:id/progress": "Fortschritt eines Eintrags melden",
  "GET /api/inbox": "Offene Entscheidungen/Fragen (query: status=all für alle)",
  "POST /api/inbox/:id/answer": "Entscheidung beantworten (braucht Bestätigung)",
  "GET /api/approvals": "Offene Freigaben (Leitplanken)",
  "POST /api/approvals/:id/decide": "Freigabe entscheiden (braucht Bestätigung)",
  "GET /api/open-questions": "Offene Fragen",
  // Betrieb & Zugriff
  "GET /api/hosting/status": "Wie NyxOS gerade läuft (Lokal/Server, Adressen, Brücke, vom Handy erreichbar?)",
  "GET /api/hosting/profile": "Betrieb & Zugriff: gewählter Weg, Formularwerte, letzte Prüfungen (Geheimnisse nur „gesetzt“)",
  "PUT /api/hosting/profile": "Betrieb & Zugriff speichern (immer das ganze Profil: { way, phoneWay, forms }, keine Geheimnisse)",
  "POST /api/hosting/check": "Adresse prüfen (body: { target: local|server|provider|tailscale|cloudflare|domain, url? }) – ruft <url>/health",
  // Feedback & Unterstützen
  "GET /api/support/state": "Postausgang (wartende/gesendete Meldungen), Entwürfe, ob die Meldestelle eingerichtet ist",
  "PUT /api/support/draft": "Entwurf vorbereiten – Fehler (body: { kind: 'bug', what, before?, expected? }) oder Idee (body: { kind: 'idea', title, description, importance: nice|important|essential }); der Nutzer prüft und sendet selbst. Das Blatt öffnen: ui navigate auf eine Seite mit ?support=bug|idea|tokens",
  "POST /api/support/bug": "Fehlermeldung senden (braucht Bestätigung)",
  "POST /api/support/idea": "Idee senden (braucht Bestätigung)",
  "POST /api/support/flush": "Wartende Meldungen jetzt senden",
  // Nyx
  "GET /api/nyx/profile": "Nyx-Profil (Persönlichkeit, Regler, Nutzerangaben)",
  "PUT /api/nyx/profile": "Nyx-Profil speichern (immer das ganze Profil)",
  "GET /api/nyx/presets": "Vorlagen für die Nyx-Regler",
  "POST /api/nyx/presets": "Eigene Regler-Vorlage anlegen",
  "GET /api/nyx/voice/settings": "Stimmen-Einstellungen",
  "PUT /api/nyx/voice/settings": "Stimmen-Einstellungen speichern",
  "GET /api/nyx/memory": "Nyx-Gedächtnis",
  "GET /api/nyx/schedules": "Geplante Aufgaben",
  "GET /api/haiku/status": "Zustand des Nyx-Motors",
  "PATCH /api/haiku/settings": "Nyx-Motor-Einstellungen (Budget, Zeitgrenze …)",
  "GET /api/haiku/threads": "Nyx-Chats",
  "PATCH /api/haiku/threads/:id": "Nyx-Chat umbenennen/archivieren",
  "GET /api/models/roles": "Welches Modell für welche Rolle",
  "PUT /api/models/roles/:role": "Modell für eine Rolle wählen",
  // Einstellungen
  "GET /api/push/settings": "Mitteilungs-Einstellungen",
  "PATCH /api/push/settings": "Mitteilungs-Einstellungen ändern",
  "GET /api/telegram/status": "Telegram-Stand",
  "PATCH /api/telegram/settings": "Telegram-Einstellungen ändern",
  "GET /api/away/settings": "„Wenn ich weg bin“-Einstellungen",
  "PATCH /api/away/settings": "„Wenn ich weg bin“ ändern",
  "GET /api/focus": "Fokus (Automatisch, Ich bin weg, Nicht stören)",
  "PUT /api/focus": "Fokus setzen – z. B. „Ich bin weg bis 18 Uhr“ ({ mode: away|dnd|auto, duration: 1h|evening|morning|manual } oder until als ISO-Zeit)",
  "GET /api/night/settings": "Nachtmodus-Einstellungen",
  "PATCH /api/night/settings": "Nachtmodus ändern",
  "GET /api/temporary/settings": "Einstellungen für temporäre Sessions",
  "PATCH /api/temporary/settings": "Temporäre Sessions einstellen",
  "GET /api/context-guard/settings": "Kontext-Wächter-Einstellungen",
  "POST /api/context-guard/sessions/:id/compact-now": "Session jetzt komprimieren",
  "GET /api/usage/settings": "Nutzungs-Einstellungen (Warnschwellen)",
  "PATCH /api/usage/settings": "Nutzungs-Einstellungen ändern",
  // Überblick, Git, Server, Nutzung
  "GET /api/overview": "Überblick (wie der Start-Tab)",
  "GET /api/changes": "Was ist neu",
  "GET /api/git": "Git-Stand aller Repos",
  "GET /api/git/dashboard": "Git-Übersicht",
  "GET /api/git/commits": "Letzte Commits",
  "GET /api/conflicts/summary": "Konflikte (mehrere Sessions am selben Ordner)",
  "GET /api/server": "Server-Lage (Container, Speicher, Deploys)",
  "GET /api/server/containers/:id/logs": "Log eines Containers",
  "GET /api/builds": "Build-Läufe",
  "POST /api/builds/run": "Build starten",
  "GET /api/usage/daily": "Nutzung je Tag",
  "GET /api/usage/window": "Nutzung im 5-Stunden-Fenster",
  "GET /api/usage/limits": "Abo-Limits",
  "GET /api/skills": "Skill-Bibliothek",
  "GET /api/agents/runs": "Agenten-Läufe",
  // Dateien
  "GET /api/files": "Dateien, die Sessions angefasst haben",
  "GET /api/finder/list": "Ordner auf dem Rechner auflisten (query: root, p)",
  "GET /api/finder/text": "Textdatei auf dem Rechner lesen (query: root, p)",
  "POST /api/finder/write": "Text-/Markdown-Datei auf dem Rechner speichern (mit Sicherungskopie)",
  "GET /api/search/all": "Suche über alles (query: q)",
};

export interface CatalogEntry {
  methode: string;
  pfad: string;
  zweck: string | null;
  zugriff: Exclude<ApiAccess, "gesperrt">;
}

/** Beispielweg für einen registrierten Weg (Platzhalter → „x1“), nur zum Einordnen. */
export function samplePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x1").replace(/\*$/, "x1");
}

export function buildCatalog(routes: readonly { method: string; path: string }[], filter?: string | null): CatalogEntry[] {
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  const q = filter?.trim().toLowerCase() ?? "";
  for (const r of routes) {
    if (!r.path.startsWith("/api/") || r.method === "ALL" || r.method === "HEAD") continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { access } = classifyApiRequest(r.method, samplePath(r.path));
    if (access === "gesperrt") continue;
    const zweck = ROUTE_PURPOSES[key] ?? null;
    if (q && !`${r.path} ${zweck ?? ""}`.toLowerCase().includes(q)) continue;
    out.push({ methode: r.method, pfad: r.path, zweck, zugriff: access });
  }
  return out;
}
