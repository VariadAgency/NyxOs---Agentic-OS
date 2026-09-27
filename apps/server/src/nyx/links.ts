// Links, die Nyx zeigt (`show_link`): nur http(s)-Adressen und Pfade innerhalb von NyxOS („/sessions/…“) –
// nie `javascript:` o. Ä. Links liegen nur in der Aufgaben-Karte (`nyx.task`), Bilder in `nyx_files`.

/** Geprüfte Adresse oder `null`. */
export function safeLink(url: string): string | null {
  const u = url.trim();
  if (/^\/(?!\/)[\w\-./?=&%#~+:]*$/.test(u)) return u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
