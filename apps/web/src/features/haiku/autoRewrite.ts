// Sperre für das automatische Neuschreiben des Briefings beim Öffnen.
// Die Seite wollte sich beim Öffnen 4× selbst neu schreiben. Die alte Sperre war ein `useRef` in der Seite und
// galt nur, solange die Seite eingehängt blieb – jeder Tab-Wechsel und jedes Neuladen hängt sie neu ein, und bei
// einem veralteten Bericht (oder einem gescheiterten Lauf) ging dann wieder ein POST los.
// Jetzt: je Art (Briefing/Recap) höchstens EIN automatischer Lauf pro veraltetem Bericht, und danach
// `COOLDOWN_MS` Ruhe – im Browser gemerkt (übersteht Neu-Einhängen und Neuladen). Von Hand geht es jederzeit.
import type { HaikuReport } from "@nyxos/shared";

type Kind = HaikuReport["kind"];
interface Claim {
  reportId: number;
  at: number;
}

const STORE_KEY = "nyxos.briefing.autoRewrite";
/** Nach einem automatischen Lauf ruht die Automatik so lange (auch für einen neuen, wieder veralteten Bericht). */
export const AUTO_REWRITE_COOLDOWN_MS = 10 * 60_000;

/**
 * Rückfall, wenn der Browser keinen Speicher erlaubt: gilt bis zum Neuladen. Älteres Safari im privaten Modus liest
 * still `null` und wirft erst beim SCHREIBEN – darum merkt sich `storageOk`, ob das Schreiben geklappt hat; danach
 * zählt nur noch der Spiegel (sonst ginge die Sperre dort verloren und jedes Öffnen schickte wieder einen POST).
 */
let memory: Partial<Record<Kind, Claim>> = {};
let storageOk = true;

const isClaim = (v: unknown): v is Claim =>
  typeof v === "object" && v !== null && typeof (v as Claim).reportId === "number" && typeof (v as Claim).at === "number";

function read(): Partial<Record<Kind, Claim>> {
  if (!storageOk) return memory;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null) return {};
    // Kaputte/fremde Einträge nicht blind übernehmen: nur gültige Sperren je Art.
    const out: Partial<Record<Kind, Claim>> = {};
    for (const k of ["briefing", "recap"] as const) {
      const v = (parsed as Record<string, unknown>)[k];
      if (isClaim(v)) out[k] = v;
    }
    return out;
  } catch {
    return memory;
  }
}

function write(all: Partial<Record<Kind, Claim>>): void {
  memory = { ...all };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    storageOk = false;
  }
}

function blocked(last: Claim | undefined, reportId: number, now: number): boolean {
  if (!last) return false;
  return last.reportId === reportId || (now - last.at >= 0 && now - last.at < AUTO_REWRITE_COOLDOWN_MS);
}

/** Würde ein veralteter Bericht jetzt automatisch neu geschrieben? (nur nachsehen, nichts merken) */
export function autoRewriteAllowed(kind: Kind, reportId: number, now = Date.now()): boolean {
  return !blocked(read()[kind], reportId, now);
}

/** Den automatischen Lauf für diesen Bericht beanspruchen: `true` genau einmal, danach gesperrt. */
export function claimAutoRewrite(kind: Kind, reportId: number, now = Date.now()): boolean {
  const all = read();
  if (blocked(all[kind], reportId, now)) return false;
  write({ ...all, [kind]: { reportId, at: now } });
  return true;
}
