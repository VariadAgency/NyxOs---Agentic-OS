// Verwaltung im Container: `node dist/cli.js add-machine <name>` gibt einmalig das Token aus.
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { hashToken } from "./app.js";
import { connect } from "./db/client.js";
import { machines, sessions } from "./db/schema.js";
import { DigestService } from "./session-digest.js";
import { computeDeployPlan } from "./deploy-plan.js";
import { reindexSearch } from "./search.js";
import { createSetupCode, resetPasskeys } from "./terminal/auth.js";
import { backfillStates, resortAll } from "./store.js";
import { TranscriptCache } from "./transcript.js";

const [cmd, name] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL fehlt");
const { db, close } = connect(url);

try {
  if ((cmd === "add-machine" || cmd === "rotate-token") && name) {
    const token = randomBytes(32).toString("base64url");
    if (cmd === "add-machine") {
      await db.insert(machines).values({ id: randomUUID(), name, tokenHash: hashToken(token) });
    } else {
      const res = await db.update(machines).set({ tokenHash: hashToken(token) }).where(eq(machines.name, name)).returning({ id: machines.id });
      if (res.length === 0) throw new Error(`Maschine ${name} unbekannt`);
    }
    process.stdout.write(token + "\n");
  } else if (cmd === "list-machines") {
    for (const m of await db.select({ name: machines.name, lastSeenAt: machines.lastSeenAt }).from(machines)) {
      console.log(`${m.name}\t${m.lastSeenAt ?? "nie"}`);
    }
  } else if (cmd === "backfill-states") {
    // Rückrechnung für Bestandsdaten nach Migration 0001 — keine Session-Inhalte im Log.
    const { byState, changed } = await backfillStates(db, Date.now());
    for (const [state, count] of Object.entries(byState).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`${state}\t${count}`);
    }
    console.log(`geändert\t${changed}`);
  } else if (cmd === "resort") {
    // Berechnet Art/Baustelle für alle nicht-manuellen Sessions neu — z. B. nach neuen
    // Standard-Regeln im Code oder nach dem Nachimport, der Skill-Namen erst nachträglich liefert.
    const changed = await resortAll(db);
    console.log(`umsortiert\t${changed.length}`);
  } else if (cmd === "reindex-search") {
    // Baut den Volltext-Index komplett neu auf — für den Bestand nach dem Deploy der
    // Migration 0003_search, idempotent (löscht vorher alle search_docs). Keine Inhalte im Log.
    const { byField } = await reindexSearch(db, new TranscriptCache());
    for (const [field, count] of Object.entries(byField).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`${field}\t${count}`);
    }
  } else if (cmd === "digest-all") {
    // Digests der Seitenpanels für den Bestand vorrechnen (sonst rechnet der erste Abruf
    // einer großen Session sie, das dauert bei ~100 Sub-Agenten über eine Minute). Idempotent: schon
    // aktuelle Digests werden übersprungen. Neueste Sessions zuerst. Keine Inhalte im Log.
    const service = new DigestService(db);
    const all = await db.select({ id: sessions.id }).from(sessions).orderBy(sql`coalesce(${sessions.lastActivityAt}, ${sessions.startedAt}) desc nulls last`);
    let files = 0;
    for (const s of all) files += (await service.forSession(s.id)).length;
    console.log(`sessions\t${all.length}`);
    console.log(`dateien\t${files}`);
  } else if (cmd === "deploy-plan") {
    // Welche Migrationen aus `drizzle/meta/_journal.json` fehlen der DB noch (Leit-Spalten aus
    // `schema-check.ts`)? Reines Lesekommando, schreibt nichts.
    process.stdout.write(JSON.stringify(await computeDeployPlan(db)) + "\n");
  } else if (cmd === "passkey-setup") {
    // Einmal-Code (15 Min) zum Einrichten eines Passkeys im Browser — nur der Hash liegt in der DB.
    process.stdout.write((await createSetupCode(db)) + "\n");
  } else if (cmd === "passkey-reset") {
    // alle Passkeys + Anmelde-Sitzungen löschen (verlorenes Gerät). Danach neu einrichten.
    const r = await resetPasskeys(db);
    console.log(`passkeys\t${r.credentials}\nsitzungen\t${r.sessions}`);
  } else {
    console.error("Aufruf: cli.js add-machine <name> | rotate-token <name> | list-machines | backfill-states | resort | reindex-search | deploy-plan | passkey-setup | passkey-reset");
    process.exitCode = 2;
  }
} finally {
  await close();
}
