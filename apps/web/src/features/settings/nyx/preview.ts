// Live-Beispielsatz „So würde Nyx jetzt antworten“ – lokal aus Textbausteinen, kein Modellaufruf.
// Jeder Regler wirkt sichtbar (Länge, Tempo, Erklärtiefe, Ton, Eigeninitiative, Humor), dazu die Anrede.
import { nyxLevel, t, type NyxProfile } from "@nyxos/shared";

/** Die Beispielfrage, auf die die Vorschau antwortet. */
export const PREVIEW_QUESTION = t("Wie steht der Build?");

type Depth = "tech" | "mid" | "simple";

const CORE: Record<Depth, string> = {
  tech: t("Build #142 ist grün: Typecheck, Lint und alle 318 Tests bestanden."),
  mid: t("Der Build ist grün – alle Prüfungen sind bestanden."),
  simple: t("Alles in Ordnung: Die App lässt sich fehlerfrei bauen, jede Prüfung hat geklappt."),
};

const DETAILS: Record<Depth, readonly [string, string, string]> = {
  tech: [
    t("Letzter Commit: „Nyx-Profil“ auf main, Laufzeit 2:41 min."),
    t("Offen ist nur eine Lint-Warnung (ungenutzte Variable in persona.ts)."),
    t("Gestern lag die Laufzeit bei 3:05 min – der Cache greift also."),
  ],
  mid: [
    t("Die letzte Änderung war das Nyx-Profil, gebaut in knapp drei Minuten."),
    t("Es gibt nur einen kleinen Schönheitsfehler, der nichts kaputt macht."),
    t("Gestern dauerte es etwas länger – es wird also schneller."),
  ],
  simple: [
    t("Die letzte Änderung – das neue Nyx-Profil – ist damit fertig eingebaut."),
    t("Es gibt nur eine Kleinigkeit zum Aufräumen, nichts Schlimmes."),
    t("Das Ganze ging sogar etwas schneller als gestern."),
  ],
};

const SPEED = [t("(Kurzer Blick auf den letzten Lauf.)"), "", "", t("Ich habe die letzten drei Läufe verglichen."), t("Ich habe es doppelt geprüft – auch der Lauf von heute Nacht war sauber.")] as const;
const HUMOR = ["", "", "", t("Läuft."), t("Läuft wie ein Uhrwerk – fast schon langweilig.")] as const;

function depthOf(expertise: number): Depth {
  const l = nyxLevel(expertise);
  return l <= 1 ? "tech" : l === 2 ? "mid" : "simple";
}

function greeting(level: number, name: string, sie: boolean): string {
  if (level === 0) return t("Guten Tag.");
  if (level <= 2) return "";
  if (sie || level === 3) return name ? t("Hallo {name}!", { name }) : t("Hallo!");
  return name ? t("Hey {name}!", { name }) : t("Hey!");
}

function initiative(level: number, sie: boolean): string {
  if (level <= 1) return "";
  if (level === 2) return t("Nächster Schritt wäre der Deploy.");
  if (level === 3) return t("Soll ich den Deploy als Freigabe vorbereiten?");
  return sie
    ? t("Ich habe Ihnen schon eine Freigabe-Karte für den Deploy in die Inbox gelegt – Sie müssen nur noch bestätigen.")
    : t("Ich habe dir schon eine Freigabe-Karte für den Deploy in die Inbox gelegt – du musst nur noch bestätigen.");
}

/** Beispiel-Antwort auf {@link PREVIEW_QUESTION} für die aktuelle Einstellung. */
export function previewAnswer(profile: NyxProfile): string {
  const { sliders, personality, user } = profile;
  const sie = personality.address === "Sie";
  const name = user.name.trim();
  const depth = depthOf(sliders.expertise);
  const extra = Math.max(0, nyxLevel(sliders.length) - 1); // 0–3 Zusatzsätze
  const parts = [
    greeting(nyxLevel(sliders.formality), name, sie),
    CORE[depth],
    SPEED[nyxLevel(sliders.speed)],
    ...DETAILS[depth].slice(0, extra),
    initiative(nyxLevel(sliders.initiative), sie),
    HUMOR[nyxLevel(sliders.humor)],
  ];
  return parts.filter(Boolean).join(" ");
}
