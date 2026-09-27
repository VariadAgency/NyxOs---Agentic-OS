// PG: Schreibt die Vault-Metadaten der Brücke in `vault_notes` (nur Metadaten, kein Volltext).
import type { VaultIngest } from "@nyxos/shared";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { vaultNotes } from "../db/schema.js";

const CHUNK = 250;

export interface VaultIngestOutcome {
  upserted: number;
  deleted: number;
}

export async function ingestVault(db: Db, machineId: string, payload: VaultIngest): Promise<VaultIngestOutcome> {
  return db.transaction(async (tx) => {
    let deleted = 0;
    for (let i = 0; i < payload.notes.length; i += CHUNK) {
      const part = payload.notes.slice(i, i + CHUNK).map((n) => ({
        path: n.path,
        machineId,
        root: payload.root,
        title: n.title,
        heading: n.heading,
        folder: n.folder,
        tags: n.tags,
        links: n.links,
        mentions: n.mentions,
        mtime: n.mtime,
        size: n.size,
        excerpt: n.excerpt?.trim() ? n.excerpt.trim() : null,
        sourcePath: n.source?.trim() ? n.source.trim() : null,
        syncId: payload.syncId,
      }));
      await tx
        .insert(vaultNotes)
        .values(part)
        .onConflictDoUpdate({
          target: [vaultNotes.root, vaultNotes.path],
          set: {
            machineId: sql`excluded.machine_id`,
            root: sql`excluded.root`,
            title: sql`excluded.title`,
            heading: sql`excluded.heading`,
            folder: sql`excluded.folder`,
            tags: sql`excluded.tags`,
            links: sql`excluded.links`,
            mentions: sql`excluded.mentions`,
            mtime: sql`excluded.mtime`,
            size: sql`excluded.size`,
            excerpt: sql`excluded.excerpt`,
            sourcePath: sql`excluded.source_path`,
            syncId: sql`excluded.sync_id`,
            updatedAt: sql`now()`,
          },
        });
    }
    for (let i = 0; i < payload.deleted.length; i += CHUNK) {
      const gone = await tx
        .delete(vaultNotes)
        .where(and(eq(vaultNotes.root, payload.root), inArray(vaultNotes.path, payload.deleted.slice(i, i + CHUNK))))
        .returning({ path: vaultNotes.path });
      deleted += gone.length;
    }
    if (payload.mode === "full" && payload.done) {
      // Letzter Teil eines Vollabgleichs: alles aus DIESEM Vault dieser Maschine, was der Lauf nicht
      // bestätigt hat, gibt es nicht mehr (andere Vaults/Maschinen bleiben unberührt).
      const gone = await tx
        .delete(vaultNotes)
        .where(and(eq(vaultNotes.root, payload.root), eq(vaultNotes.machineId, machineId), or(isNull(vaultNotes.syncId), ne(vaultNotes.syncId, payload.syncId))))
        .returning({ path: vaultNotes.path });
      deleted += gone.length;
    }
    return { upserted: payload.notes.length, deleted };
  });
}
