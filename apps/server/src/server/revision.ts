// Revision der laufenden API: beim Bau ins Abbild geschrieben (`/app/meta/REVISION`), in Tests und
// lokal über `NYXOS_REVISION` bzw. `NYXOS_REVISION_FILE` überschreibbar.
import { readFile } from "node:fs/promises";

export const DEFAULT_REVISION_FILE = "/app/meta/REVISION";

/** Revision der laufenden API: `NYXOS_REVISION` (Tests/Probe) > Datei im Abbild. */
export async function readRunningRevision(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.NYXOS_REVISION?.trim()) return env.NYXOS_REVISION.trim();
  try {
    const rev = (await readFile(env.NYXOS_REVISION_FILE ?? DEFAULT_REVISION_FILE, "utf8")).trim();
    return /^[0-9a-f]{7,40}$/.test(rev) ? rev : null;
  } catch {
    return null;
  }
}
