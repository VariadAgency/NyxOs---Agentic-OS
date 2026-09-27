// „In Obsidian ablegen“ – ein Nyx-Faden wird Notiz im Vault. Der Vault wird sonst nur gelesen
// (vault/scan.ts); das hier ist der EINE schreibende Weg: fester Ordner, harmloser Name, nie überschreiben.
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t, TERM_ERR, type VaultNoteRequest, type VaultNoteResult } from "@nyxos/shared";
import { underRoot } from "../config.js";
import { RpcError } from "../terminal/manager.js";

/** Neben den Session-Notizen (`01 Sessions/YYYY-MM-DD Titel.md`), eigener Unterordner für Nyx. */
export const VAULT_NOTE_FOLDER = "01 Sessions/Nyx";
const MAX_NAME = 120;
const MAX_SAME_NAME = 100;

/** `YYYY-MM-DD Nyx – Titel.md`; Zeichen, die in Pfaden oder Obsidian-Links stören, werden Leerzeichen –
 * Ebenso unsichtbare Steuer- und Richtungszeichen (`\u202E` drehte die Anzeige im Finder um). */
export function vaultNoteName(day: string, title: string, n = 1): string {
  const words = title
    .normalize("NFC")
    .replace(/[/\\:*?"<>|#^[\]\p{Cc}\p{Cf}]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !/^\.+$/.test(w));
  const prefix = `${day} Nyx – `;
  const suffix = `${n > 1 ? ` (${n})` : ""}.md`;
  const clean = words.join(" ").replace(/^\.+/, "").trim() || "Faden";
  // Kürzen darf kein Emoji halbieren (einzelnes Ersatzzeichen am Ende).
  const cut = clean.slice(0, MAX_NAME - prefix.length - suffix.length).replace(/[\uD800-\uDBFF]$/, "");
  return `${prefix}${cut.trim()}${suffix}`;
}

export function writeVaultNote(vaultDir: string | null | undefined, req: VaultNoteRequest): VaultNoteResult {
  if (!vaultDir) throw new RpcError(t("Auf diesem Rechner ist kein Obsidian-Vault eingerichtet"), "failed");
  let root: string;
  try {
    root = realpathSync(vaultDir);
  } catch {
    throw new RpcError(t("Der Obsidian-Vault ist auf diesem Rechner nicht da"), TERM_ERR.badFolder);
  }
  // Stufe für Stufe anlegen und prüfen: `mkdirSync(recursive)` folgte einem Link im Zwischenordner und legte
  // Den Ordner DRAUSSEN an, bevor eine Prüfung danach greifen konnte.
  let dir = root;
  for (const part of VAULT_NOTE_FOLDER.split("/")) {
    dir = join(dir, part);
    try {
      lstatSync(dir);
    } catch {
      mkdirSync(dir);
    }
    // Nie über einen Link aus dem Vault hinaus schreiben.
    if (!underRoot(realpathSync(dir), root)) throw new RpcError(t("Der Notiz-Ordner liegt nicht im Vault"), TERM_ERR.badFolder);
  }
  for (let n = 1; n <= MAX_SAME_NAME; n++) {
    const name = vaultNoteName(req.day, req.title, n);
    try {
      writeFileSync(join(dir, name), req.markdown, { flag: "wx", mode: 0o644 });
      return { relPath: `${VAULT_NOTE_FOLDER}/${name}` };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new RpcError(t("Zu viele Notizen mit diesem Namen"), "failed");
}
