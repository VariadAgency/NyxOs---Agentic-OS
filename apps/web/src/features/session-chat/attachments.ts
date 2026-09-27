// Anhänge im Browser prüfen und lesen (Base64), bevor sie mit der Nachricht rausgehen.
import { CHAT_MAX_FILE_BYTES, CHAT_MAX_FILES, CHAT_MAX_TOTAL_BYTES, chatFileAllowed, chatFileIsImage, locale, t } from "@nyxos/shared";

export interface DraftAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  image: boolean;
  /** Vorschaubild (nur Bilder), per `URL.createObjectURL`. */
  previewUrl: string | null;
}

const MB = 1024 * 1024;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `a${Date.now().toString(36)}${counter}`;
}

function preview(file: File, image: boolean): string | null {
  if (!image || typeof URL.createObjectURL !== "function") return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

export function releasePreview(a: DraftAttachment): void {
  if (a.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(a.previewUrl);
}

/** Neue Dateien zu den vorhandenen: erlaubte Arten, Größen, Anzahl. Fehler als ein Satz für dich. */
export function addDrafts(current: DraftAttachment[], files: File[]): { next: DraftAttachment[]; error: string | null } {
  const next = [...current];
  const problems: string[] = [];
  for (const file of files) {
    if (!chatFileAllowed(file.name)) {
      problems.push(t("„{name}“ kann ich nicht anhängen – erlaubt sind Bilder, PDF und Text-/Code-Dateien.", { name: file.name }));
      continue;
    }
    if (file.size === 0) {
      problems.push(t("„{name}“ ist leer – nichts zum Anhängen.", { name: file.name }));
      continue;
    }
    if (file.size > CHAT_MAX_FILE_BYTES) {
      problems.push(t("„{name}“ ist zu groß (höchstens {mb} MB je Datei).", { name: file.name, mb: CHAT_MAX_FILE_BYTES / MB }));
      continue;
    }
    if (next.length >= CHAT_MAX_FILES) {
      problems.push(t("Höchstens {n} Dateien je Nachricht.", { n: CHAT_MAX_FILES }));
      break;
    }
    if (next.reduce((s, a) => s + a.size, 0) + file.size > CHAT_MAX_TOTAL_BYTES) {
      problems.push(t("Zusammen höchstens {mb} MB je Nachricht.", { mb: CHAT_MAX_TOTAL_BYTES / MB }));
      break;
    }
    const image = chatFileIsImage(file.name);
    next.push({ id: nextId(), file, name: file.name, size: file.size, image, previewUrl: preview(file, image) });
  }
  return { next, error: problems.length > 0 ? problems.join(" ") : null };
}

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("„{name}“ konnte nicht gelesen werden.", { name: file.name })));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.readAsDataURL(file);
  });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}
