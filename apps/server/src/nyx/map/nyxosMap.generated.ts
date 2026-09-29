// @generated von scripts/nyxos-map.mjs – NICHT von Hand ändern (`node scripts/nyxos-map.mjs` schreibt neu).
// Die NyxOS-Karte für Nyx (Werkzeug nyxos_karte, Übersicht im System-Prompt, Klickpfade für ui_navigate).
import type { NyxosMapData } from "./types.js";

export const NYXOS_MAP: NyxosMapData = {
 "nav": [
  {
   "id": "nyx",
   "label": "Nyx",
   "path": "/nyx",
   "purpose": "Nyx im Vollbild: sprechen oder schreiben, Netz, Chat-Verlauf, Aufgabenliste, Gedächtnis und Dateien von Nyx."
  },
  {
   "id": "brief",
   "label": "Briefing",
   "path": "/briefing",
   "en": "Briefing",
   "purpose": "Morgen-Briefing bzw. Abend-Recap: was seit gestern passiert ist, zum Lesen oder Vorlesen."
  },
  {
   "id": "inbox",
   "label": "Entscheidungen",
   "path": "/inbox",
   "en": "Decisions",
   "purpose": "Entscheidungen: offene Fragen, Freigaben und Sortier-Vorschläge, die auf dich warten."
  },
  {
   "id": "dash",
   "label": "Überblick",
   "path": "/overview",
   "en": "Overview",
   "purpose": "Startseite: was gerade läuft, was wartet, Builds, Nutzung und Git auf einen Blick."
  },
  {
   "id": "ses",
   "label": "Sessions",
   "path": "/sessions",
   "en": "Sessions",
   "purpose": "Alle Claude- und Codex-Sessions nach Art und Baustelle, mit Zustand; neue Session starten."
  },
  {
   "id": "brain",
   "label": "Gehirn",
   "path": "/gehirn",
   "en": "Brain",
   "purpose": "Gehirn: Wissensgraph aus Sessions, Dateien, Aufgaben und Notizen, mit Detailkarte je Knoten."
  },
  {
   "id": "task",
   "label": "Aufgaben",
   "path": "/tasks",
   "en": "Tasks",
   "purpose": "Aufgaben, Bugs und Befunde mit Stufe und Priorität; Aufträge starten."
  },
  {
   "id": "agent",
   "label": "Agenten",
   "path": "/agents",
   "en": "Agents",
   "purpose": "Agenten: laufende und frühere Agenten-Läufe; von hier geht es auch zu den Skills."
  },
  {
   "id": "skills",
   "label": "Skills",
   "path": "/skills",
   "purpose": "Skill-Bibliothek: alle Skills als Kacheln mit Nutzungszahlen (sortiert nach Nutzung), Großansicht je Skill."
  },
  {
   "id": "conf",
   "label": "Konflikte",
   "path": "/conflicts",
   "en": "Conflicts",
   "purpose": "Konflikte: mehrere Sessions arbeiten am selben Ordner oder an denselben Dateien."
  },
  {
   "id": "git",
   "label": "Git",
   "path": "/git",
   "purpose": "Git: Repos, Zweige, Worktrees, letzte Commits und ungesicherte Änderungen."
  },
  {
   "id": "srv",
   "label": "Server",
   "path": "/server",
   "en": "Server",
   "purpose": "Server: Container, Speicher, Deploys und Logs deines Servers."
  },
  {
   "id": "use",
   "label": "Nutzung",
   "path": "/usage",
   "en": "Usage",
   "purpose": "Nutzung: Verbrauch und Kosten je Tag, 5-Stunden-Fenster und Abo-Limits."
  },
  {
   "id": "idea",
   "label": "Ideen",
   "path": "/ideas",
   "en": "Ideas",
   "purpose": "Ideen-Postfach: gesammelte Ideen mit Status und offenen Fragen."
  },
  {
   "id": "audits",
   "label": "Audits",
   "path": "/audits",
   "en": "Audits",
   "purpose": "Audits: alle Audit-Befunde als eigene Ansicht der Aufgaben."
  },
  {
   "id": "dateien",
   "label": "Dateien",
   "path": "/files",
   "en": "Files",
   "purpose": "Dateien wie im Finder; unter „Intelligent“ alle Dateien, die Sessions angefasst haben."
  },
  {
   "id": "settings",
   "label": "Einstellungen",
   "path": "/settings",
   "en": "Settings",
   "purpose": "Alle Einstellungen."
  }
 ],
 "pages": [
  {
   "path": "/agents",
   "title": "Agenten",
   "purpose": "Agenten: laufende und frühere Agenten-Läufe; von hier geht es auch zu den Skills.",
   "keywords": [
    "Agent",
    "Läufe",
    "runs"
   ],
   "nav": "agent",
   "clickPath": [
    "nav:agent"
   ],
   "ids": [],
   "api": [
    "/api/agents/anomalies",
    "/api/agents/catalog",
    "/api/agents/runs",
    "/api/agents/skills/usage"
   ],
   "en": "Agents · Agent"
  },
  {
   "path": "/audits",
   "title": "Audits",
   "purpose": "Audits: alle Audit-Befunde als eigene Ansicht der Aufgaben.",
   "keywords": [
    "Befunde",
    "Prüfung"
   ],
   "nav": "audits",
   "clickPath": [
    "nav:audits"
   ],
   "ids": [
    "agent-starten",
    "aufgabe-starten",
    "bericht-lesen",
    "item:task"
   ],
   "api": [],
   "en": "Audits"
  },
  {
   "path": "/briefing",
   "title": "Briefing",
   "purpose": "Morgen-Briefing bzw. Abend-Recap: was seit gestern passiert ist, zum Lesen oder Vorlesen.",
   "keywords": [
    "Bericht",
    "Recap",
    "vorlesen",
    "morning"
   ],
   "nav": "brief",
   "clickPath": [
    "nav:brief"
   ],
   "ids": [],
   "api": [
    "/api/approvals",
    "/api/briefing",
    "/api/haiku/calls",
    "/api/haiku/chat",
    "/api/haiku/light-day",
    "/api/haiku/release-all",
    "/api/haiku/report",
    "/api/haiku/selftest",
    "/api/haiku/settings",
    "/api/haiku/status",
    "/api/haiku/threads",
    "/api/idealinks",
    "/api/inbox",
    "/api/nyx/voice/status",
    "/api/open-questions"
   ],
   "en": "Briefing · Recap"
  },
  {
   "path": "/conflicts",
   "title": "Konflikte",
   "purpose": "Konflikte: mehrere Sessions arbeiten am selben Ordner oder an denselben Dateien.",
   "keywords": [
    "Kollision",
    "conflicts"
   ],
   "nav": "conf",
   "clickPath": [
    "nav:conf"
   ],
   "ids": [],
   "api": [
    "/api/conflicts/compare",
    "/api/conflicts/decisions/dismiss",
    "/api/conflicts/decisions/prefer",
    "/api/conflicts/decisions/reopen",
    "/api/conflicts/decisions/reserve",
    "/api/conflicts/entries",
    "/api/conflicts/file-changes",
    "/api/conflicts/pause",
    "/api/conflicts/summary"
   ],
   "en": "Conflicts"
  },
  {
   "path": "/einstellungen/nyx",
   "title": "Einstellungen › Nyx",
   "purpose": "Persönlichkeit, Stimme, Begleiter und was Nyx darf",
   "keywords": [
    "Assistent",
    "Persönlichkeit",
    "Stimme",
    "Vorlesen",
    "Zuhören",
    "Regler",
    "Vorlagen"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:nyx"
   ],
   "ids": [],
   "api": [],
   "en": "Settings · Personality, voice, companion and what Nyx may do · Assistant · Personality · Voice · Read aloud · Listening · Sliders · Presets"
  },
  {
   "path": "/einstellungen/nyx/begleiter",
   "title": "Einstellungen › Nyx › Begleiter",
   "purpose": "Nyx in der Leiste: zuhören und vorlesen. Nyx sitzt oben in der Leiste – so hört und spricht Nyx dort.",
   "keywords": [
    "Leiste",
    "Zuhören",
    "Mikrofon",
    "Vorlesen",
    "Dauer-Zuhören"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:nyx",
    "settings:begleiter"
   ],
   "tabs": [
    {
     "anchor": "begleiter",
     "title": "Begleiter",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [],
   "api": [],
   "en": "Settings · Companion · Panel · Listening · Microphone · Read aloud · Always listening · Nyx in the bar: listening and reading aloud · Nyx sits at the top in the bar – this is how Nyx listens and talks there."
  },
  {
   "path": "/einstellungen/nyx/motor",
   "title": "Einstellungen › Nyx › Motor & Verbrauch",
   "purpose": "Modell, Tages-Budget und Zeiten für Briefing und Rundgang. Womit Nyx denkt, wie viel pro Tag erlaubt ist und wann Briefing, Recap und Rundgang laufen.",
   "keywords": [
    "Motor",
    "Max-Plan",
    "Budget",
    "Tagesgrenze",
    "Briefing-Zeit",
    "Recap",
    "Rundgang",
    "Letzte Aufrufe",
    "Motor testen"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:nyx",
    "settings:motor"
   ],
   "tabs": [
    {
     "anchor": "motor",
     "title": "Motor & Verbrauch",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [
    "advanced:<…>"
   ],
   "api": [
    "/api/approvals",
    "/api/briefing",
    "/api/haiku/calls",
    "/api/haiku/chat",
    "/api/haiku/light-day",
    "/api/haiku/release-all",
    "/api/haiku/report",
    "/api/haiku/selftest",
    "/api/haiku/settings",
    "/api/haiku/status",
    "/api/haiku/threads",
    "/api/idealinks",
    "/api/inbox",
    "/api/open-questions"
   ],
   "en": "Settings · Engine & usage · Engine · Max plan · Budget · Daily limit · Briefing time · Recap · Patrol · Recent calls · Test engine · Model, daily budget and times for briefing and patrol · What Nyx thinks with, how much is allowed per day and when briefing, recap and patrol run."
  },
  {
   "path": "/einstellungen/nyx/persoenlichkeit",
   "title": "Einstellungen › Nyx › Persönlichkeit",
   "purpose": "Vorlagen, Regler und Charakter. Schieb die Regler – der Beispielsatz ändert sich sofort. Gilt im Browser, per Stimme und in Telegram.",
   "keywords": [
    "Vorlage",
    "Regler",
    "Länge",
    "Tempo",
    "Humor",
    "Charakter",
    "Ton",
    "Anrede",
    "Seele",
    "du oder Sie"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:nyx",
    "settings:persoenlichkeit"
   ],
   "tabs": [
    {
     "anchor": "persoenlichkeit",
     "title": "Persönlichkeit",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [
    "advanced:<…>",
    "nyx-vorschau"
   ],
   "api": [
    "/api/nyx/presets",
    "/api/nyx/profile",
    "/api/nyx/voice/elevenlabs/clone",
    "/api/nyx/voice/elevenlabs/key",
    "/api/nyx/voice/elevenlabs/voices",
    "/api/nyx/voice/import",
    "/api/nyx/voice/pack",
    "/api/nyx/voice/pack/install",
    "/api/nyx/voice/pack/remove",
    "/api/nyx/voice/settings",
    "/api/nyx/voice/speak",
    "/api/nyx/voice/status"
   ],
   "en": "Settings · Personality · Template · Sliders · Length · Speed · Humor · Character · Tone · Form of address · Soul · formal or informal · Presets, sliders and character · Move the sliders – the sample sentence changes right away. Applies in the browser, by voice and in Telegram."
  },
  {
   "path": "/einstellungen/nyx/stimme",
   "title": "Einstellungen › Nyx › Stimme",
   "purpose": "Welche Stimme, wie schnell, wie Nyx Wörter ausspricht. Jede Stimme kannst du vorher anhören. Fällt ElevenLabs aus, spricht automatisch die eigene Stimme.",
   "keywords": [
    "Stimme",
    "Sprechtempo",
    "ElevenLabs",
    "Hörprobe",
    "Aussprache",
    "Stimme importieren",
    "Stimme klonen",
    "Stimmpaket"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:nyx",
    "settings:stimme"
   ],
   "tabs": [
    {
     "anchor": "stimme",
     "title": "Stimme",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [
    "advanced:<…>",
    "import-<…>",
    "nyx-stimme-einstellungen",
    "probe-<…>",
    "stimme-bereit",
    "stimme-installieren",
    "stimme-paket"
   ],
   "api": [
    "/api/nyx/presets",
    "/api/nyx/profile",
    "/api/nyx/voice/elevenlabs/clone",
    "/api/nyx/voice/elevenlabs/key",
    "/api/nyx/voice/elevenlabs/voices",
    "/api/nyx/voice/import",
    "/api/nyx/voice/pack",
    "/api/nyx/voice/pack/install",
    "/api/nyx/voice/pack/remove",
    "/api/nyx/voice/settings",
    "/api/nyx/voice/speak",
    "/api/nyx/voice/status"
   ],
   "en": "Settings · Voice · Speaking rate · Sample · Pronunciation · Import voice · Clone voice · Voice pack · Which voice, how fast, how Nyx pronounces words · You can listen to every voice first. If ElevenLabs fails, the own voice takes over automatically."
  },
  {
   "path": "/einstellungen/nyx/ueber-dich",
   "title": "Einstellungen › Nyx › Über dich",
   "purpose": "Was Nyx über dich wissen soll. Leere Felder lässt Nyx einfach weg.",
   "keywords": [
    "Profil",
    "Name",
    "Rolle",
    "Projekte",
    "Arbeitsweise",
    "Vorlieben",
    "No-Gos"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:nyx",
    "settings:ueber-dich"
   ],
   "tabs": [
    {
     "anchor": "ueber-dich",
     "title": "Über dich",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [
    "advanced:<…>",
    "nyx-vorschau"
   ],
   "api": [
    "/api/nyx/presets",
    "/api/nyx/profile",
    "/api/nyx/voice/elevenlabs/clone",
    "/api/nyx/voice/elevenlabs/key",
    "/api/nyx/voice/elevenlabs/voices",
    "/api/nyx/voice/import",
    "/api/nyx/voice/pack",
    "/api/nyx/voice/pack/install",
    "/api/nyx/voice/pack/remove",
    "/api/nyx/voice/settings",
    "/api/nyx/voice/speak",
    "/api/nyx/voice/status"
   ],
   "en": "Settings · About you · What Nyx should know about you. Nyx simply skips empty fields. · Profile · Name · Role · Projects · Work style · Preferences · No-gos · What Nyx should know about you · Nyx simply skips empty fields."
  },
  {
   "path": "/einstellungen/nyx/zugriff",
   "title": "Einstellungen › Nyx › Zugriff & Freigaben",
   "purpose": "Was Nyx allein darf und was nur nach deinem Okay. Nyx kann NyxOS für dich bedienen. Riskantes nur nach deinem Tipp auf „Ausführen“, Anmeldung und Schlüssel nie.",
   "keywords": [
    "Freigabe",
    "Ausführen",
    "Rechte",
    "darf Nyx",
    "Sicherheit"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:nyx",
    "settings:zugriff"
   ],
   "tabs": [
    {
     "anchor": "zugriff",
     "title": "Zugriff & Freigaben",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [],
   "api": [],
   "en": "Settings · Access & approvals · Approval · Run · Permissions · may Nyx · Security · What Nyx may do alone and what only after your okay · Nyx can operate NyxOS for you. Risky things only after you tap “Run”, sign-in and keys never."
  },
  {
   "path": "/files",
   "title": "Dateien",
   "purpose": "Dateien wie im Finder; unter „Intelligent“ alle Dateien, die Sessions angefasst haben.",
   "keywords": [
    "Finder",
    "Ordner",
    "files"
   ],
   "nav": "dateien",
   "clickPath": [
    "nav:dateien"
   ],
   "ids": [],
   "api": [
    "/api/finder",
    "/api/finder/counts",
    "/api/finder/list",
    "/api/finder/raw",
    "/api/finder/roots",
    "/api/finder/search",
    "/api/finder/stat",
    "/api/finder/text",
    "/api/finder/thumb",
    "/api/finder/write",
    "/api/server/files"
   ],
   "en": "Files · Folder"
  },
  {
   "path": "/gehirn",
   "title": "Gehirn",
   "purpose": "Gehirn: Wissensgraph aus Sessions, Dateien, Aufgaben und Notizen, mit Detailkarte je Knoten.",
   "keywords": [
    "Graph",
    "Wissen",
    "brain",
    "Karte"
   ],
   "nav": "brain",
   "clickPath": [
    "nav:brain"
   ],
   "ids": [],
   "api": [
    "/api/graph",
    "/api/graph/local",
    "/api/graph/node"
   ],
   "en": "Brain"
  },
  {
   "path": "/git",
   "title": "Git",
   "purpose": "Git: Repos, Zweige, Worktrees, letzte Commits und ungesicherte Änderungen.",
   "keywords": [
    "Commits",
    "Branches",
    "Repo",
    "Worktree"
   ],
   "nav": "git",
   "clickPath": [
    "nav:git"
   ],
   "ids": [
    "item:repo",
    "support-open"
   ],
   "api": [],
   "en": "Commits · Worktree"
  },
  {
   "path": "/ideas",
   "title": "Ideen",
   "purpose": "Ideen-Postfach: gesammelte Ideen mit Status und offenen Fragen.",
   "keywords": [
    "Idee",
    "Postfach",
    "ideas"
   ],
   "nav": "idea",
   "clickPath": [
    "nav:idea"
   ],
   "ids": [
    "idea:<…>",
    "item:idea"
   ],
   "api": [],
   "en": "Ideas · Idea"
  },
  {
   "path": "/ideas/:id",
   "title": "Ideen › :id",
   "purpose": "Eine Idee im Detail: Text, offene Fragen, zum Auftrag machen.",
   "keywords": [],
   "nav": "idea",
   "clickPath": [
    "nav:idea",
    "idea:<id>"
   ],
   "ids": [],
   "api": [],
   "en": "Ideas"
  },
  {
   "path": "/inbox",
   "title": "Entscheidungen",
   "purpose": "Entscheidungen: offene Fragen, Freigaben und Sortier-Vorschläge, die auf dich warten.",
   "keywords": [
    "Inbox",
    "Freigaben",
    "Fragen",
    "decisions",
    "approvals"
   ],
   "nav": "inbox",
   "clickPath": [
    "nav:inbox"
   ],
   "ids": [
    "item:decision"
   ],
   "api": [],
   "en": "Decisions · Approvals · Questions"
  },
  {
   "path": "/nyx",
   "title": "Nyx",
   "purpose": "Nyx im Vollbild: sprechen oder schreiben, Netz, Chat-Verlauf, Aufgabenliste, Gedächtnis und Dateien von Nyx.",
   "keywords": [
    "Assistent",
    "Chat",
    "sprechen",
    "assistant"
   ],
   "nav": "nyx",
   "clickPath": [
    "nav:nyx"
   ],
   "ids": [
    "<…>-probe",
    "nyx-antwort-laenge",
    "nyx-aufgaben",
    "nyx-bild-herunterladen",
    "nyx-chat-verlauf",
    "nyx-dateien-ablage",
    "nyx-eingabe",
    "nyx-einstellungen",
    "nyx-faden",
    "nyx-galerie",
    "nyx-gedaechtnis",
    "nyx-kontext",
    "nyx-leiste-umschalten",
    "nyx-menue",
    "nyx-mikro",
    "nyx-netz",
    "nyx-neues-gespraech",
    "nyx-reiter-<…>",
    "nyx-schlafen",
    "nyx-schreiben",
    "nyx-sprechen",
    "nyx-status",
    "nyx-tab",
    "nyx-tempo",
    "nyx-unterbrechen",
    "nyx-untertitel",
    "nyx-vorschau",
    "nyx-zeiten",
    "nyx-zustand",
    "support-open"
   ],
   "api": [
    "/api/graph",
    "/api/haiku/calls",
    "/api/haiku/threads",
    "/api/haiku/tools",
    "/api/nyx/files",
    "/api/nyx/live",
    "/api/nyx/memory",
    "/api/nyx/voice",
    "/api/nyx/voice/status"
   ],
   "en": "Assistant · Chat"
  },
  {
   "path": "/overview",
   "title": "Überblick",
   "purpose": "Startseite: was gerade läuft, was wartet, Builds, Nutzung und Git auf einen Blick.",
   "keywords": [
    "Start",
    "Dashboard",
    "Übersicht",
    "home"
   ],
   "nav": "dash",
   "clickPath": [
    "nav:dash"
   ],
   "ids": [],
   "api": [],
   "en": "Overview · Start"
  },
  {
   "path": "/server",
   "title": "Server",
   "purpose": "Server: Container, Speicher, Deploys und Logs deines Servers.",
   "keywords": [
    "Container",
    "Docker",
    "Deploy",
    "Logs"
   ],
   "nav": "srv",
   "clickPath": [
    "nav:srv"
   ],
   "ids": [],
   "api": [
    "/api/server/files",
    "/api/server/files/list",
    "/api/server/files/raw",
    "/api/server/files/roots",
    "/api/server/files/search",
    "/api/server/files/text",
    "/api/server/host",
    "/api/server/ssh",
    "/api/server/ssh/start",
    "/api/server/ssh/stop"
   ],
   "en": "Server · Containers · Deploy"
  },
  {
   "path": "/sessions",
   "title": "Sessions",
   "purpose": "Alle Claude- und Codex-Sessions nach Art und Baustelle, mit Zustand; neue Session starten.",
   "keywords": [
    "Sitzungen",
    "Chats",
    "Terminal",
    "Claude",
    "Codex"
   ],
   "nav": "ses",
   "clickPath": [
    "nav:ses"
   ],
   "ids": [
    "item:session",
    "neue-session",
    "recent",
    "recent-item:<…>",
    "session-row:<…>",
    "suche"
   ],
   "api": [
    "/api/categories"
   ],
   "en": "Sessions · Terminal · Codex"
  },
  {
   "path": "/sessions/:art",
   "title": "Sessions › :art",
   "purpose": "Sessions einer Art (z. B. Bau, Planung), nach Baustellen gruppiert.",
   "keywords": [],
   "nav": "ses",
   "clickPath": [
    "nav:ses"
   ],
   "ids": [
    "item:session",
    "neue-session",
    "recent",
    "recent-item:<…>",
    "session-row:<…>",
    "suche"
   ],
   "api": [
    "/api/categories"
   ],
   "en": "Sessions"
  },
  {
   "path": "/sessions/:art/:baustelle",
   "title": "Sessions › :art › :baustelle",
   "purpose": "Sessions einer Baustelle innerhalb einer Art.",
   "keywords": [],
   "nav": "ses",
   "clickPath": [
    "nav:ses"
   ],
   "ids": [
    "item:session",
    "neue-session",
    "recent",
    "recent-item:<…>",
    "session-row:<…>",
    "suche"
   ],
   "api": [
    "/api/categories"
   ],
   "en": "Sessions"
  },
  {
   "path": "/sessions/:art/:baustelle/:id",
   "title": "Sessions › :art › :baustelle › :id",
   "purpose": "Eine Session: Chat bzw. Terminal, Ergebnisse, geänderte Dateien, Prüfberichte.",
   "keywords": [],
   "nav": "ses",
   "clickPath": [
    "nav:ses",
    "session-row:<id>"
   ],
   "ids": [
    "item:session",
    "neue-session",
    "recent",
    "recent-item:<…>",
    "session-row:<…>",
    "suche"
   ],
   "api": [
    "/api/categories"
   ],
   "en": "Sessions"
  },
  {
   "path": "/sessions/:art/:baustelle/:id/agenten",
   "title": "Sessions › :art › :baustelle › :id › agenten",
   "purpose": "Die Unter-Agenten einer Session im Vollbild.",
   "keywords": [],
   "nav": "ses",
   "clickPath": [
    "nav:ses",
    "session-row:<id>"
   ],
   "ids": [],
   "api": [
    "/api/sessions"
   ],
   "en": "Sessions"
  },
  {
   "path": "/sessions/:art/:baustelle/:id/agenten/:agentId",
   "title": "Sessions › :art › :baustelle › :id › agenten › :agentId",
   "purpose": "Ein Unter-Agent einer Session mit Verlauf.",
   "keywords": [],
   "nav": "ses",
   "clickPath": [
    "nav:ses",
    "session-row:<id>"
   ],
   "ids": [],
   "api": [
    "/api/sessions"
   ],
   "en": "Sessions"
  },
  {
   "path": "/settings",
   "title": "Einstellungen",
   "purpose": "Übersicht aller Einstellungen in Gruppen (Du, Arbeiten, Nyx & Modelle, System) mit Suche.",
   "keywords": [
    "Settings",
    "Einstellung",
    "Optionen"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings"
   ],
   "ids": [
    "advanced:<…>",
    "child",
    "import-<…>",
    "nyx-stimme-einstellungen",
    "nyx-vorschau",
    "probe-<…>",
    "settings-hit:<…>",
    "settings-search",
    "settings-sub:<…>",
    "settings-sub:telegram",
    "settings:<…>",
    "stimme-bereit",
    "stimme-installieren",
    "stimme-paket",
    "support-open",
    "support-open:<…>",
    "telegram-open-bot",
    "telegram-pairing-code",
    "telegram-pairing-create",
    "telegram-settings",
    "telegram-test",
    "telegram-token-change",
    "telegram-token-input",
    "telegram-token-remove",
    "telegram-token-save",
    "telegram-unpair",
    "telegram-voice-reply"
   ],
   "api": [],
   "en": "Settings"
  },
  {
   "path": "/settings/betrieb",
   "title": "Einstellungen › Betrieb & Zugriff",
   "purpose": "Wo NyxOS läuft und ob alle Verbindungen stehen. Wo NyxOS läuft, wie du es vom Handy erreichst – und ob jede Verbindung steht.",
   "keywords": [
    "Server",
    "Hosting",
    "Brücke",
    "Tailscale",
    "Datenbank",
    "Status"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:betrieb"
   ],
   "tabs": [
    {
     "anchor": "betrieb",
     "title": "Wo NyxOS läuft",
     "keywords": [
      "Eigener Server",
      "Anbieter",
      "Autostart",
      "Tailscale",
      "Cloudflare Tunnel",
      "Domain",
      "HTTPS",
      "Vom Handy erreichen",
      "Nyx hilft"
     ]
    }
   ],
   "spots": [],
   "ids": [
    "child",
    "settings-sub:<…>"
   ],
   "api": [
    "/api/hosting/check",
    "/api/hosting/profile",
    "/api/hosting/secrets",
    "/api/hosting/status"
   ],
   "en": "Settings · Operation & access · Server · Hosting · Bridge · Database · Status · Where NyxOS runs · Where NyxOS runs and whether all connections are up · Where NyxOS runs, how you reach it from your phone – and whether every connection is up."
  },
  {
   "path": "/settings/ideen-links",
   "title": "Einstellungen › Ideen-Links",
   "purpose": "Links, über die andere dir Ideen schicken. Ein Link pro Person: Wer ihn hat, kann Nyx eine Idee erzählen – mehr sieht die Person nicht.",
   "keywords": [
    "Link",
    "Idee einreichen",
    "Mini-Seite"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:ideen-links"
   ],
   "tabs": [
    {
     "anchor": "ideen-links",
     "title": "Ideen-Links",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [],
   "api": [],
   "en": "Settings · Idea links · Link · Submit an idea · Mini page · Links others use to send you ideas · One link per person: whoever has it can tell Nyx an idea – that person sees nothing else."
  },
  {
   "path": "/settings/konto",
   "title": "Einstellungen › Konto & Anmeldung",
   "purpose": "Anmelden, Passkeys, weitere Geräte verbinden. Mit deinem Passkey meldest du dich an – auf jedem Gerät einmal Touch ID.",
   "keywords": [
    "Anmeldung",
    "Anmelden",
    "Abmelden",
    "Überall abmelden",
    "Passkey",
    "Touch ID",
    "Einrichtungs-Code",
    "Neues Gerät",
    "iPhone verbinden"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:konto"
   ],
   "tabs": [
    {
     "anchor": "anmeldung",
     "title": "Anmeldung",
     "keywords": [
      "Passkey",
      "Code erzeugen",
      "Passkeys verwalten"
     ]
    }
   ],
   "spots": [],
   "ids": [
    "advanced:<…>"
   ],
   "api": [],
   "en": "Settings · Account & sign-in · Sign-in · Sign in · Sign out · Sign out everywhere · Passkey · Touch ID · Setup code · New device · Connect iPhone · Sign in, passkeys, connect more devices · You sign in with your passkey – one Touch ID per device."
  },
  {
   "path": "/settings/lernbuch",
   "title": "Einstellungen › Lernbuch",
   "purpose": "Regeln, die NyxOS aus Wiederholungen gelernt hat. Jede Regel ist abschaltbar – abgeschaltet wirkt sie nicht mehr.",
   "keywords": [
    "Regeln",
    "gelernt"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:lernbuch"
   ],
   "tabs": [
    {
     "anchor": "lernbuch",
     "title": "Lernbuch",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [],
   "api": [],
   "en": "Settings · Learned rules · Rules · learned · Rules NyxOS learned from repetition · Every rule can be switched off – then it no longer applies."
  },
  {
   "path": "/settings/mitteilungen",
   "title": "Einstellungen › Mitteilungen",
   "purpose": "Wann und wie NyxOS dich erreicht – Rechner, Browser, Handy, Telegram. Wann NyxOS dich meldet, wie die Mitteilung geschrieben ist und ob Nyx sie vorher prüft oder selbst schreibt.",
   "keywords": [
    "Benachrichtigung",
    "Push",
    "Fokus",
    "Nicht stören",
    "Ich bin weg"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:mitteilungen"
   ],
   "tabs": [
    {
     "anchor": "fokus",
     "title": "Fokus",
     "keywords": [
      "Fokus",
      "Nicht stören",
      "Ich bin weg",
      "Automatisch"
     ]
    },
    {
     "anchor": "push",
     "title": "Mitteilungen",
     "keywords": [
      "Push"
     ]
    }
   ],
   "spots": [
    {
     "anchor": "wann",
     "keywords": [
      "Wann",
      "Anlässe",
      "Immer",
      "Nur wenn ich weg bin",
      "Unter-Agenten",
      "Kontext-Wächter melden"
     ]
    },
    {
     "anchor": "wege",
     "keywords": [
      "Rechner",
      "Browser",
      "Handy",
      "Test-Mitteilung"
     ]
    },
    {
     "anchor": "verlauf",
     "keywords": [
      "Verlauf",
      "Passt",
      "Brauche ich nicht",
      "Regel-Vorschlag"
     ]
    },
    {
     "anchor": "erweitert-ruhezeit",
     "keywords": [
      "Ruhezeit",
      "Nachtruhe"
     ]
    },
    {
     "anchor": "erweitert-abstand",
     "keywords": [
      "Mindestabstand",
      "Bündelung",
      "Wartezeit",
      "Sammel-Mitteilung"
     ]
    },
    {
     "anchor": "erweitert-weg",
     "keywords": [
      "Wenn ich weg bin",
      "Abwesenheit",
      "Weg-Erkennung"
     ]
    },
    {
     "anchor": "erweitert-vorlagen",
     "keywords": [
      "Vorlage",
      "Platzhalter"
     ]
    },
    {
     "anchor": "erweitert-iphone",
     "keywords": [
      "iPhone",
      "ntfy",
      "QR-Code"
     ]
    },
    {
     "anchor": "erweitert-klick",
     "keywords": [
      "Klick-Adresse"
     ]
    }
   ],
   "ids": [
    "settings-sub:<…>",
    "settings-sub:telegram"
   ],
   "api": [
    "/api/focus",
    "/api/notifications",
    "/api/notifications/history",
    "/api/notifications/preview",
    "/api/notifications/settings",
    "/api/push/subscribe",
    "/api/push/test"
   ],
   "en": "Settings · Notifications · Notification · Push · Focus · Do not disturb · I'm away · When and how NyxOS reaches you – computer, browser, phone, Telegram · When NyxOS notifies you, how the notification is written and whether Nyx checks or writes it first."
  },
  {
   "path": "/settings/mitteilungen-nyx",
   "title": "Einstellungen › Mitteilungen › Nyx prüft & schreibt",
   "purpose": "Nyx sieht Mitteilungen vorher an oder schreibt sie selbst. Nyx kann jede Mitteilung vorher ansehen und selbst schreiben. Jede Entscheidung steht mit Grund im Verlauf.",
   "keywords": [
    "Nyx prüft",
    "Nyx schreibt",
    "Was mir wichtig ist",
    "Dringendes"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:mitteilungen",
    "settings-sub:mitteilungen-nyx"
   ],
   "tabs": [
    {
     "anchor": "nyx-pruefen",
     "title": "Nyx prüft & schreibt",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [
    "settings-sub:<…>",
    "settings-sub:telegram"
   ],
   "api": [
    "/api/notifications",
    "/api/notifications/history",
    "/api/notifications/preview",
    "/api/notifications/settings",
    "/api/push/subscribe",
    "/api/push/test"
   ],
   "en": "Settings · Notifications · Nyx checks & writes · Nyx checks · Nyx writes · What matters to me · Urgent · Nyx looks at notifications first or writes them itself · Nyx can look at every notification first and write it. Every decision is in the history with a reason."
  },
  {
   "path": "/settings/mitteilungen-stil",
   "title": "Einstellungen › Mitteilungen › Wie geschrieben?",
   "purpose": "Stil der Mitteilungen mit Vorschau. So klingt eine Mitteilung. Der Name ist immer der Titel der Session oder die Baustelle – nie der rohe Prompt.",
   "keywords": [
    "Stil",
    "Wie geschrieben",
    "Vorschau",
    "Knapp",
    "Ausführlich",
    "Mit Zusammenhang"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:mitteilungen",
    "settings-sub:mitteilungen-stil"
   ],
   "tabs": [
    {
     "anchor": "wie",
     "title": "Wie geschrieben?",
     "keywords": [
      "Beispiel",
      "Sperrbildschirm"
     ]
    }
   ],
   "spots": [],
   "ids": [
    "settings-sub:<…>",
    "settings-sub:telegram"
   ],
   "api": [
    "/api/notifications",
    "/api/notifications/history",
    "/api/notifications/preview",
    "/api/notifications/settings",
    "/api/push/subscribe",
    "/api/push/test"
   ],
   "en": "Settings · Notifications · How written? · Style · How written · Preview · Short · Detailed · With context · Style of notifications with preview · This is how a notification sounds. The name is always the session title or the work area – never the raw prompt."
  },
  {
   "path": "/settings/modelle",
   "title": "Einstellungen › Modelle & Konnektoren",
   "purpose": "Welches Modell was macht, dazu MCP-Konnektoren. Jede Aufgabe von Nyx hat ein Modell. Ohne eigene Wahl gilt der Standard.",
   "keywords": [
    "Modell",
    "Anbieter",
    "Rollen",
    "Claude",
    "OpenAI",
    "Ollama",
    "LM Studio"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:modelle"
   ],
   "tabs": [
    {
     "anchor": "modelle",
     "title": "Modelle",
     "keywords": [
      "Rolle",
      "Standard-Modell",
      "Anbieter hinzufügen"
     ]
    },
    {
     "anchor": "konnektoren",
     "title": "Konnektoren",
     "advanced": true,
     "keywords": [
      "MCP",
      "Konnektor",
      "Werkzeuge"
     ]
    }
   ],
   "spots": [],
   "ids": [],
   "api": [
    "/api/access",
    "/api/access/bulk",
    "/api/mcp/connectors",
    "/api/models/catalog",
    "/api/models/providers",
    "/api/models/roles"
   ],
   "en": "Settings · Models & connectors · Model · Provider · Roles · Models · Connectors · Which model does what, plus MCP connectors · Every Nyx task has a model. Without your own choice the default applies."
  },
  {
   "path": "/settings/nutzung",
   "title": "Einstellungen › Nutzung & Nachtmodus",
   "purpose": "Ziele, Warnschwellen und der Nachtlauf. Wie viel du nutzen willst, wann NyxOS warnt und wann nachts gearbeitet wird.",
   "keywords": [
    "Verbrauch",
    "Tokens"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:nutzung"
   ],
   "tabs": [
    {
     "anchor": "nutzung",
     "title": "Nutzung",
     "keywords": [
      "Ziele",
      "Warnschwelle",
      "Zeitraum",
      "Limit"
     ]
    },
    {
     "anchor": "nachtmodus",
     "title": "Nachtmodus",
     "keywords": [
      "Nachtlauf",
      "Nacht",
      "Budget in der Nacht"
     ]
    }
   ],
   "spots": [],
   "ids": [],
   "api": [
    "/api/night/settings",
    "/api/usage/baustellen",
    "/api/usage/compare",
    "/api/usage/daily",
    "/api/usage/goals",
    "/api/usage/hourly",
    "/api/usage/limits",
    "/api/usage/model-trend",
    "/api/usage/models",
    "/api/usage/prices",
    "/api/usage/sessions",
    "/api/usage/settings",
    "/api/usage/window"
   ],
   "en": "Settings · Usage & night mode · Consumption · Tokens · Usage · Night mode · Goals, warning thresholds and the night run · How much you want to use, when NyxOS warns and when work happens at night."
  },
  {
   "path": "/settings/sessions",
   "title": "Einstellungen › Sessions",
   "purpose": "Zustände, Kontext-Wächter und Wegwerf-Chats. Wie NyxOS Sessions einsortiert, wann es zum Komprimieren rät und wie lange Wegwerf-Chats bleiben.",
   "keywords": [
    "Session"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:sessions"
   ],
   "tabs": [
    {
     "anchor": "zustaende",
     "title": "Zustände",
     "keywords": [
      "Erledigt",
      "Wartet",
      "Zustand"
     ]
    },
    {
     "anchor": "kontext-waechter",
     "title": "Kontext-Wächter",
     "keywords": [
      "Kontext",
      "Komprimieren",
      "compact",
      "Schwelle",
      "Prozent"
     ]
    },
    {
     "anchor": "wegwerf-chats",
     "title": "Wegwerf-Chats",
     "keywords": [
      "Temporär",
      "Wegwerf",
      "Löschen nach Stunden"
     ]
    }
   ],
   "spots": [],
   "ids": [
    "advanced:<…>"
   ],
   "api": [
    "/api/context-guard/sessions",
    "/api/context-guard/settings",
    "/api/context-guard/settings/default",
    "/api/context-guard/settings/haiku",
    "/api/context-guard/settings/model",
    "/api/context-guard/settings/session",
    "/api/sessions",
    "/api/settings/session-state",
    "/api/temporary/archive",
    "/api/temporary/settings"
   ],
   "en": "Settings · Sessions · Session · States · Context guard · Throwaway chats · States, context guard and throwaway chats · How NyxOS sorts sessions, when it suggests compacting and how long throwaway chats stay."
  },
  {
   "path": "/settings/telegram",
   "title": "Einstellungen › Mitteilungen › Telegram",
   "purpose": "Mit Nyx vom Handy schreiben, Freigaben unterwegs beantworten. Mit Nyx vom Handy aus sprechen: schreiben, Sprachnachrichten schicken, Sessions wählen und starten, /compact, Freigaben per Knopf.",
   "keywords": [
    "Telegram-Bot",
    "Kopplung",
    "Kopplungs-Code",
    "Bot-Token",
    "BotFather"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:mitteilungen",
    "settings-sub:telegram"
   ],
   "tabs": [
    {
     "anchor": "telegram",
     "title": "Telegram",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [
    "telegram-open-bot",
    "telegram-pairing-code",
    "telegram-pairing-create",
    "telegram-settings",
    "telegram-test",
    "telegram-token-change",
    "telegram-token-input",
    "telegram-token-remove",
    "telegram-token-save",
    "telegram-unpair",
    "telegram-voice-reply"
   ],
   "api": [
    "/api/telegram/pairing",
    "/api/telegram/settings",
    "/api/telegram/status",
    "/api/telegram/test",
    "/api/telegram/token"
   ],
   "en": "Settings · Notifications · Telegram · Telegram bot · Pairing · Pairing code · Bot token · Write to Nyx from your phone, answer approvals on the go · Talk to Nyx from your phone: write, send voice messages, choose and start sessions, /compact, approvals by button."
  },
  {
   "path": "/settings/unterstuetzen",
   "title": "Einstellungen › Feedback & Unterstützen",
   "purpose": "Fehler melden, Idee schicken oder das Projekt mit Tokens unterstützen. Alles bleibt in NyxOS: Meldungen gehen über deinen eigenen Server raus, Bezahlen passiert eingebettet.",
   "keywords": [
    "Fehler melden",
    "Bug",
    "Idee schicken",
    "Wunsch",
    "Buy me Tokens",
    "Spenden",
    "Postausgang"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:unterstuetzen"
   ],
   "tabs": [
    {
     "anchor": "unterstuetzen",
     "title": "Feedback & Unterstützen",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [
    "support-open:<…>"
   ],
   "api": [
    "/api/support",
    "/api/support/bug",
    "/api/support/donate",
    "/api/support/flush",
    "/api/support/idea",
    "/api/support/outbox",
    "/api/support/settings",
    "/api/support/state"
   ],
   "en": "Settings · Feedback & support · Report a bug · Bug · Send an idea · Wish · Buy me Tokens · Donate · Outbox · Report a bug, send an idea or support the project with tokens. · Everything stays in NyxOS: reports go out through your own server, payment happens embedded."
  },
  {
   "path": "/settings/verbindungen",
   "title": "Einstellungen › Betrieb & Zugriff › Verbindungen",
   "purpose": "Jede Verbindung von NyxOS, echt geprüft. Jede Verbindung von NyxOS, vom Server echt geprüft — mit Antwortzeit. Ist etwas gestört, steht darunter, warum und was hilft. „Nur du“ heißt: Das kannst nur du lösen, der Befehl steht zum Kopieren bereit.",
   "keywords": [
    "Verbindung prüfen",
    "Jetzt prüfen",
    "gestört",
    "Brücke",
    "Datenbank"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:betrieb",
    "settings-sub:verbindungen"
   ],
   "tabs": [
    {
     "anchor": "verbindungen",
     "title": "Verbindungen",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [
    "support-open"
   ],
   "api": [
    "/api/connections"
   ],
   "en": "Settings · Operation & access · Connections · Check connection · Check now · failing · Bridge · Database · Every connection of NyxOS, actually checked · Every NyxOS connection, actually checked by the server — with response time. If something is broken, you'll see why and what helps. “Only you” means only you can fix it; the command is ready to copy."
  },
  {
   "path": "/settings/zugaenge",
   "title": "Einstellungen › Zugänge & Schlüssel",
   "purpose": "Schlüssel und Tokens für Modelle, Telegram und mehr. Gespeichert wird verschlüsselt; angezeigt werden nur die letzten 4 Zeichen.",
   "keywords": [
    "Schlüssel",
    "Token",
    "API-Key",
    "Anthropic",
    "OpenAI",
    "ElevenLabs",
    "Alles auf einmal einrichten"
   ],
   "nav": "settings",
   "clickPath": [
    "nav:settings",
    "settings:zugaenge"
   ],
   "tabs": [
    {
     "anchor": "zugaenge",
     "title": "Zugänge",
     "keywords": []
    }
   ],
   "spots": [],
   "ids": [],
   "api": [
    "/api/access",
    "/api/access/bulk",
    "/api/models/catalog"
   ],
   "en": "Settings · Credentials & keys · Key · Token · API key · Set up everything at once · Credentials · Keys and tokens for models, Telegram and more · Stored encrypted; only the last 4 characters are shown."
  },
  {
   "path": "/skills",
   "title": "Skills",
   "purpose": "Skill-Bibliothek: alle Skills als Kacheln mit Nutzungszahlen (sortiert nach Nutzung), Großansicht je Skill.",
   "keywords": [
    "Skill",
    "Skills",
    "Befehle",
    "Slash",
    "meistgenutzt",
    "Nutzung"
   ],
   "nav": "skills",
   "clickPath": [
    "nav:skills"
   ],
   "ids": [
    "skill-<…>",
    "skills-job-start",
    "skills-new",
    "skills-sync"
   ],
   "api": [
    "/api/skills",
    "/api/skills/jobs",
    "/api/skills/suggestions",
    "/api/skills/sync"
   ],
   "en": "Usage"
  },
  {
   "path": "/skills/:key",
   "title": "Skills › :key",
   "purpose": "Großansicht eines Skills: Beschreibung, Nutzung über die Zeit, Verbesserungs-Vorschläge.",
   "keywords": [],
   "nav": "skills",
   "clickPath": [
    "nav:skills",
    "skill-<key>"
   ],
   "ids": [
    "skill-<…>",
    "skill-improve",
    "skill-suggestion-apply-<…>",
    "skills-job-start",
    "skills-new",
    "skills-sync"
   ],
   "api": [
    "/api/skills",
    "/api/skills/jobs",
    "/api/skills/suggestions",
    "/api/skills/sync"
   ]
  },
  {
   "path": "/tasks",
   "title": "Aufgaben",
   "purpose": "Aufgaben, Bugs und Befunde mit Stufe und Priorität; Aufträge starten.",
   "keywords": [
    "To-dos",
    "Bugs",
    "tasks",
    "Aufträge"
   ],
   "nav": "task",
   "clickPath": [
    "nav:task"
   ],
   "ids": [
    "agent-starten",
    "aufgabe-starten",
    "bericht-lesen",
    "item:task"
   ],
   "api": [],
   "en": "Tasks · To-dos · Bugs · Jobs"
  },
  {
   "path": "/usage",
   "title": "Nutzung",
   "purpose": "Nutzung: Verbrauch und Kosten je Tag, 5-Stunden-Fenster und Abo-Limits.",
   "keywords": [
    "Kosten",
    "Verbrauch",
    "Limit",
    "Tokens",
    "usage"
   ],
   "nav": "use",
   "clickPath": [
    "nav:use"
   ],
   "ids": [],
   "api": [
    "/api/usage/baustellen",
    "/api/usage/compare",
    "/api/usage/daily",
    "/api/usage/goals",
    "/api/usage/hourly",
    "/api/usage/limits",
    "/api/usage/model-trend",
    "/api/usage/models",
    "/api/usage/prices",
    "/api/usage/sessions",
    "/api/usage/settings",
    "/api/usage/window"
   ],
   "en": "Usage · Cost · Consumption · Limit · Tokens"
  }
 ],
 "globalIds": [
  "nav:<…>",
  "palette",
  "tabbar:<…>",
  "tabbar:mehr"
 ],
 "api": [
  {
   "method": "GET",
   "path": "/api/sessions",
   "purpose": "Alle Sessions (Claude/Codex) mit Zustand, Titel, Baustelle – `limit` in query"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id",
   "purpose": "Eine Session im Detail (Ereignisse, Dateien)"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/transcript",
   "purpose": "Chat-Verlauf einer Session, seitenweise (query: direction, limit, cursor)"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/chat",
   "purpose": "Chat-Ansicht einer Session"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/message",
   "purpose": "Text in eine laufende Session schreiben (body: { text }) – wie das Eingabefeld im Session-Chat"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/deliveries",
   "purpose": "Wartende Nachrichten an eine Session (Zustell-Warteschlange)"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/assign",
   "purpose": "Session einsortieren (body: { art?, baustelle? })"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/unassign",
   "purpose": "Einsortieren rückgängig"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/close",
   "purpose": "Session als geschlossen markieren (braucht Bestätigung)"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/reopen",
   "purpose": "Geschlossene Session wieder öffnen"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/opened",
   "purpose": "Session als geöffnet merken (zuletzt geöffnet)"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/temporary",
   "purpose": "Session als temporär markieren bzw. behalten"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/outcomes",
   "purpose": "Was in einer Session erledigt/behoben/offen ist"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/changes",
   "purpose": "Geänderte Dateien einer Session"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/agents",
   "purpose": "Sub-Agenten einer Session"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/agents-live",
   "purpose": "Agenten einer Session live (laufend, fertig, Archiv je Lauf) mit Laufzeit, Tokens, letzter Aktion"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/agents-live/:agentId",
   "purpose": "Ein Agent einer Session im Detail (letzte Schritte, Auftrag, Ergebnis)"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/agents/:agentId/hide",
   "purpose": "Agent aus einem früheren Lauf im Archiv aus- bzw. einblenden (body: { hidden: true|false })"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/agents/:agentId/task",
   "purpose": "Auftrag + Ergebnis eines Agenten als Aufgabe übernehmen (zweimal = dieselbe Aufgabe)"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/audits",
   "purpose": "Prüfberichte einer Session"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/audits",
   "purpose": "Session zusammenfassen & prüfen lassen"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/summary",
   "purpose": "Letzte ausführliche Zusammenfassung einer Session (Markdown) + neue Nachrichten seitdem"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/summary",
   "purpose": "Nyx fasst die Session ausführlich zusammen (Ziel, erledigt, läuft, offen, nächster Schritt) – erscheint oben im Session-Chat"
  },
  {
   "method": "GET",
   "path": "/api/sessions/:id/controls",
   "purpose": "Was sich in einer Session steuern lässt: aktuelles Modell, mögliche Modelle (nur die des Werkzeugs), Denkaufwand-Stufen, Komprimieren"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/controls",
   "purpose": "Modell wechseln ({ kind: \"model\", model: <id aus GET …/controls> }) oder Denkaufwand setzen ({ kind: \"effort\", level }) – geht raus, sobald die Session wartet"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/prompt-assist",
   "purpose": "Prompt für eine Session verbessern lassen"
  },
  {
   "method": "GET",
   "path": "/api/recent-sessions",
   "purpose": "Zuletzt geöffnete Sessions"
  },
  {
   "method": "GET",
   "path": "/api/search",
   "purpose": "Sessions durchsuchen (query: q)"
  },
  {
   "method": "GET",
   "path": "/api/terminal/status",
   "purpose": "Ist die Brücke verbunden?"
  },
  {
   "method": "GET",
   "path": "/api/terminal/folders",
   "purpose": "Ordner, in denen eine neue Session starten kann"
  },
  {
   "method": "POST",
   "path": "/api/terminal/start",
   "purpose": "Neue Session starten (body: { tool: claude|codex, model z. B. claude-opus-5-5, cwd, prompt })"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/resume",
   "purpose": "Beendete Session fortsetzen"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/kill",
   "purpose": "Session-Prozess beenden (body: { confirm: true }, braucht Bestätigung)"
  },
  {
   "method": "POST",
   "path": "/api/sessions/:id/takeover/preview",
   "purpose": "Übernahme einer Session vorab prüfen"
  },
  {
   "method": "GET",
   "path": "/api/entries",
   "purpose": "Aufgaben, Bugs, Ideen, Fragen, Audit-Befunde (query: kind, stage, q)"
  },
  {
   "method": "POST",
   "path": "/api/entries",
   "purpose": "Aufgabe/Bug/Idee anlegen (body: { kind, title, description? })"
  },
  {
   "method": "GET",
   "path": "/api/entries/:id",
   "purpose": "Einen Eintrag lesen"
  },
  {
   "method": "PATCH",
   "path": "/api/entries/:id",
   "purpose": "Eintrag ändern (Titel, Stufe, Priorität …)"
  },
  {
   "method": "POST",
   "path": "/api/entries/:id/start",
   "purpose": "Auftrag starten (autonome Session)"
  },
  {
   "method": "GET",
   "path": "/api/entries/:id/start-plan",
   "purpose": "Start-Plan eines Auftrags"
  },
  {
   "method": "POST",
   "path": "/api/entries/:id/progress",
   "purpose": "Fortschritt eines Eintrags melden"
  },
  {
   "method": "GET",
   "path": "/api/inbox",
   "purpose": "Offene Entscheidungen/Fragen (query: status=all für alle)"
  },
  {
   "method": "POST",
   "path": "/api/inbox/:id/answer",
   "purpose": "Entscheidung beantworten (braucht Bestätigung)"
  },
  {
   "method": "GET",
   "path": "/api/approvals",
   "purpose": "Offene Freigaben (Leitplanken)"
  },
  {
   "method": "POST",
   "path": "/api/approvals/:id/decide",
   "purpose": "Freigabe entscheiden (braucht Bestätigung)"
  },
  {
   "method": "GET",
   "path": "/api/open-questions",
   "purpose": "Offene Fragen"
  },
  {
   "method": "GET",
   "path": "/api/hosting/status",
   "purpose": "Wie NyxOS gerade läuft (Lokal/Server, Adressen, Brücke, vom Handy erreichbar?)"
  },
  {
   "method": "GET",
   "path": "/api/hosting/profile",
   "purpose": "Betrieb & Zugriff: gewählter Weg, Formularwerte, letzte Prüfungen (Geheimnisse nur „gesetzt“)"
  },
  {
   "method": "PUT",
   "path": "/api/hosting/profile",
   "purpose": "Betrieb & Zugriff speichern (immer das ganze Profil: { way, phoneWay, forms }, keine Geheimnisse)"
  },
  {
   "method": "POST",
   "path": "/api/hosting/check",
   "purpose": "Adresse prüfen (body: { target: local|server|provider|tailscale|cloudflare|domain, url? }) – ruft <url>/health"
  },
  {
   "method": "GET",
   "path": "/api/support/state",
   "purpose": "Postausgang (wartende/gesendete Meldungen), Entwürfe, ob die Meldestelle eingerichtet ist"
  },
  {
   "method": "PUT",
   "path": "/api/support/draft",
   "purpose": "Entwurf vorbereiten – Fehler (body: { kind: 'bug', what, before?, expected? }) oder Idee (body: { kind: 'idea', title, description, importance: nice|important|essential }); der Nutzer prüft und sendet selbst. Das Blatt öffnen: ui navigate auf eine Seite mit ?support=bug|idea|tokens"
  },
  {
   "method": "POST",
   "path": "/api/support/bug",
   "purpose": "Fehlermeldung senden (braucht Bestätigung)"
  },
  {
   "method": "POST",
   "path": "/api/support/idea",
   "purpose": "Idee senden (braucht Bestätigung)"
  },
  {
   "method": "POST",
   "path": "/api/support/flush",
   "purpose": "Wartende Meldungen jetzt senden"
  },
  {
   "method": "GET",
   "path": "/api/nyx/profile",
   "purpose": "Nyx-Profil (Persönlichkeit, Regler, Nutzerangaben)"
  },
  {
   "method": "PUT",
   "path": "/api/nyx/profile",
   "purpose": "Nyx-Profil speichern (immer das ganze Profil)"
  },
  {
   "method": "GET",
   "path": "/api/nyx/presets",
   "purpose": "Vorlagen für die Nyx-Regler"
  },
  {
   "method": "POST",
   "path": "/api/nyx/presets",
   "purpose": "Eigene Regler-Vorlage anlegen"
  },
  {
   "method": "GET",
   "path": "/api/nyx/voice/settings",
   "purpose": "Stimmen-Einstellungen"
  },
  {
   "method": "PUT",
   "path": "/api/nyx/voice/settings",
   "purpose": "Stimmen-Einstellungen speichern"
  },
  {
   "method": "GET",
   "path": "/api/nyx/memory",
   "purpose": "Nyx-Gedächtnis"
  },
  {
   "method": "GET",
   "path": "/api/nyx/schedules",
   "purpose": "Geplante Aufgaben"
  },
  {
   "method": "GET",
   "path": "/api/haiku/status",
   "purpose": "Zustand des Nyx-Motors"
  },
  {
   "method": "PATCH",
   "path": "/api/haiku/settings",
   "purpose": "Nyx-Motor-Einstellungen (Budget, Zeitgrenze …)"
  },
  {
   "method": "GET",
   "path": "/api/haiku/threads",
   "purpose": "Nyx-Chats"
  },
  {
   "method": "PATCH",
   "path": "/api/haiku/threads/:id",
   "purpose": "Nyx-Chat umbenennen/archivieren"
  },
  {
   "method": "GET",
   "path": "/api/models/roles",
   "purpose": "Welches Modell für welche Rolle"
  },
  {
   "method": "PUT",
   "path": "/api/models/roles/:role",
   "purpose": "Modell für eine Rolle wählen"
  },
  {
   "method": "GET",
   "path": "/api/push/settings",
   "purpose": "Mitteilungs-Einstellungen"
  },
  {
   "method": "PATCH",
   "path": "/api/push/settings",
   "purpose": "Mitteilungs-Einstellungen ändern"
  },
  {
   "method": "GET",
   "path": "/api/telegram/status",
   "purpose": "Telegram-Stand"
  },
  {
   "method": "PATCH",
   "path": "/api/telegram/settings",
   "purpose": "Telegram-Einstellungen ändern"
  },
  {
   "method": "GET",
   "path": "/api/away/settings",
   "purpose": "„Wenn ich weg bin“-Einstellungen"
  },
  {
   "method": "PATCH",
   "path": "/api/away/settings",
   "purpose": "„Wenn ich weg bin“ ändern"
  },
  {
   "method": "GET",
   "path": "/api/focus",
   "purpose": "Fokus (Automatisch, Ich bin weg, Nicht stören)"
  },
  {
   "method": "PUT",
   "path": "/api/focus",
   "purpose": "Fokus setzen – z. B. „Ich bin weg bis 18 Uhr“ ({ mode: away|dnd|auto, duration: 1h|evening|morning|manual } oder until als ISO-Zeit)"
  },
  {
   "method": "GET",
   "path": "/api/night/settings",
   "purpose": "Nachtmodus-Einstellungen"
  },
  {
   "method": "PATCH",
   "path": "/api/night/settings",
   "purpose": "Nachtmodus ändern"
  },
  {
   "method": "GET",
   "path": "/api/temporary/settings",
   "purpose": "Einstellungen für temporäre Sessions"
  },
  {
   "method": "PATCH",
   "path": "/api/temporary/settings",
   "purpose": "Temporäre Sessions einstellen"
  },
  {
   "method": "GET",
   "path": "/api/context-guard/settings",
   "purpose": "Kontext-Wächter-Einstellungen"
  },
  {
   "method": "POST",
   "path": "/api/context-guard/sessions/:id/compact-now",
   "purpose": "Session jetzt komprimieren"
  },
  {
   "method": "GET",
   "path": "/api/usage/settings",
   "purpose": "Nutzungs-Einstellungen (Warnschwellen)"
  },
  {
   "method": "PATCH",
   "path": "/api/usage/settings",
   "purpose": "Nutzungs-Einstellungen ändern"
  },
  {
   "method": "GET",
   "path": "/api/overview",
   "purpose": "Überblick (wie der Start-Tab)"
  },
  {
   "method": "GET",
   "path": "/api/changes",
   "purpose": "Was ist neu"
  },
  {
   "method": "GET",
   "path": "/api/git",
   "purpose": "Git-Stand aller Repos"
  },
  {
   "method": "GET",
   "path": "/api/git/dashboard",
   "purpose": "Git-Übersicht"
  },
  {
   "method": "GET",
   "path": "/api/git/commits",
   "purpose": "Letzte Commits"
  },
  {
   "method": "GET",
   "path": "/api/conflicts/summary",
   "purpose": "Konflikte (mehrere Sessions am selben Ordner)"
  },
  {
   "method": "GET",
   "path": "/api/server",
   "purpose": "Server-Lage (Container, Speicher, Deploys)"
  },
  {
   "method": "GET",
   "path": "/api/server/containers/:id/logs",
   "purpose": "Log eines Containers"
  },
  {
   "method": "GET",
   "path": "/api/builds",
   "purpose": "Build-Läufe"
  },
  {
   "method": "POST",
   "path": "/api/builds/run",
   "purpose": "Build starten"
  },
  {
   "method": "GET",
   "path": "/api/usage/daily",
   "purpose": "Nutzung je Tag"
  },
  {
   "method": "GET",
   "path": "/api/usage/window",
   "purpose": "Nutzung im 5-Stunden-Fenster"
  },
  {
   "method": "GET",
   "path": "/api/usage/limits",
   "purpose": "Abo-Limits"
  },
  {
   "method": "GET",
   "path": "/api/skills",
   "purpose": "Skill-Bibliothek"
  },
  {
   "method": "GET",
   "path": "/api/agents/runs",
   "purpose": "Agenten-Läufe"
  },
  {
   "method": "GET",
   "path": "/api/files",
   "purpose": "Dateien, die Sessions angefasst haben"
  },
  {
   "method": "GET",
   "path": "/api/finder/list",
   "purpose": "Ordner auf dem Rechner auflisten (query: root, p)"
  },
  {
   "method": "GET",
   "path": "/api/finder/text",
   "purpose": "Textdatei auf dem Rechner lesen (query: root, p)"
  },
  {
   "method": "POST",
   "path": "/api/finder/write",
   "purpose": "Text-/Markdown-Datei auf dem Rechner speichern (mit Sicherungskopie)"
  },
  {
   "method": "GET",
   "path": "/api/search/all",
   "purpose": "Suche über alles (query: q)"
  }
 ],
 "tables": [
  {
   "name": "agent_catalog",
   "description": "",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "name"
    },
    {
     "name": "description"
    },
    {
     "name": "path"
    },
    {
     "name": "source"
    },
    {
     "name": "machine_id"
    },
    {
     "name": "seen_at"
    },
    {
     "name": "details",
     "note": "Modell, Werkzeuge, Farbe, Prompt eines Agenten (nur `kind = 'agent'`), sonst null."
    }
   ]
  },
  {
   "name": "app_settings",
   "description": "App-wide settings (one row, `id = 1`): language, the user's name, onboarding state, automatic updates.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "de"
    },
    {
     "name": "user_name"
    },
    {
     "name": "onboarding_done"
    },
    {
     "name": "auto_update"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "approvals",
   "description": "Freigabe-Anfragen aus dem Leitplanken-Hook. Eine Freigabe erlaubt GENAU EINEN Befehl (`commandHash` + Session), danach `consumed`.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "pending"
    },
    {
     "name": "rule"
    },
    {
     "name": "reason"
    },
    {
     "name": "tool"
    },
    {
     "name": "command"
    },
    {
     "name": "command_hash"
    },
    {
     "name": "cwd"
    },
    {
     "name": "session_key"
    },
    {
     "name": "auftrag"
    },
    {
     "name": "worktree"
    },
    {
     "name": "attempts"
    },
    {
     "name": "created_at"
    },
    {
     "name": "decided_at"
    },
    {
     "name": "decided_by"
    },
    {
     "name": "consumed_at"
    }
   ]
  },
  {
   "name": "archive",
   "description": "Archivierte Verlaufsdateien (gzip auf dem Volume) mit Prüfsumme der Rohdatei.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "tool"
    },
    {
     "name": "path"
    },
    {
     "name": "sha256"
    },
    {
     "name": "size"
    },
    {
     "name": "gz_size"
    },
    {
     "name": "stored_path"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "archive_digests",
   "description": "vorverdaute Kennzahlen je Archiv-Datei (Haupt-Verlauf oder `subagents/agent-*.jsonl`), damit die Seitenpanels nicht bei jedem Öffnen Hunderte MB Verlauf neu lesen müssen (eine echte Session hat 190 Sub-Agent-Dateien, 318 MB). Gültig, solange `sha256` = `archive.sha256`; eine neue Archiv-Fassung rechnet die Zeile neu (`session-digest.ts`). `version` hebt man an, wenn sich die Auswertung ändert — alte Zeilen werden dann beim nächsten Zugriff neu gerechnet.",
   "columns": [
    {
     "name": "archive_id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "agent_id",
     "note": "`null` = Haupt-Verlauf, sonst die Sub-Agent-Kennung aus dem Dateinamen."
    },
    {
     "name": "sha256"
    },
    {
     "name": "version"
    },
    {
     "name": "digest"
    },
    {
     "name": "computed_at"
    }
   ]
  },
  {
   "name": "auth_credentials",
   "description": "Anmeldung: Passkeys vom Nutzer (WebAuthn). `id` = Credential-ID (base64url).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "public_key"
    },
    {
     "name": "counter"
    },
    {
     "name": "transports"
    },
    {
     "name": "rp_id"
    },
    {
     "name": "name"
    },
    {
     "name": "created_at"
    },
    {
     "name": "last_used_at"
    }
   ]
  },
  {
   "name": "auth_sessions",
   "description": "Anmelde-Sitzungen (Cookie). Gespeichert nur der SHA-256 des Cookie-Werts, nie der Wert selbst.",
   "columns": [
    {
     "name": "token_hash"
    },
    {
     "name": "csrf"
    },
    {
     "name": "credential_id"
    },
    {
     "name": "created_at"
    },
    {
     "name": "expires_at"
    },
    {
     "name": "last_seen_at"
    }
   ]
  },
  {
   "name": "auth_setup_codes",
   "description": "Einmal-Codes zum Einrichten eines Passkeys (per CLI erzeugt, 15 Min gültig, nur Hash gespeichert).",
   "columns": [
    {
     "name": "code_hash"
    },
    {
     "name": "expires_at"
    },
    {
     "name": "used_at"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "away_settings",
   "description": "Abwesenheit (Migration 0038): Einstellungen „Wenn ich weg bin“ – eine Zeile (`id = 1`), Werte als JSON, fehlende Schlüssel = Standard (`DEFAULT_AWAY_SETTINGS`). Wer gerade da ist, weiß nur der Speicher (Herzschlag).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "settings"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "bridge_events",
   "description": "Verlauf der Brücken-Verbindung: eine Zeile je Abschnitt (online / verbindet neu / offline mit Grund). Geht „verbindet neu\" in einen echten Ausfall über, wird dieselbe Zeile auf „offline\" gesetzt (Beginn bleibt), statt zwei Zeilen zu schreiben. Dauer = Abstand zur nächsten Zeile.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "machine_id"
    },
    {
     "name": "at"
    },
    {
     "name": "state"
    },
    {
     "name": "reason"
    }
   ]
  },
  {
   "name": "build_runs",
   "description": "Build-Wächter. Ein Lauf je Prüfung (iOS/Backend/NyxOS). `derivedDataPath` nur bei `kind = 'ios'` gesetzt (eigener Pfad je Worktree, s. `builds/runner.ts` — nie des Nutzers eigene DerivedData). `logExcerpt` = letzte `BUILD_LOG_EXCERPT_LINES` Zeilen; der volle Log bleibt nur in der Prozess-Ausgabe (kein eigenes Log-Volume in P8, s. Bericht \"offene Punkte\").",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "kind"
    },
    {
     "name": "command"
    },
    {
     "name": "queued"
    },
    {
     "name": "exit_code"
    },
    {
     "name": "log_excerpt"
    },
    {
     "name": "derived_data_path"
    },
    {
     "name": "trigger"
    },
    {
     "name": "started_at"
    },
    {
     "name": "ended_at"
    },
    {
     "name": "folder",
     "note": "BC: Arbeitsordner der Prüfung — ein späterer grüner Lauf im selben Ordner behebt frühere rote („Braucht dich“ räumt auf, danach meldet ein neuer Fehler wieder per Push)."
    }
   ]
  },
  {
   "name": "conflict_dismissals",
   "description": "„Ignorieren“/„Erledigt“ einer Konflikt-Entscheidung (Schlüssel aus `buildConflictModel`: Ordner + beteiligte Sessions). Additiv — die Kollisionskarte selbst bleibt unverändert.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "decision_key"
    },
    {
     "name": "status"
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "conflict_events",
   "description": "Rohdaten für die Lernregel \"3 Konflikte in 7 Tagen im selben Ordner\". Wächst.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "folder"
    },
    {
     "name": "path"
    },
    {
     "name": "detected_at"
    }
   ]
  },
  {
   "name": "context_guard_defaults",
   "description": "Kontext-Wächter — Standard + Nyx. Ein-Zeilen-Singleton (fester `id = 1`), lazy angelegt wie `push_settings`/`night_settings` (s. `context-guard/store.ts`). Zwei Sätze in EINER Zeile statt zwei Zeilen mit fester ID in derselben Tabelle wie die Overrides unten: eine `serial`-Spalte neben handvergebenen IDs kollidiert früher oder später mit der eigenen Sequenz (gefunden beim Testen dieses Pakets) — die Trennung in zwei Tabellen umgeht das strukturell.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "default_hinweis_pct"
    },
    {
     "name": "default_erzwingen_enabled"
    },
    {
     "name": "default_erzwingen_pct"
    },
    {
     "name": "haiku_hinweis_pct"
    },
    {
     "name": "haiku_erzwingen_enabled"
    },
    {
     "name": "haiku_erzwingen_pct"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "context_guard_events",
   "description": "Protokoll jeder Prüfung mit Wirkung (Hinweis/Versuch), Grundlage für den Nachweis in der Abnahme und für „kein Doppel-Senden\" (Reihenfolge, nicht Ersatz für `context_guard_state`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "kind"
    },
    {
     "name": "pct_at_trigger"
    },
    {
     "name": "action"
    },
    {
     "name": "detail"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "context_guard_overrides",
   "description": "Kontext-Wächter — Überschreibungen je Modell ODER je Session (`scope` unterscheidet). Eine Zeile je Modell-Name bzw. je Session, beide mit normaler `serial`-ID (keine Handvergabe, s. o.). Auflösung Session > Modell > Standard/Nyx, s. `resolveContextGuardThresholds` in `packages/shared/src/context-guard.ts` (reine Funktion, DB-frei). `model`/`sessionKey` bleiben beim jeweils anderen Scope NULL — Postgres zählt mehrere NULLs in einem UNIQUE-Index nie als Kollision, die beiden Indizes unten wirken also nur innerhalb ihres eigenen Scopes.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "scope"
    },
    {
     "name": "model"
    },
    {
     "name": "session_key"
    },
    {
     "name": "hinweis_pct"
    },
    {
     "name": "erzwingen_enabled"
    },
    {
     "name": "erzwingen_pct"
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "context_guard_state",
   "description": "Kontext-Wächter — Zustand je Session (eine Zeile), damit Hinweis/Erzwingen genau EINMAL je Schwellen-Überschreitung auslösen (`hinweisNotifiedAt`/`erzwingenAttemptedAt`, zurückgesetzt sobald der Kontext-Anteil wieder unter die jeweilige Schwelle fällt — s. `context-guard/monitor.ts`).",
   "columns": [
    {
     "name": "session_key"
    },
    {
     "name": "last_pct"
    },
    {
     "name": "hinweis_notified_at"
    },
    {
     "name": "erzwingen_attempted_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "deploys",
   "description": "Deploys — für die NyxOS selbst von einem Deploy-Skript gemeldet (`POST /api/server/deploys`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "project"
    },
    {
     "name": "container_name"
    },
    {
     "name": "image_id"
    },
    {
     "name": "created_at"
    },
    {
     "name": "git_rev"
    },
    {
     "name": "source"
    }
   ]
  },
  {
   "name": "docs",
   "description": "Doku-Spiegel: Markdown-Dokumente aus dem Mac-Repo, damit Großansicht (und später Nyx) sie lesen können, auch wenn der Rechner zu ist. `path` ist relativ zum Projektordner (eindeutig), `sha256` verhindert unnötiges Neuschreiben bei unveränderten Dateien.",
   "columns": [
    {
     "name": "path"
    },
    {
     "name": "content"
    },
    {
     "name": "sha256"
    },
    {
     "name": "size_bytes"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "entries",
   "description": "Aufgaben, Bugs, Audit-Befunde, Ideen, Entscheidungen, Fragen, Probleme — eine Tabelle, `kind` unterscheidet die Art (kein DB-Enum, wie bei `sessions.state`: `entries/store.ts` ist die eine Quelle der Wahrheit für gültige Werte). `stage` deckt beide Verläufe ab: Ideen laufen eingang → in_klaerung → konzept_fertig, alles andere geplant → startklar → laeuft → pruefen → erledigt („In Aufgaben übernehmen\" wechselt kind von idee weg und setzt stage auf geplant). `stageSetBy` unterscheidet „vom Nutzer/Import gesetzt\" von „nur der Reife-Check darf startklar setzen\" („Stufe „Startklar\" setzt nur der Check, nie ein Mensch oder Agent von Hand\"). Fortschritt wird NIE geraten: `progressPercent` ist ein reiner Cache aus `subtasks` (gewichtet, in `entries/store.ts` `recomputeProgress` neu berechnet, nie direkt gesetzt).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "title"
    },
    {
     "name": "description"
    },
    {
     "name": "geplant"
    },
    {
     "name": "priority"
    },
    {
     "name": "baustelle_slug"
    },
    {
     "name": "baustelle_label"
    },
    {
     "name": "progress_done_weight",
     "note": "Gewichtete Summen aus `subtasks` (\"Fortschritt = erledigte Teilaufgaben ÷ alle, gewichtet\"), plus der daraus abgeleitete Prozentwert als Cache für Listen/Kacheln."
    },
    {
     "name": "progress_total_weight"
    },
    {
     "name": "progress_percent"
    },
    {
     "name": "maturity",
     "note": "Reife-Check: voller `MaturityResult` (Punkte + `passed`/`passedCount`/ `totalCount`, s. `entries/maturity.ts`) — kein `import type` von dort (Zirkel zu dieser Datei), deshalb hier inline getippt. Nur `applyMaturity()` darf `stage` auf \"startklar\" setzen."
    },
    {
     "name": "maturity_checked_at"
    },
    {
     "name": "source_type",
     "note": "Import-Herkunft für idempotente Läufe: `sourceType` = 'goal' | 'audit' | 'idea' | 'manual' | 'mcp'; zusammen mit `sourceId` eindeutig, ändert nie von Hand gepflegte Felder bei einem erneuten Import (s. `entries/import.ts`)."
    },
    {
     "name": "source_id"
    },
    {
     "name": "source_removed_at",
     "note": "Die Quelle (GOAL.md, Audit-Zeile, Idee im Postfach) gibt es nicht mehr. Der Eintrag bleibt (nie löschen), wird nur als „Quelle entfernt“ markiert; taucht die Quelle wieder auf, setzt der nächste Import das Feld zurück auf `null`."
    },
    {
     "name": "file_scope"
    },
    {
     "name": "model_suggestion"
    },
    {
     "name": "estimate"
    },
    {
     "name": "worktree_path",
     "note": "Ein-Klick-Start: Worktree/Ordner + tmux-Name, sobald gestartet."
    },
    {
     "name": "git_branch"
    },
    {
     "name": "tmux_name"
    },
    {
     "name": "started_session_key"
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "entry_events",
   "description": "Verlauf eines Eintrags (wie `session_events`, eigene Tabelle statt Wiederverwendung — Einträge haben eine int-ID, keine `session_key`-Fremdschlüssel-Form).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "entry_id"
    },
    {
     "name": "ts"
    },
    {
     "name": "kind"
    },
    {
     "name": "source"
    },
    {
     "name": "data"
    }
   ]
  },
  {
   "name": "focus_state",
   "description": "Focus button (migration 0048): \"auto\" / \"away\" / \"dnd\" with an end. One row (`id = 1`); without it, \"auto\" applies (see `focus/service.ts`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "auto"
    },
    {
     "name": "until"
    },
    {
     "name": "since"
    },
    {
     "name": "set_by"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "git_actions",
   "description": "Aktions-Log aus dem Reflog (Merge, Push, Reset, Checkout …), nur gelesen. Wächst.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "repo_id"
    },
    {
     "name": "worktree_path"
    },
    {
     "name": "ref"
    },
    {
     "name": "at"
    },
    {
     "name": "action"
    },
    {
     "name": "subject"
    },
    {
     "name": "new_sha"
    },
    {
     "name": "identity"
    }
   ]
  },
  {
   "name": "git_branches",
   "description": "Zweige je Repo mit Vor-/Rückstand zu `main`. Upsert je Scan.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "repo_id"
    },
    {
     "name": "name"
    },
    {
     "name": "ahead"
    },
    {
     "name": "behind"
    },
    {
     "name": "is_current"
    },
    {
     "name": "last_commit_at"
    },
    {
     "name": "upstream"
    },
    {
     "name": "ahead_shas",
     "note": "eigene Commits dieses Zweigs (Zweig → Commits)."
    }
   ]
  },
  {
   "name": "git_catchup_history",
   "description": "Verlauf automatischer Nachzieh-Entscheidungen. Wächst.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "repo_id"
    },
    {
     "name": "worktree_path"
    },
    {
     "name": "branch"
    },
    {
     "name": "outcome"
    },
    {
     "name": "main_sha_before"
    },
    {
     "name": "main_sha_after"
    },
    {
     "name": "detail"
    },
    {
     "name": "at"
    }
   ]
  },
  {
   "name": "git_commits",
   "description": "Commit-Historie je Repo/Zweig (7-Tage-Diagramm im Überblick). Wächst, kein Upsert-Ersatz.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "repo_id"
    },
    {
     "name": "sha"
    },
    {
     "name": "author_date"
    },
    {
     "name": "subject"
    },
    {
     "name": "branch"
    },
    {
     "name": "author_name",
     "note": "(additiv, ältere Zeilen bleiben leer):"
    },
    {
     "name": "committed_at"
    },
    {
     "name": "parent_count",
     "note": "Anzahl Eltern; ≥ 2 = Merge-Commit."
    },
    {
     "name": "files",
     "note": "Geänderte Dateien `[{path, add, del}]` (höchstens 300), Commit → Diff-Übersicht."
    },
    {
     "name": "files_changed"
    },
    {
     "name": "insertions"
    },
    {
     "name": "deletions"
    },
    {
     "name": "session_key",
     "note": "Commit → Session (s. git/attribution.ts): Session, Sicherheit, Begründung, Zeitpunkt der Zuordnung."
    },
    {
     "name": "session_confidence"
    },
    {
     "name": "session_reason"
    },
    {
     "name": "attributed_at"
    }
   ]
  },
  {
   "name": "git_probe_merges",
   "description": "Letztes Probe-Merge-Ergebnis je Repo+Zweig (`git merge-tree --write-tree main <zweig>`, alle 10 Min + bei Änderung, NIE das Repo verändernd — s. apps/bridge/src/git/probeMerge.ts).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "repo_id"
    },
    {
     "name": "branch"
    },
    {
     "name": "status"
    },
    {
     "name": "conflict_files"
    },
    {
     "name": "checked_at"
    },
    {
     "name": "checksum_before"
    },
    {
     "name": "checksum_after"
    }
   ]
  },
  {
   "name": "git_repos",
   "description": "--------------------------------------------------------------------------------------------- Git-Stand, Konflikte, Server/Deploys, Lernbuch. Additive Migration `0009_git_conflicts_server_lessons`. Die Brücke liest App-Repo, Worktrees und das NyxOS-Repo NUR LESEND und schickt je Repo eine volle Momentaufnahme (Upsert je `repoId`) — kein Ereignisstrom wie bei `session_events`, weil hier immer der ganze aktuelle Stand zählt, nicht die Historie einzelner Ereignisse (Ausnahme: `git_commits`/`git_catchup_history`/`conflict_events`, die bewusst wachsen). --------------------------------------------------------------------------------------------- Ein gescanntes Repo: App-Repo, ein Worktree oder das NyxOS-Repo selbst.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "label"
    },
    {
     "name": "kind"
    },
    {
     "name": "root"
    },
    {
     "name": "current_branch"
    },
    {
     "name": "head_sha"
    },
    {
     "name": "tags"
    },
    {
     "name": "scanned_at"
    },
    {
     "name": "parent_id",
     "note": "Worktree → Eltern-Repo (\"app\"/\"nyxos\"); Repos selbst `null`."
    },
    {
     "name": "main_branch",
     "note": "Zweig, gegen den vor/hinter gemessen wird."
    },
    {
     "name": "last_activity_at",
     "note": "zuletzt aktiv laut Brücke (Reflog, Commit, geänderte Datei)."
    }
   ]
  },
  {
   "name": "git_uncommitted",
   "description": "Ungesicherte Änderungen je Repo, gruppiert (code/doku/projekt/verschoben). Upsert je Scan; bereinigte Pfade werden beim nächsten Scan durch einen vollen Ersatz entfernt (s. git/store.ts).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "repo_id"
    },
    {
     "name": "path"
    },
    {
     "name": "status_code"
    },
    {
     "name": "group"
    },
    {
     "name": "from_path"
    }
   ]
  },
  {
   "name": "git_worktrees",
   "description": "Worktrees des App-Repos (`git worktree list`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "repo_id"
    },
    {
     "name": "path"
    },
    {
     "name": "branch"
    },
    {
     "name": "head_sha"
    },
    {
     "name": "locked"
    }
   ]
  },
  {
   "name": "haiku_calls",
   "description": "Protokoll JEDES Nyx-Aufrufs (Kosten, Dauer, Ergebnis) — Grundlage für Budget + Verbrauch.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "engine"
    },
    {
     "name": "model"
    },
    {
     "name": "queued"
    },
    {
     "name": "thread_id"
    },
    {
     "name": "input_tokens"
    },
    {
     "name": "output_tokens"
    },
    {
     "name": "cache_read_tokens"
    },
    {
     "name": "cost_usd"
    },
    {
     "name": "duration_ms"
    },
    {
     "name": "tool_calls"
    },
    {
     "name": "error"
    },
    {
     "name": "created_at"
    },
    {
     "name": "ended_at"
    }
   ]
  },
  {
   "name": "haiku_messages",
   "description": "",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "thread_id"
    },
    {
     "name": "role"
    },
    {
     "name": "text"
    },
    {
     "name": "sources"
    },
    {
     "name": "estimate"
    },
    {
     "name": "context"
    },
    {
     "name": "call_id"
    },
    {
     "name": "note_kind",
     "note": "nur bei `role = 'note'` – summary | task | obsidian."
    },
    {
     "name": "channel",
     "note": "Kanal der Frage (web/voice/telegram) bzw. sprechbare Kurzfassung der Antwort."
    },
    {
     "name": "speak"
    },
    {
     "name": "created_at"
    },
    {
     "name": "interrupted",
     "note": "Nyx wurde beim Sprechen unterbrochen — `text` ist nur der gehörte Teil."
    }
   ]
  },
  {
   "name": "haiku_notes",
   "description": "Eigene Notizen von Nyx (Rundgang-Befunde, Merker). `fingerprint` verhindert Wiederholungen.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "text"
    },
    {
     "name": "fingerprint"
    },
    {
     "name": "data"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "haiku_reports",
   "description": "Briefing (morgens) und Recap (abends), je Tag die jüngste Fassung zählt.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "day"
    },
    {
     "name": "content"
    },
    {
     "name": "facts"
    },
    {
     "name": "call_id"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "haiku_settings",
   "description": "───────────────────────────── Nyx, Leitplanken, Inbox, Ideen-Link ───────────────────────────── Ein-Zeilen-Tabelle (`id = 1`) mit den Nyx-Einstellungen (Motor, Budget, Zeiten). Startwerte legt `haiku/settings.ts` beim ersten Zugriff an. Der API-Schlüssel des Reserve-Motors steht NIE hier (nur Umgebung `NYXOS_HAIKU_API_KEY`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "engine"
    },
    {
     "name": "daily_budget_usd"
    },
    {
     "name": "briefing_time"
    },
    {
     "name": "recap_time"
    },
    {
     "name": "rundgang_minutes"
    },
    {
     "name": "timeout_seconds"
    },
    {
     "name": "idealink_budget_percent",
     "note": "(7): Teilbudget der Ideen-Links in % des Tagesbudgets + Obergrenzen für neue Ideen."
    },
    {
     "name": "idealink_ideas_per_link_day"
    },
    {
     "name": "idealink_ideas_per_day"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "haiku_threads",
   "description": "Gesprächsfaden (je Tag/Thema fortsetzbar über `claude --resume <claudeSessionId>`). `scope` = \"full\" (Panel) | \"idealink\" (Mini-Seite eines Ideen-Links, `ideaLinkId` gesetzt).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "full"
    },
    {
     "name": "topic"
    },
    {
     "name": "day"
    },
    {
     "name": "title"
    },
    {
     "name": "claude_session_id"
    },
    {
     "name": "idea_link_id"
    },
    {
     "name": "conversation_key"
    },
    {
     "name": "temporary",
     "note": "Wegwerf-Faden – wird X Stunden nach der letzten Nachricht gelöscht (`temporary.ts`)."
    },
    {
     "name": "archived_at",
     "note": "archiviert (Menü „⋯“) – aus der Fadenliste, im Archiv zurückholbar."
    },
    {
     "name": "memory_snapshot",
     "note": "Gedächtnis-Abbild, beim Anlegen des Fadens eingefroren (Hermes: Prompt bleibt je Faden stabil)."
    },
    {
     "name": "summary",
     "note": "Verdichtung – Zusammenfassung nach festem Schema und bis zu welcher Nachricht sie reicht."
    },
    {
     "name": "summary_upto_id"
    },
    {
     "name": "turns_since_memory",
     "note": "Runden seit der letzten Gedächtnis-Pflege (Auslöser der Hintergrund-Lernprüfung alle ~10 Runden)."
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "hosting_profile",
   "description": "Betrieb & Zugriff (migration 0045): chosen way + form values (`profile`), last check per target (`checks`) and the last access through an outside address (`remote_seen`). One row (`id = 1`). No secrets – they live in the secret store (`secrets`, names `hosting.*`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "profile"
    },
    {
     "name": "checks"
    },
    {
     "name": "remote_seen"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "idea_link_hits",
   "description": "Ratenbegrenzung: eine Zeile je Chat-Anfrage über einen Link (gleitendes Stundenfenster).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "link_id"
    },
    {
     "name": "at"
    },
    {
     "name": "chat",
     "note": "'chat' = eine Anfrage (Ratenbegrenzung), 'idea' = eine angelegte Idee (Obergrenze je Link/Tag + global)."
    }
   ]
  },
  {
   "name": "idea_links",
   "description": "Ideen-Link je Person. Gespeichert ist nur der SHA-256 des Tokens.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "name"
    },
    {
     "name": "token_hash"
    },
    {
     "name": "rate_per_hour"
    },
    {
     "name": "uses"
    },
    {
     "name": "ideas_created"
    },
    {
     "name": "created_at"
    },
    {
     "name": "expires_at"
    },
    {
     "name": "revoked_at"
    },
    {
     "name": "last_used_at"
    }
   ]
  },
  {
   "name": "import_files",
   "description": "Import-Quellen, die die Brücke schickt (GOAL.md-Aufträge, MASSNAHMENPLAN.md). Nur-Lese- Spiegel: der Server liest die Dateien nie selbst (im Container gibt es keinen Projektordner), er bekommt sie über `POST /ingest/entry-sources` und importiert daraus. `path` ist repo-relativ ab dem Projektordner. Fehlt eine Datei in einer vollständigen Lieferung, bekommt sie `removedAt` (nie löschen).",
   "columns": [
    {
     "name": "path"
    },
    {
     "name": "content"
    },
    {
     "name": "sha256"
    },
    {
     "name": "size_bytes"
    },
    {
     "name": "machine_id"
    },
    {
     "name": "received_at"
    },
    {
     "name": "removed_at"
    }
   ]
  },
  {
   "name": "import_status",
   "description": "letzter Import-Lauf je Quelle (`dateien` = GOAL.md/Audit von der Brücke, `ideen` = Ideen-Postfach). `state` ist ein kurzer Code (ok | leer | wartet | kein_zugang | aus | fehler), `message` der einfache deutsche Satz für die Oberfläche.",
   "columns": [
    {
     "name": "source"
    },
    {
     "name": "state"
    },
    {
     "name": "message"
    },
    {
     "name": "last_run_at"
    },
    {
     "name": "last_ok_at"
    },
    {
     "name": "last_delivery_at"
    },
    {
     "name": "counts"
    }
   ]
  },
  {
   "name": "inbox_items",
   "description": "Entscheidungs-Inbox: offene Fragen (Sessions, Aufträge), Pläne von Nyx, Eskalationen.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "title"
    },
    {
     "name": "body"
    },
    {
     "name": "options"
    },
    {
     "name": "open"
    },
    {
     "name": "answer"
    },
    {
     "name": "session_key"
    },
    {
     "name": "entry_id"
    },
    {
     "name": "baustelle"
    },
    {
     "name": "decision_file"
    },
    {
     "name": "sources"
    },
    {
     "name": "haiku"
    },
    {
     "name": "estimate_minutes"
    },
    {
     "name": "yes_no"
    },
    {
     "name": "escalation"
    },
    {
     "name": "delivery"
    },
    {
     "name": "fingerprint"
    },
    {
     "name": "created_at"
    },
    {
     "name": "answered_at"
    }
   ]
  },
  {
   "name": "links",
   "description": "Beliebige Verknüpfungen zwischen Einträgen, Sessions, Dateien, Commits, Dokumenten ( Großansicht). `fromType`/`toType` ∈ 'entry' | 'session' | 'file' | 'commit' | 'doc'; IDs immer als Text (Einträge als String der Serial-ID). `relation` ist ein freier, sprechender Text (z. B. \"vorgaenger\", \"blockiert\", \"verwandt\", \"entstand_aus\", \"dokument\", \"session\") — keine DB-Enum, damit neue Beziehungsarten ohne Migration dazukommen (wie bei `search_docs.field`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "from_type"
    },
    {
     "name": "from_id"
    },
    {
     "name": "to_type"
    },
    {
     "name": "to_id"
    },
    {
     "name": "relation"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "machines",
   "description": "Rechner, die Events liefern (das MacBook). Token nur als SHA-256 gespeichert.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "name"
    },
    {
     "name": "token_hash"
    },
    {
     "name": "created_at"
    },
    {
     "name": "last_seen_at"
    }
   ]
  },
  {
   "name": "mcp_connectors",
   "description": "MCP-Konnektoren für Nyx. Token/Anmeldung in `secrets` (`mcp.<name>` bzw. `mcp.<name>.oauth`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "name"
    },
    {
     "name": "label"
    },
    {
     "name": "template"
    },
    {
     "name": "transport"
    },
    {
     "name": "url"
    },
    {
     "name": "command"
    },
    {
     "name": "args"
    },
    {
     "name": "headers"
    },
    {
     "name": "none"
    },
    {
     "name": "auth_name"
    },
    {
     "name": "auth_config",
     "note": "Geräte-Code-Anmeldung (z. B. Higgsfield): { deviceAuthorizeUrl, deviceTokenUrl }."
    },
    {
     "name": "enabled"
    },
    {
     "name": "oauth_expires_at"
    },
    {
     "name": "allowed_tools",
     "note": "Freigegebene Werkzeuge (Tool-Pinning): null = noch nie getestet → Nyx nutzt keins; neue Werkzeuge bleiben aus, bis der Nutzer sie freigibt."
    },
    {
     "name": "last_test"
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "model_providers",
   "description": "Modell-Anbieter (Vorlage je Art, „custom-…“ für eigene Endpunkte). Schlüssel liegt in `secrets` (`provider.<id>`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "label"
    },
    {
     "name": "base_url"
    },
    {
     "name": "direct"
    },
    {
     "name": "enabled"
    },
    {
     "name": "models"
    },
    {
     "name": "last_test"
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "model_roles",
   "description": "Rolle → Modell. Keine Zeile bzw. `provider_id` null = Standard (Nyx über das Claude-Programm).",
   "columns": [
    {
     "name": "role"
    },
    {
     "name": "provider_id"
    },
    {
     "name": "model"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "night_runs",
   "description": "Nachtmodus. Eine Zeile je Nachtlauf-Eintrag (Warteschlange + Verlauf). `taskId` zeigt auf einen künftigen `entries`-Eintrag — bis dahin frei benannte IDs (s. `night/planner.ts` Tests).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "task_id"
    },
    {
     "name": "title"
    },
    {
     "name": "runs_on"
    },
    {
     "name": "queued"
    },
    {
     "name": "session_key",
     "note": "KEIN Fremdschlüssel auf `sessions.id` (anders als `build_runs`/`push_log`): der Planer legt diese Zeile schon beim Start an, bevor die frisch gestartete tmux-/Worktree-Session ihr erstes Hook-Ereignis gesendet hat — `sessions` hätte dann noch keine passende Zeile (Wettlauf)."
    },
    {
     "name": "tokens_used"
    },
    {
     "name": "started_at"
    },
    {
     "name": "ended_at"
    },
    {
     "name": "stop_reason"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "nyx_api_calls",
   "description": "Nyx bedient NyxOS über die eigene API (`app_api`, s. nyx/appApi/*, Migration 0040). Jede Zeile = ein Aufruf mit Ergebnis (Protokoll). Riskante Aufrufe warten hier auf des Nutzers „Ausführen“ (`outcome = 'wartet'`, genau die Anfrage in `pendingBody`, nach Ausführung/Absage/Verfall wieder leer). Körper im Protokoll nur geschwärzt (`bodyRedacted`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "created_at"
    },
    {
     "name": "channel",
     "note": "web · voice · telegram; null = automatischer Lauf bzw. ohne Kanal."
    },
    {
     "name": "call_kind",
     "note": "Art des Laufs (chat, schedule, compact …)."
    },
    {
     "name": "thread_id"
    },
    {
     "name": "method"
    },
    {
     "name": "path"
    },
    {
     "name": "query"
    },
    {
     "name": "body_redacted"
    },
    {
     "name": "outcome",
     "note": "ausgefuehrt · abgelehnt · fehler · wartet · bestaetigt · nicht_ausgefuehrt · verworfen · abgelaufen"
    },
    {
     "name": "reason"
    },
    {
     "name": "label",
     "note": "Name der Aktion bei Bestätigung (z. B. „Session beenden“)."
    },
    {
     "name": "status"
    },
    {
     "name": "pending_body",
     "note": "Nur solange `outcome = 'wartet'`: der genaue Körper, der nach „Ausführen“ gesendet wird."
    },
    {
     "name": "inbox_item_id"
    },
    {
     "name": "expires_at"
    },
    {
     "name": "decided_at"
    },
    {
     "name": "result_excerpt"
    }
   ]
  },
  {
   "name": "nyx_files",
   "description": "Ablage des Nyx-Tabs — Bilder, die Nyx zeigt (`show_image`, Simulator-Screenshots), und Dateien, die der Nutzer Nyx gibt. Die Bytes liegen im Archiv-Volume unter `nyx/<sha256>.<ext>` (`storedPath` relativ).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "source"
    },
    {
     "name": "name"
    },
    {
     "name": "title"
    },
    {
     "name": "mime"
    },
    {
     "name": "size"
    },
    {
     "name": "sha256"
    },
    {
     "name": "stored_path"
    },
    {
     "name": "thread_id"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "nyx_media",
   "description": "frühere Ablage für Bilder/Links. NICHT MEHR BENUTZT – Bilder liegen in `nyx_files` (eine Quelle für Tab, Telegram, Download), Links in der Aufgaben-Karte. Tabelle bleibt (Migrationen nur additiv).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "title"
    },
    {
     "name": "url"
    },
    {
     "name": "file"
    },
    {
     "name": "mime"
    },
    {
     "name": "bytes"
    },
    {
     "name": "nyx"
    },
    {
     "name": "thread_id"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "nyx_memory",
   "description": "───────────────────────────── Nyx-Kern ───────────────────────────── Dauerhaftes Gedächtnis (Hermes memory_tool): kurze Fakten mit festem Zeichen-Budget je Kategorie.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "category"
    },
    {
     "name": "fact"
    },
    {
     "name": "source_thread_id"
    },
    {
     "name": "source_message_id"
    },
    {
     "name": "nyx"
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "nyx_memory_suggestions",
   "description": "Vorschläge der Hintergrund-Lernprüfung – nie still gespeichert, der Nutzer hakt ab.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "action"
    },
    {
     "name": "category"
    },
    {
     "name": "fact"
    },
    {
     "name": "memory_id"
    },
    {
     "name": "reason"
    },
    {
     "name": "source_thread_id"
    },
    {
     "name": "open"
    },
    {
     "name": "created_at"
    },
    {
     "name": "decided_at"
    }
   ]
  },
  {
   "name": "nyx_presets",
   "description": "eigene Vorlagen (die eingebauten stehen im Code). Name ohne Groß/Klein eindeutig.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "label"
    },
    {
     "name": "description"
    },
    {
     "name": "sliders"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "nyx_profile",
   "description": "Nyx-Persönlichkeit + Nutzerprofil – eine Zeile (`id = 1`); fehlt sie, gelten die Startwerte `DEFAULT_NYX_PROFILE` (packages/shared/src/nyx-persona.ts). Form der JSON-Spalten = zod-Schemas dort.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "user_profile",
     "note": "Wer der Nutzer ist (Name, Rolle, Projekte, Arbeitsweise, Vorlieben, No-Gos, Freitext)."
    },
    {
     "name": "personality",
     "note": "Wer Nyx ist (Charakter, Ton, Anrede, „Seele“)."
    },
    {
     "name": "sliders",
     "note": "Regler 0–100: length, speed, expertise, formality, initiative, humor."
    },
    {
     "name": "active_preset"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "nyx_schedules",
   "description": "Geplante Aufgaben – einmalig, wiederkehrend (cron, Zeitzone des Nutzers) oder „wenn X passiert“.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "name"
    },
    {
     "name": "prompt"
    },
    {
     "name": "remind"
    },
    {
     "name": "kind"
    },
    {
     "name": "run_at"
    },
    {
     "name": "cron"
    },
    {
     "name": "event"
    },
    {
     "name": "event_filter"
    },
    {
     "name": "event_cursor",
     "note": "Stand der Ereignis-Prüfung (höchste gesehene ID bzw. Zeit) – nur Neues löst aus."
    },
    {
     "name": "precheck"
    },
    {
     "name": "active_start"
    },
    {
     "name": "active_end"
    },
    {
     "name": "web"
    },
    {
     "name": "paused"
    },
    {
     "name": "next_run_at"
    },
    {
     "name": "last_run_at"
    },
    {
     "name": "last_status"
    },
    {
     "name": "last_output"
    },
    {
     "name": "run_count"
    },
    {
     "name": "nyx"
    },
    {
     "name": "source_thread_id"
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "nyx_todos",
   "description": "Plan/To-do je Faden (Hermes todo_tool) – Revision steigt mit jeder Änderung.",
   "columns": [
    {
     "name": "thread_id"
    },
    {
     "name": "revision"
    },
    {
     "name": "items"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "nyx_voice_settings",
   "description": "Stimmen-Einstellungen (EINE Zeile, `id = 1`): Anbieter (eigene Stimme oder ElevenLabs), ElevenLabs-Stimme + Modell und das eigene Aussprache-Wörterbuch. Der ElevenLabs-Schlüssel liegt NICHT hier, sondern verschlüsselt in `secrets` (Name `elevenlabs.api-key`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "local"
    },
    {
     "name": "elevenlabs_voice_id"
    },
    {
     "name": "elevenlabs_voice_name"
    },
    {
     "name": "eleven_multilingual_v2"
    },
    {
     "name": "lexicon"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "prices",
   "description": "Preise je Modell, editierbar (`PATCH /api/usage/prices/:id`) — Ausgangswerte aus `packages/shared/src/usage.ts` `BUILTIN_MODEL_PRICES` (Quelle je Zeile im Feld `source`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "model"
    },
    {
     "name": "input_per_token"
    },
    {
     "name": "output_per_token"
    },
    {
     "name": "cache_read_per_token"
    },
    {
     "name": "cache_creation_5m_per_token"
    },
    {
     "name": "cache_creation_1h_per_token"
    },
    {
     "name": "context_window"
    },
    {
     "name": "valid_from"
    },
    {
     "name": "source"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "push_log",
   "description": "Push. Jede versendete (oder bewusst unterdrückte) Mitteilung — Grundlage für Bündelung, Dedupe (\"schon benachrichtigt?\") und den Latenz-Nachweis (< 10 s messbar).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "session_key"
    },
    {
     "name": "title"
    },
    {
     "name": "message"
    },
    {
     "name": "priority"
    },
    {
     "name": "click_url"
    },
    {
     "name": "bundled_count"
    },
    {
     "name": "suppressed_reason",
     "note": "null = wirklich verschickt; sonst warum unterdrückt/gebündelt statt eigenständig gesendet."
    },
    {
     "name": "sent_at"
    },
    {
     "name": "channels",
     "note": "Wege mit Ergebnis (Mac/Browser/iPhone über ntfy/Telegram); null = alte Zeile oder nicht gesendet."
    },
    {
     "name": "bundle",
     "note": "Sammel-Mitteilung (z. B. Abwesenheits-Bündel „3 Sachen fertig“)."
    },
    {
     "name": "decision",
     "note": "What the pipeline decided (`NotifyDecision`: sent, nyx_skip, quiet_hours, sub_agent …); null = older row."
    },
    {
     "name": "decision_note",
     "note": "Short reason for it (Nyx' sentence, \"Telegram card\" …)."
    },
    {
     "name": "nyx",
     "note": "Nyx' part (check, text written/template), see `NotifyNyxTrace`."
    },
    {
     "name": "feedback",
     "note": "The user's feedback \"passt\" | \"unnoetig\" (examples for Nyx' check, rule suggestions)."
    },
    {
     "name": "feedback_at"
    }
   ]
  },
  {
   "name": "push_settings",
   "description": "Push. Ein-Zeilen-Tabelle (`id = 1`) mit dem geheimen ntfy-Thema + Einstellungen. Der Server legt die Zeile beim ersten Zugriff selbst an (`push/settings.ts` `loadOrInitSettings`, zufälliges Thema per `crypto.randomBytes`) — keine Migration muss Startwerte kennen.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "topic"
    },
    {
     "name": "quiet_start"
    },
    {
     "name": "quiet_end"
    },
    {
     "name": "bundle_window_seconds"
    },
    {
     "name": "waiting_after_seconds"
    },
    {
     "name": "public_base_url"
    },
    {
     "name": "enabled_kinds"
    },
    {
     "name": "channels",
     "note": "Wege an/aus (`mac`/`browser`/`ntfy`); fehlender Schlüssel = an."
    },
    {
     "name": "own",
     "note": "`own` = eigener ntfy-Dienst, `ntfy_sh` = öffentlicher Dienst ntfy.sh."
    },
    {
     "name": "rules",
     "note": "Rules of the notification pipeline (when/style/templates/Nyx, see `NotifyRules`); missing key = default."
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "reservations",
   "description": "Reservierte Dateibereiche. `sessionKey` nur informativ, keine harte FK (eine Reservierung kann auch für eine noch nicht gestartete Aufgabe gelten).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "path_glob"
    },
    {
     "name": "label"
    },
    {
     "name": "session_key"
    },
    {
     "name": "created_at"
    },
    {
     "name": "until"
    }
   ]
  },
  {
   "name": "rules",
   "description": "Lernbuch: verallgemeinert `sort_rules` auf reservierung/konflikt/freigabe.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "condition"
    },
    {
     "name": "action"
    },
    {
     "name": "origin"
    },
    {
     "name": "active"
    },
    {
     "name": "hit_count"
    },
    {
     "name": "created_at"
    },
    {
     "name": "last_hit_at"
    }
   ]
  },
  {
   "name": "search_docs",
   "description": "Volltext-Index: ein Dokument je gefundenem Text-Schnipsel einer Session. `field`: 'title' | 'prompt' | 'file' | 'chat' (kein DB-Enum — die Web-App/Server-Konstanten in `search.ts` sind die eine Quelle der Wahrheit, wie bei `sessions.status`/`state`). `position` ist nur bei `field = 'chat'` gesetzt: derselbe Index, den `transcript.ts` für die aufgebaute Eintragsliste verwendet (geteilte Funktion, keine zweite Zählung) — so kann `around=<position>` direkt darauf aufsetzen. `text` ist der Rohtext fürs Snippet (`ts_headline`); bei `field='file'` der volle Pfad. Zwei tsvector-Spalten statt einer gemeinsamen: die deutsche Konfiguration (Wortstämme, z. B. „sortiert\" für „Sortierung\") und `simple` (exakte Begriffe, Codex-Namen, Dateipfade — deutsche Stämme würden Pfade wie `categorize.ts` verstümmeln) brauchen getrennte `to_tsvector`-Aufrufe und damit auch getrennte Indizes; eine Suche prüft beide mit ODER (s. `search.ts`). Für `field='file'` enthält `tsv_simple` zusätzlich die an `/` in Ordner-Segmente zerlegten Pfadteile, damit z. B. `categorize.ts` innerhalb eines längeren Pfades trifft (NICHT zusätzlich an `.`/`_`/`-` getrennt — das würde das Segment-Lexem selbst zerstören, s. Kommentar in `search.ts`) — `pg_trgm` ist in der PGlite-Testumgebung nur über ein Erweiterungs-Modul ladbar, das `test/helpers.ts` (außerhalb des Schreibbereichs dieses Pakets) nicht einbindet; deshalb Pfad-Zerlegung statt Trigram (s. Bericht).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "field"
    },
    {
     "name": "position"
    },
    {
     "name": "text"
    },
    {
     "name": "tsv_german"
    },
    {
     "name": "tsv_simple"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "secrets",
   "description": "───────────────────────────── Geheimnisse, Modelle, Konnektoren ───────────────────────────── Verschlüsselte Geheimnisse (AES-256-GCM, Schlüssel `NYXOS_SECRETS_KEY`, s. secrets/store.ts). Nie Klartext.",
   "columns": [
    {
     "name": "name"
    },
    {
     "name": "ciphertext",
     "note": "base64: Chiffretext, 12-Byte-IV, 16-Byte-Prüfwert. Der Name ist als AAD gebunden."
    },
    {
     "name": "iv"
    },
    {
     "name": "tag"
    },
    {
     "name": "last4",
     "note": "Nur Anzeige („…abcd“); bei kurzen oder strukturierten Werten null."
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "session_agent_marks",
   "description": "Geschriebene/gelesene Dateien je Session (Grundlage der Kollisionskarte in P5). Migration 0044: the user's marks on agents of a session — so far only \"hidden in the archive\". The agents themselves stay in `session_events`/`sessions` (no agents table of their own, see `agents/runs.ts`).",
   "columns": [
    {
     "name": "session_key"
    },
    {
     "name": "agent_id"
    },
    {
     "name": "hidden_at"
    }
   ]
  },
  {
   "name": "session_audits",
   "description": "„Session zusammenfassen & prüfen“ — Nyx' Prüfung hängt an der Session (additiv).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "status",
     "note": "`running` | `done` | `error`"
    },
    {
     "name": "result"
    },
    {
     "name": "error"
    },
    {
     "name": "items_read"
    },
    {
     "name": "items_total"
    },
    {
     "name": "call_id"
    },
    {
     "name": "created_at"
    },
    {
     "name": "finished_at"
    }
   ]
  },
  {
   "name": "session_change_ops",
   "description": "jede einzelne Datei-Änderung (Edit/Write/apply_patch) aus dem Archiv — Grundlage für „Anzahl Änderungen, +/−\" je Datei und die Inhaltssuche im Reiter „Änderungen\". Der Text ist je Änderung auf 64 000 Zeichen begrenzt (deckt fast jede Datei ganz ab, bläht die DB nicht auf).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "archive_id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "agent_id"
    },
    {
     "name": "ts"
    },
    {
     "name": "file_path"
    },
    {
     "name": "tool"
    },
    {
     "name": "added"
    },
    {
     "name": "removed"
    },
    {
     "name": "added_text"
    },
    {
     "name": "removed_text"
    }
   ]
  },
  {
   "name": "session_deliveries",
   "description": "„Zustellen, sobald sie wartet“: Texte an eine Session (Freigabe-Bescheid, Inbox-Antwort, /compact, Chat-Nachricht …), die gerade nicht gefahrlos eingetippt werden konnten. Dauerhaft, damit ein Neustart/Deploy keinen Freigabe-Bescheid verschluckt. Zustellung: `delivery/queue.ts`.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "kind"
    },
    {
     "name": "method"
    },
    {
     "name": "payload"
    },
    {
     "name": "queued"
    },
    {
     "name": "dedupe_key",
     "note": "Gleicher Schlüssel, noch wartend → kein zweiter Eintrag (z. B. zweimal „Jetzt komprimieren“)."
    },
    {
     "name": "reason"
    },
    {
     "name": "attempts"
    },
    {
     "name": "created_at"
    },
    {
     "name": "expires_at"
    },
    {
     "name": "last_attempt_at"
    },
    {
     "name": "done_at"
    }
   ]
  },
  {
   "name": "session_events",
   "description": "Einzelne Ereignisse. Die ID ist deterministisch → doppeltes Senden ist harmlos.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "ts"
    },
    {
     "name": "kind"
    },
    {
     "name": "source"
    },
    {
     "name": "data"
    },
    {
     "name": "received_at"
    }
   ]
  },
  {
   "name": "session_files",
   "description": "",
   "columns": [
    {
     "name": "session_key"
    },
    {
     "name": "path"
    },
    {
     "name": "mode"
    },
    {
     "name": "first_seen_at"
    }
   ]
  },
  {
   "name": "session_opens",
   "description": "„Zuletzt geöffnet“: wann der Nutzer eine Session zuletzt in der Web-App geöffnet hat. Eine Zeile je Session (kein wachsendes Protokoll) – geräteübergreifend, weil serverseitig.",
   "columns": [
    {
     "name": "session_key"
    },
    {
     "name": "last_opened_at"
    },
    {
     "name": "open_count"
    }
   ]
  },
  {
   "name": "session_state_settings",
   "description": "Ein-Zeilen-Tabelle (`id = 1`) für Session-Zustands-Regeln. Fehlt die Zeile, gelten die Standardwerte (`DEFAULT_CRASHED_MAX_HOURS`) — keine Migration muss Startwerte kennen.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "crashed_max_hours",
     "note": "Nach so vielen Stunden ohne Prozess zählt eine Session nicht mehr als „abgestürzt“, sondern als beendet."
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "session_summaries",
   "description": "„Nyx fasst zusammen“ – ausführliche Zusammenfassung einer Session (Markdown), je Lauf eine Zeile (additiv). `messagesCovered`/`coveredUntilItem` halten den Stand fest, damit NyxOS „N neue Nachrichten seitdem“ zeigen kann.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "session_key"
    },
    {
     "name": "status",
     "note": "`running` | `done` | `error`"
    },
    {
     "name": "text"
    },
    {
     "name": "error"
    },
    {
     "name": "messages_covered"
    },
    {
     "name": "covered_until_item"
    },
    {
     "name": "covered_until"
    },
    {
     "name": "items_read"
    },
    {
     "name": "items_total"
    },
    {
     "name": "dropped"
    },
    {
     "name": "call_id"
    },
    {
     "name": "created_at"
    },
    {
     "name": "finished_at"
    }
   ]
  },
  {
   "name": "sessions",
   "description": "Eine Claude- oder Codex-Session. `id` = `<werkzeug>:<session-id>`.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "tool"
    },
    {
     "name": "session_id"
    },
    {
     "name": "machine_id"
    },
    {
     "name": "parent_id"
    },
    {
     "name": "title"
    },
    {
     "name": "title_source"
    },
    {
     "name": "running"
    },
    {
     "name": "cwd"
    },
    {
     "name": "git_branch"
    },
    {
     "name": "cli_version"
    },
    {
     "name": "started_at"
    },
    {
     "name": "last_activity_at"
    },
    {
     "name": "ended_at"
    },
    {
     "name": "models"
    },
    {
     "name": "tokens"
    },
    {
     "name": "tokens_total"
    },
    {
     "name": "tool_calls"
    },
    {
     "name": "subagents"
    },
    {
     "name": "limits"
    },
    {
     "name": "parsed_event_count"
    },
    {
     "name": "event_count"
    },
    {
     "name": "parse_errors"
    },
    {
     "name": "state_observed_at"
    },
    {
     "name": "state",
     "note": "P2-Zustand (läuft/wartet/ruht/abgestürzt/geschlossen, …), aus `computeSessionState` — null bei sauber beendeten Sessions ohne P2-Zustand."
    },
    {
     "name": "turn_open",
     "note": "Ob die aktuelle Runde offen ist (läuft) oder mit Stop/Notification/task_complete geschlossen wurde (wartet auf dich)."
    },
    {
     "name": "turn_observed_at",
     "note": "Schutz gegen verspätet eintreffende, ältere Runden-Signale (wie `stateObservedAt`)."
    },
    {
     "name": "session_end_received_at",
     "note": "Gesetzt nur durch einen echten `SessionEnd`-Hook (unterscheidet sauberes Ende von Absturz)."
    },
    {
     "name": "closed_at",
     "note": "Nur durch `POST /api/sessions/:id/close` gesetzt; hat Vorrang vor jedem berechneten Zustand."
    },
    {
     "name": "closed_by"
    },
    {
     "name": "category_art",
     "note": "Art laut `categorize()`, z. B. \"coding\" / \"audit\" / … / \"unsortiert\"."
    },
    {
     "name": "category_baustelle_slug",
     "note": "Baustelle (live erzeugt, z. B. aus einem Worktree-Ordner) — ohne Treffer beide `null`."
    },
    {
     "name": "category_baustelle_label"
    },
    {
     "name": "category_reason",
     "note": "Erklärt die Einsortierung: welche Stufe/Regel welches Merkmal getroffen hat."
    },
    {
     "name": "category_rule_id",
     "note": "Welche `sort_rules`-Zeile (falls eine) zur Einsortierung geführt hat."
    },
    {
     "name": "category_manual",
     "note": "Abgeleitet = `categoryManualArt || categoryManualBaustelle` (nur noch für Anzeige/ Altkompatibilität; die Einsortierung selbst prüft die beiden Dimensionen einzeln)."
    },
    {
     "name": "category_manual_art",
     "note": "true = die ART wurde direkt vom Nutzer korrigiert — wird von `recomputeCategories` nie überschrieben. Getrennt von der Baustelle (\"getrennte Dimensionen\")."
    },
    {
     "name": "category_manual_baustelle",
     "note": "true = die BAUSTELLE wurde direkt vom Nutzer korrigiert — wird von `recomputeCategories` nie überschrieben. Getrennt von der Art."
    },
    {
     "name": "category_undo",
     "note": "Vorzustand je Dimension VOR der letzten `assignSession`-Korrektur dieser Dimension ( Runde 2, Migration `0005_category_undo`) — `unassignSession` liest das, um genau diesen Stand wiederherzustellen (auch eine vorherige manuelle Zuordnung), statt auf die Automatik zu fallen. Wird beim Wiederherstellen für die betroffene(n) Dimension(en) gelöscht (kein Mehrfach-Undo)."
    },
    {
     "name": "tmux_name",
     "note": "tmux-Session (`zc-<werkzeug>-<id>`), in der der Prozess läuft — null = nicht in tmux."
    },
    {
     "name": "attachable",
     "note": "Terminal kann aus der Web-App geöffnet werden (tmux-Session lebt auf dem Rechner)."
    },
    {
     "name": "screen_waiting",
     "note": "Schritt 5: Bildschirm zeigt Freigabe-Frage/Eingabe-Aufforderung (Zusatz zu den Hooks)."
    },
    {
     "name": "started_via",
     "note": "wer die tmux-Session gestartet hat: \"nyxos\" (Web-App) oder null (Terminal-Programm). Steuert den Standard des Schalters „Nur ansehen\" (an bei Terminal-Programm, aus bei NyxOS)."
    },
    {
     "name": "terminal_observed_at",
     "note": "Verspätungs-Schutz für die tmux-Meldungen der Brücke."
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    },
    {
     "name": "last_usage",
     "note": "Tokens + Modell der zuletzt gesehenen Antwort (nicht die Summe der Session) — Grundlage für den Kontext-Anteil (`contextPct`, aus `packages/shared/src/usage.ts` `computeContextPct`). `modelContextWindow` ist nur bei Codex gesetzt (Session meldet ihr Kontextfenster selbst); bei Claude kommt das Kontextfenster aus der Preistabelle."
    },
    {
     "name": "last_usage_model"
    },
    {
     "name": "model_context_window"
    },
    {
     "name": "temporary_since",
     "note": "seit wann die Session temporär ist (null = normale Session). Ablauf: `temporary.ts`."
    },
    {
     "name": "temporary_reason",
     "note": "Warum temporär: \"manual\" (Schalter beim Start) oder eine Auto-Regel (`TemporaryReason`)."
    },
    {
     "name": "temporary_kept",
     "note": "Der Nutzer hat „Behalten“ gewählt → die Auto-Regeln markieren diese Session nie wieder."
    },
    {
     "name": "archived_at",
     "note": "Abgelaufen: aus allen Listen und Zählern raus. Zeile, Ereignisse und Transkript-Archiv bleiben."
    }
   ]
  },
  {
   "name": "skill_jobs",
   "description": "Opus-Aufträge (Neuer Skill / Verbessern / Vorschlag umsetzen): immer sichtbare, temporäre Claude-Session.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "skill_key"
    },
    {
     "name": "suggestion_id"
    },
    {
     "name": "model"
    },
    {
     "name": "brief"
    },
    {
     "name": "session_key"
    },
    {
     "name": "tmux_name"
    },
    {
     "name": "backup_dir"
    },
    {
     "name": "status"
    },
    {
     "name": "error"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "skill_scan_state",
   "description": "Lese-Stand des inkrementellen Nutzungs-Scans (eine Zeile).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "last_received_at"
    },
    {
     "name": "synced_at"
    },
    {
     "name": "backfill_version",
     "note": "Stand des einmaligen Nachzählens (alle Ereignisse neu + Archiv); < SKILL_BACKFILL_VERSION = noch offen."
    }
   ]
  },
  {
   "name": "skill_suggestions",
   "description": "Vorschläge von Nyx (Nyx) zu einem Skill – Nyx schreibt NIE selbst Skills (Hermes `write_approval`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "skill_key"
    },
    {
     "name": "session_key"
    },
    {
     "name": "event_id"
    },
    {
     "name": "signal"
    },
    {
     "name": "problem"
    },
    {
     "name": "evidence"
    },
    {
     "name": "idea"
    },
    {
     "name": "author"
    },
    {
     "name": "open"
    },
    {
     "name": "job_id"
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "skill_uses",
   "description": "Skill-Nutzung aus den Session-Ereignissen (inkrementell): `Skill`-Werkzeug-Aufrufe und `/befehl`-Eingaben.",
   "columns": [
    {
     "name": "event_id"
    },
    {
     "name": "skill"
    },
    {
     "name": "session_key"
    },
    {
     "name": "ts"
    },
    {
     "name": "via"
    },
    {
     "name": "tool_use_id"
    },
    {
     "name": "checked_at",
     "note": "Heuristik gelaufen (Fenster nach dem Aufruf vollständig) + gefundenes Signal."
    },
    {
     "name": "signal"
    }
   ]
  },
  {
   "name": "skill_versions",
   "description": "Verlauf der SKILL.md (Hermes `skill_ledger`): ein Eintrag je neuem Stand (SHA-256), mit Anlass und Auftrag.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "skill_key"
    },
    {
     "name": "sha256"
    },
    {
     "name": "content"
    },
    {
     "name": "reason"
    },
    {
     "name": "job_id"
    },
    {
     "name": "backup_dir"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "skills",
   "description": "── N6 Skill-Bibliothek ────────────────────────────────────────────────────────────────── Skills, wie die Brücke sie zuletzt gemeldet hat (Stand ohne Brücke). `key` = Aufruf-Name. Verschwindet ein Skill vom Mac, bleibt die Zeile mit `missing_since` (nie still löschen, wie Hermes: nur archivieren).",
   "columns": [
    {
     "name": "key"
    },
    {
     "name": "name"
    },
    {
     "name": "description"
    },
    {
     "name": "source"
    },
    {
     "name": "plugin"
    },
    {
     "name": "dir"
    },
    {
     "name": "skill_path"
    },
    {
     "name": "writable"
    },
    {
     "name": "sha256"
    },
    {
     "name": "bytes"
    },
    {
     "name": "files"
    },
    {
     "name": "pinned",
     "note": "Angepinnt = Nyx schreibt keine Vorschläge dazu (Hermes `pinned`)."
    },
    {
     "name": "seen_at"
    },
    {
     "name": "missing_since"
    }
   ]
  },
  {
   "name": "sort_rules",
   "description": "Regeln vom Nutzer (manuell angelegt oder aus einer Korrektur per `POST /api/sessions/:id/assign` entstanden). Haben Vorrang vor den fest im Code stehenden Standard-Regeln (`categorize.ts`) — aber nur in ihrer eigenen Dimension: `dimension = 'art'` setzt nur die Art, `dimension = 'baustelle'` nur die Baustelle. `condition` ist eine `RuleCondition` aus `categorize.ts` (Ordner/Arbeitsordner/Skill/Titel-Wort) — Ordner-Bedingungen kommen nur bei `dimension = 'baustelle'` vor (nie für Art, s. `buildCorrectionCondition`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "condition"
    },
    {
     "name": "baustelle",
     "note": "'art' | 'baustelle'. Default 'baustelle' ist nur für die additive Migration relevant (alte Zeilen ohne Dimension gab es nie in Produktion, s. BETRIEB.md) — neuer Code setzt es immer."
    },
    {
     "name": "target_art",
     "note": "Nullable seit P2-F2: nur gesetzt, wenn `dimension = 'art'`."
    },
    {
     "name": "target_baustelle_slug"
    },
    {
     "name": "target_baustelle_label"
    },
    {
     "name": "origin"
    },
    {
     "name": "active"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "subtasks",
   "description": "Teilaufgaben bzw. Reife-Punkte einer Aufgabe/eines Bugs. `doneBySessionKey` wird nur von der Automatik gesetzt (MCP `teilaufgabe_erledigt`, Git-Wächter) — nie von Hand behauptet.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "entry_id"
    },
    {
     "name": "title"
    },
    {
     "name": "weight"
    },
    {
     "name": "done"
    },
    {
     "name": "done_by_session_key"
    },
    {
     "name": "done_at"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "support_outbox",
   "description": "„Feedback & Unterstützen“: Postausgang für Fehlermeldungen und Ideen an den Entwickler (support/service.ts). `status`: `draft` (Entwurf, z. B. von Nyx vorbereitet – geht nie von selbst raus) · `waiting` (wartet auf die Meldestelle bzw. Verbindung, geht im 60-s-Takt von selbst raus) · `sending` · `sent` · `rejected` (die Meldestelle hat abgelehnt, kein neuer Versuch). `client_id` ist der Idempotenz-Schlüssel beim Weiterleiten.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "kind"
    },
    {
     "name": "status"
    },
    {
     "name": "title"
    },
    {
     "name": "payload"
    },
    {
     "name": "client_id"
    },
    {
     "name": "attempts"
    },
    {
     "name": "last_error"
    },
    {
     "name": "reference"
    },
    {
     "name": "created_at"
    },
    {
     "name": "updated_at"
    },
    {
     "name": "next_attempt_at"
    },
    {
     "name": "sent_at"
    }
   ]
  },
  {
   "name": "support_settings",
   "description": "Adresse der Meldestelle aus den Einstellungen (eine Zeile, `id = 1`). `NYXOS_SUPPORT_URL` geht vor.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "url"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "telegram_state",
   "description": "Telegram: EINE Zeile (`id = 1`). Gekoppelt ist genau ein Chat (der Nutzer). Vom Kopplungs-Code liegt nur ein gesalzener SHA-256-Hash hier (Hermes `pairing.py`), nie der Code selbst. Das Bot-Token liegt NICHT hier, sondern im Geheimnis-Speicher bzw. in der Server-.env.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "chat_id"
    },
    {
     "name": "chat_name"
    },
    {
     "name": "paired_at"
    },
    {
     "name": "pair_hash"
    },
    {
     "name": "pair_salt"
    },
    {
     "name": "pair_expires_at"
    },
    {
     "name": "pair_failures"
    },
    {
     "name": "pair_locked_until"
    },
    {
     "name": "nyx",
     "note": "'nyx' | 'session' — wohin freie Nachrichten gehen."
    },
    {
     "name": "session_key"
    },
    {
     "name": "nyx_thread_id"
    },
    {
     "name": "talk_mode",
     "note": "„📞 Sprechen“: jede Sprachnachricht wird sofort beantwortet, Antwort nur als Sprache."
    },
    {
     "name": "settings"
    },
    {
     "name": "forwarded",
     "note": "Letzte nach Telegram geschickte Antwort je Session (Ereignis-ID), damit nichts doppelt kommt."
    },
    {
     "name": "commands_hash",
     "note": "Hash des zuletzt gesetzten Befehlsmenüs (`setMyCommands` nur bei Änderung, OpenClaw T-4)."
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "temporary_marks",
   "description": "„Temporär“ beim Start einer Codex-Session – die ID kommt erst mit der ersten Verlaufszeile, darum hängt die Markierung am tmux-Namen, bis die Session erscheint (danach gelöscht).",
   "columns": [
    {
     "name": "tmux_name"
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "temporary_settings",
   "description": "Nach wie vielen Stunden Stille temporäre Sessions archiviert und Nyx-Fäden gelöscht werden (1–72).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "hours"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "usage_daily",
   "description": "Verdichtung von `usage_events` je Tag/Werkzeug/Modell/Projekt — Grundlage der Nutzung-Tab- Diagramme, damit die Web-App nie Millionen Einzelzeilen aggregieren muss.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "day"
    },
    {
     "name": "tool"
    },
    {
     "name": "model"
    },
    {
     "name": "project"
    },
    {
     "name": "input_tokens"
    },
    {
     "name": "output_tokens"
    },
    {
     "name": "cache_read_tokens"
    },
    {
     "name": "cache_creation_5m_tokens"
    },
    {
     "name": "cache_creation_1h_tokens"
    },
    {
     "name": "reasoning_tokens"
    },
    {
     "name": "total_tokens"
    },
    {
     "name": "cost"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "usage_events",
   "description": "(Nutzung): eine Zeile je Nachricht mit Tokennutzung, aus einem Bestand-Scan der Brücke über ALLE Claude-/Codex-Verläufe (\"alle Projekte, aber ohne Inhalte\"). `project`: Name des Projekts (Ordnername des Repos) für Sessions unterhalb der Projektordner — sonst `'andere'` (bewusst EIN fester, nicht unterscheidbarer Wert, kein Projektname/Pfad: die Anzeige/DB darf nie erkennen lassen, an welchem fremden Projekt gearbeitet wurde). `sessionKey` ist nur bei erfassten Projekten gesetzt (informativ, KEIN Fremdschlüssel — der Scan läuft unabhängig vom Session-Ingest, eine passende `sessions`-Zeile muss nicht existieren). `id` ist deterministisch aus Werkzeug/Session/Zeit/Modell/Zahlen gebildet (s. `usage/ingest.ts`), damit ein erneuter Scan nie doppelt zählt.",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "ts"
    },
    {
     "name": "tool"
    },
    {
     "name": "model"
    },
    {
     "name": "project"
    },
    {
     "name": "session_key"
    },
    {
     "name": "input_tokens"
    },
    {
     "name": "output_tokens"
    },
    {
     "name": "cache_read_tokens"
    },
    {
     "name": "cache_creation_5m_tokens"
    },
    {
     "name": "cache_creation_1h_tokens"
    },
    {
     "name": "reasoning_tokens"
    },
    {
     "name": "cost",
     "note": "In USD, mit dem zum Zeitpunkt des Einlesens gültigen Preis (`prices`) berechnet; `null` = kein Preis für dieses Modell hinterlegt (nie geschätzt, s. GOAL/ESKALATION)."
    },
    {
     "name": "created_at"
    }
   ]
  },
  {
   "name": "usage_settings",
   "description": "Bestand an Agenten/Skills (Name, Beschreibung, Pfad, Herkunft) — meldet die Brücke bei Änderung . `kind`: `'agent'` | `'skill'`. `source`: z. B. `'user'` (`~/.claude/agents`), `'project'` (`<Projektordner>/.claude/agents`), `'plugin:<name>'`. Einstellungen der Nutzung — eine Zeile (`id = 1`), vom Server beim ersten Lesen mit den Standardwerten angelegt (wie `push_settings`). Ziele/Warnschwellen in Tokens (`null` = aus). `warnState` merkt sich, wann zuletzt gewarnt wurde (Tag bzw. Zeitpunkt je Werkzeug), damit der 60-s-Ticker nicht jede Minute neu warnt (`usage/warnings.ts`).",
   "columns": [
    {
     "name": "id"
    },
    {
     "name": "30"
    },
    {
     "name": "all"
    },
    {
     "name": "goal_month_tokens"
    },
    {
     "name": "goal_week_tokens"
    },
    {
     "name": "warn_window_pct"
    },
    {
     "name": "warn_daily_tokens"
    },
    {
     "name": "warn_state"
    },
    {
     "name": "updated_at"
    }
   ]
  },
  {
   "name": "vault_notes",
   "description": "PG „Gehirn\": Obsidian-Notizen aus dem Vault auf dem Rechner (Brücke liest nur, `POST /ingest/vault`). Nur Metadaten + Link-Ziele + genannte Session-IDs, KEIN Volltext. `path` relativ zur Wurzel; Schlüssel (root, path), damit mehrere Vaults/Maschinen sich nicht gegenseitig löschen. `sync_id` = Kennung des vollständigen Abgleichs, der die Zeile zuletzt bestätigt hat — nach dem letzten Teil eines Vollabgleichs löscht der Server Zeilen mit anderer Kennung (Datei gelöscht).",
   "columns": [
    {
     "name": "path"
    },
    {
     "name": "machine_id"
    },
    {
     "name": "root"
    },
    {
     "name": "title"
    },
    {
     "name": "heading"
    },
    {
     "name": "folder"
    },
    {
     "name": "tags"
    },
    {
     "name": "links"
    },
    {
     "name": "mentions"
    },
    {
     "name": "mtime"
    },
    {
     "name": "size"
    },
    {
     "name": "excerpt",
     "note": "Anfang der Notiz (≤ 600 Zeichen, reiner Text) für die Info-Karte; null bei älteren Brücken."
    },
    {
     "name": "source_path",
     "note": "Quelldatei einer Code-Notiz (Frontmatter `path`) — daraus die Fremd-Bibliothek im Gehirn; null bei älteren Brücken."
    },
    {
     "name": "sync_id"
    },
    {
     "name": "updated_at"
    }
   ]
  }
 ]
};
