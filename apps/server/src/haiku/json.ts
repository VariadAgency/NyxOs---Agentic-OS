// JSON aus einer Modell-Antwort holen – tolerant gegenüber ```json-Zäunen, Text davor/danach und
// ASCII-Anführungszeichen mitten in deutschen Sätzen (häufigster Fehler: "text":"… "Titel" …").

function balancedObjects(text: string): string[] {
  const out: string[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
    if (out.length) break;
  }
  return out;
}

/** Ersetzt ASCII-Anführungszeichen, die offensichtlich IN einem Stringwert stehen, durch „“. */
function repairInnerQuotes(json: string): string {
  // Ein `"` ist Struktur, wenn davor (ohne Leerraum) { [ , : steht oder danach : , } ] folgt.
  let out = "";
  let inStr = false;
  let open = true;
  let german = 0; // offene „ im aktuellen String – ein folgendes " schließt es (typischer Modellfehler: „Titel")
  for (let i = 0; i < json.length; i++) {
    const ch = json[i] as string;
    if (ch === "\\" && inStr) {
      out += ch + (json[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch !== '"') {
      if (inStr && ch === "„") german++;
      if (inStr && ch === "“" && german > 0) german--;
      out += ch;
      continue;
    }
    if (!inStr) {
      inStr = true;
      german = 0;
      out += ch;
      continue;
    }
    if (german > 0) {
      german--;
      out += "“";
      continue;
    }
    const after = json.slice(i + 1).match(/^\s*(.)/)?.[1] ?? "";
    if ([":", ",", "}", "]"].includes(after)) {
      inStr = false;
      out += ch;
    } else {
      out += open ? "„" : "“";
      open = !open;
    }
  }
  return out;
}

export function extractJson<T = unknown>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  // Prüfstand-Fund: erst die GANZE Spanne { … } (roh, dann repariert). Der Klammer-Zähler versteht
  // „Titel" (deutsch auf, ASCII zu) nicht und fand sonst nur das erste innere Objekt — ein einzelner Satz
  // ohne `saetze`, das Briefing fiel dann auf „nur Daten“ zurück.
  const whole = cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1);
  for (const candidate of [whole, ...balancedObjects(cleaned)]) {
    if (!candidate.startsWith("{")) continue;
    for (const attempt of [candidate, repairInnerQuotes(candidate)]) {
      try {
        return JSON.parse(attempt) as T;
      } catch {
        // nächster Versuch
      }
    }
  }
  return null;
}
