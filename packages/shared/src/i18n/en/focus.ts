// English texts for the area "focus" — focus button in the sidebar, its menu, the settings row, the route and the
// focus notes in the notification pipeline (packages/shared/src/focus.ts).
const en: Record<string, string> = {
  // Modes
  "Automatisch": "Automatic",
  "Ich bin weg": "I'm away",
  "Weg": "Away",
  "Nicht stören": "Do not disturb",
  "Wie bisher: NyxOS merkt selbst, ob du da bist, und schickt dann auf den Rechner oder aufs Handy.": "As before: NyxOS notices by itself whether you're here and sends to your computer or your phone.",
  "Alles kommt aufs Handy (Push und Telegram-Fragen), Rechner und Browser bleiben still – auch wenn NyxOS offen ist.": "Everything goes to your phone (push and Telegram questions), computer and browser stay silent – even when NyxOS is open.",
  "Rechner und Browser bleiben still – auch wenn NyxOS offen ist. Aufs Handy kommt es, wenn Telegram oder ntfy eingerichtet ist.": "Computer and browser stay silent – even when NyxOS is open. It reaches your phone if Telegram or ntfy is set up.",
  "Keine Mitteilungen auf Rechner und Browser. Aufs Handy nur Wichtiges: Freigaben, Abstürze, fehlgeschlagener Deploy.": "No notifications on computer and browser. Only important things reach your phone: approvals, crashes, a failed deploy.",
  // Until
  "bis du es ausschaltest": "until you turn it off",
  "bis {time}": "until {time}",
  "bis morgen {time}": "until tomorrow {time}",
  "bis {day} {time}": "until {day} {time}",
  // Menu
  "Fokus": "Focus",
  "Fokus wählen": "Choose focus",
  "Fokus: {summary}": "Focus: {summary}",
  "1 Stunde": "1 hour",
  "Bis heute Abend": "Until this evening",
  "Bis morgen früh": "Until tomorrow morning",
  "Bis ich es ausschalte": "Until I turn it off",
  "{mode} – wie lange?": "{mode} – for how long?",
  "Automatisch – NyxOS erkennt wieder selbst, ob du da bist.": "Automatic – NyxOS detects again by itself whether you're here.",
  "{summary} – an.": "{summary} – on.",
  "Mehr in den Einstellungen →": "More in settings →",
  "Den Fokus stellst du auch unten links in der Leiste um (am Handy unter „Mehr“) – oder sag Nyx: „Ich bin weg bis 18 Uhr“.": "You can also change the focus at the bottom left of the sidebar (on the phone under “More”) – or tell Nyx: “I'm away until 6 pm”.",
  "Nicht angemeldet – bitte zuerst anmelden.": "Not signed in – please sign in first.",
  // Server
  "Das Ende muss in der Zukunft liegen.": "The end must be in the future.",
  "Ungültiger Fokus": "Invalid focus",
  "Ich bin weg: Rechner und Browser still": "I'm away: computer and browser silent",
  "Nicht stören – Rechner, Browser und Handy still": "Do not disturb – computer, browser and phone silent",
  "Nicht stören: kommt als Telegram-Karte": "Do not disturb: comes as a Telegram card",
  "Nicht stören: nur aufs Handy": "Do not disturb: phone only",
  "Fokus – still gestellt": "Focus – silenced",
};

export default en;
