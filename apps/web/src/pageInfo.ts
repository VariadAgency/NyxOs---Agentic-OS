// Zweck jeder Seite in einem Satz – die EINE Stelle, die von Hand gepflegt wird. Alles andere an der
// NyxOS-Karte (Leiste, Routen, Einstellungs-Bereiche, data-nyx-Kennungen, API, Tabellen) liest `scripts/nyxos-map.mjs`
// automatisch aus dem Code. Neue Route in `App.tsx` ohne Eintrag hier → der Karten-Test wird rot.
// Schlüssel = Pfad genau wie in `<Route path="…">`. `via` = Klickpfad (data-nyx-Kennungen) ab der Leiste, wenn die Seite
// nicht selbst in der Leiste steht; `<…>` steht für den Wert aus dem Pfad (z. B. `skill-<key>`).
// Einstellungs-Unterseiten stehen NICHT hier: ihr Zweck ist `summary` im Register `features/settings/sections.tsx`.

export interface PageInfo {
  /** Wofür die Seite da ist, ein Satz, einfach. */
  purpose: string;
  /** Klickpfad ab der Leiste für Seiten, die nicht selbst in der Leiste stehen. */
  via?: readonly string[];
  /** Weitere Suchwörter (Umgangssprache, Englisch). */
  keywords?: readonly string[];
}

export const PAGE_INFO: Readonly<Record<string, PageInfo>> = {
  "/overview": { purpose: "Startseite: was gerade läuft, was wartet, Builds, Nutzung und Git auf einen Blick.", keywords: ["Start", "Dashboard", "Übersicht", "home"] },
  "/nyx": { purpose: "Nyx im Vollbild: sprechen oder schreiben, Netz, Chat-Verlauf, Aufgabenliste, Gedächtnis und Dateien von Nyx.", keywords: ["Assistent", "Chat", "sprechen", "assistant"] },
  "/briefing": { purpose: "Morgen-Briefing bzw. Abend-Recap: was seit gestern passiert ist, zum Lesen oder Vorlesen.", keywords: ["Bericht", "Recap", "vorlesen", "morning"] },
  "/inbox": { purpose: "Entscheidungen: offene Fragen, Freigaben und Sortier-Vorschläge, die auf dich warten.", keywords: ["Inbox", "Freigaben", "Fragen", "decisions", "approvals"] },
  "/sessions": { purpose: "Alle Claude- und Codex-Sessions nach Art und Baustelle, mit Zustand; neue Session starten.", keywords: ["Sitzungen", "Chats", "Terminal", "Claude", "Codex"] },
  "/sessions/:art": { purpose: "Sessions einer Art (z. B. Bau, Planung), nach Baustellen gruppiert.", via: ["nav:ses"] },
  "/sessions/:art/:baustelle": { purpose: "Sessions einer Baustelle innerhalb einer Art.", via: ["nav:ses"] },
  "/sessions/:art/:baustelle/:id": { purpose: "Eine Session: Chat bzw. Terminal, Ergebnisse, geänderte Dateien, Prüfberichte.", via: ["nav:ses", "session-row:<id>"] },
  "/sessions/:art/:baustelle/:id/agenten": { purpose: "Die Unter-Agenten einer Session im Vollbild.", via: ["nav:ses", "session-row:<id>"] },
  "/sessions/:art/:baustelle/:id/agenten/:agentId": { purpose: "Ein Unter-Agent einer Session mit Verlauf.", via: ["nav:ses", "session-row:<id>"] },
  "/gehirn": { purpose: "Gehirn: Wissensgraph aus Sessions, Dateien, Aufgaben und Notizen, mit Detailkarte je Knoten.", keywords: ["Graph", "Wissen", "brain", "Karte"] },
  "/tasks": { purpose: "Aufgaben, Bugs und Befunde mit Stufe und Priorität; Aufträge starten.", keywords: ["To-dos", "Bugs", "tasks", "Aufträge"] },
  "/agents": { purpose: "Agenten: laufende und frühere Agenten-Läufe; von hier geht es auch zu den Skills.", keywords: ["Agent", "Läufe", "runs"] },
  "/skills": { purpose: "Skill-Bibliothek: alle Skills als Kacheln mit Nutzungszahlen (sortiert nach Nutzung), Großansicht je Skill.", keywords: ["Skill", "Skills", "Befehle", "Slash", "meistgenutzt", "Nutzung"] },
  "/skills/:key": { purpose: "Großansicht eines Skills: Beschreibung, Nutzung über die Zeit, Verbesserungs-Vorschläge.", via: ["nav:skills", "skill-<key>"] },
  "/conflicts": { purpose: "Konflikte: mehrere Sessions arbeiten am selben Ordner oder an denselben Dateien.", keywords: ["Kollision", "conflicts"] },
  "/git": { purpose: "Git: Repos, Zweige, Worktrees, letzte Commits und ungesicherte Änderungen.", keywords: ["Commits", "Branches", "Repo", "Worktree"] },
  "/server": { purpose: "Server: Container, Speicher, Deploys und Logs deines Servers.", keywords: ["Container", "Docker", "Deploy", "Logs"] },
  "/usage": { purpose: "Nutzung: Verbrauch und Kosten je Tag, 5-Stunden-Fenster und Abo-Limits.", keywords: ["Kosten", "Verbrauch", "Limit", "Tokens", "usage"] },
  "/ideas": { purpose: "Ideen-Postfach: gesammelte Ideen mit Status und offenen Fragen.", keywords: ["Idee", "Postfach", "ideas"] },
  "/ideas/:id": { purpose: "Eine Idee im Detail: Text, offene Fragen, zum Auftrag machen.", via: ["nav:idea", "idea:<id>"] },
  "/audits": { purpose: "Audits: alle Audit-Befunde als eigene Ansicht der Aufgaben.", keywords: ["Befunde", "Prüfung"] },
  "/files": { purpose: "Dateien wie im Finder; unter „Intelligent“ alle Dateien, die Sessions angefasst haben.", keywords: ["Finder", "Ordner", "files"] },
};
