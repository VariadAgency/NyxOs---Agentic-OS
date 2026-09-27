/**
 * Markdown → einfacher, sicherer Text (Info-Karte im Gehirn). Ergebnis ist reiner Text für
 * React-Textknoten — nie als HTML gedacht. HTML aus den Daten fliegt komplett raus (Tags samt
 * `<script>`/`<style>`-Inhalt), Links werden zu ihrem Text (kein `href` aus Daten), Aufzählungen
 * zu „• …", Überschriften/Zitate zu normalen Zeilen. Zeilenumbrüche bleiben, höchstens eine
 * Leerzeile am Stück. Idempotent: zweimal angewendet ändert sich nichts.
 */
export function markdownToText(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  const src = md
    .replace(/\r\n?/g, "\n")
    // Skript-/Stil-Blöcke samt Inhalt, dann alle übrigen Tags. Nur geschlossene Tags in einer Zeile —
    // ein einzelnes „<" (a<b) fraß sonst allen Text bis zum nächsten „>"; offene Reste
    // entfernt `inline` als Zeichen. Gerendert wird ohnehin nur als Text.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-z!][^<>\n]*>/gi, " ");
  for (const raw of src.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (f?.[1] && f[1][0] === fence[0] && raw.trim() === f[1]) fence = null;
      else out.push(raw.replace(/\s+$/, ""));
      continue;
    }
    if (f?.[1]) {
      fence = f[1];
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(raw)) continue; // Trennlinie, Tabellenkopf-Linie
    let line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s{0,3}(>\s?)+/, "")
      .replace(/\s+#+\s*$/, "");
    const bullet = /^(\s*)[-*+•]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bullet) line = `${bullet[1] ?? ""}• ${bullet[2] ?? ""}`;
    else line = line.replace(/^(\s*\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "$1 ");
    out.push(inline(line).replace(/\s+$/, ""));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inline(s: string): string {
  return s
    .replace(/!\[\[[^\]\n]*\]\]/g, "")
    .replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
      const [target = "", alias] = inner.split("|");
      return alias?.trim() || (target.split("#")[0] ?? "").split("/").pop()?.trim() || "";
    })
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1")
    .replace(/`+/g, "")
    // nur gepaarte Markierungen (**fett**, ==markiert==) — „x == 1" bleibt stehen
    .replace(/(\*\*|__|~~|==)(?=\S)(.*?\S)\1/g, "$2")
    .replace(/\*\*/g, "")
    .replace(/(^|[\s(•])[*_]+(?=\S)|(?<=\S)[*_]+(?=[\s).,;:!?]|$)/g, "$1")
    .replace(/\s*\|\s*/g, (m, off: number, str: string) => (off === 0 || off + m.length >= str.length ? "" : " · "))
    .replace(/&nbsp;/g, " ")
    .replace(/[<>]/g, "")
    .replace(/[ \t]{2,}/g, " ");
}
