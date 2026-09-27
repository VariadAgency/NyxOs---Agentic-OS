// Einrichtung (Onboarding): Vertrag zwischen Web-Assistent, Server (`GET/POST /api/setup`) und Brücke
// (RPC `setup.state` / `setup.apply`). Die Brücke kennt den Rechner (Ordner, Hooks, Shell, Werkzeuge), der
// Server reicht nur durch und antwortet ohne Brücke mit einem leeren Stand (`bridgeOnline: false`).
import { z } from "zod";

/** Fähigkeit im `hello` der Brücke — ältere Brücken kennen die Einrichtungs-Befehle nicht. */
export const BRIDGE_CAP_SETUP = "setup";
export const SETUP_RPC_STATE = "setup.state";
export const SETUP_RPC_APPLY = "setup.apply";
/** Fähigkeit + RPC der Ordner-Auswahl (Ordner auflisten). Ältere Brücken haben sie nicht. */
export const BRIDGE_CAP_SETUP_BROWSE = "setup_browse";
export const SETUP_RPC_BROWSE = "setup.browse";

export const SetupOsSchema = z.enum(["darwin", "linux", "other"]);
export type SetupOs = z.infer<typeof SetupOsSchema>;

/** Paketverwaltung des Rechners (für den passenden Installationsbefehl, z. B. von tmux). */
export const SetupPackageManagerSchema = z.enum(["brew", "port", "apt", "dnf", "yum", "pacman", "zypper", "apk", "none"]);
export type SetupPackageManager = z.infer<typeof SetupPackageManagerSchema>;

/** Angaben zu einem vorgeschlagenen oder eingetragenen Projektordner. */
export const ProjectRootInfoSchema = z.object({
  path: z.string(),
  /** Git-Repos im Ordner (er selbst oder bis zwei Ebenen darunter), `null` = nicht gezählt. */
  repos: z.number().int().nonnegative().nullable(),
  /** Claude-/Codex-Sessions, die zuletzt in diesem Ordner liefen (aus den Verläufen gezählt). */
  sessions: z.number().int().nonnegative(),
  /** Letzte Session dort (ISO), `null` = keine bekannt. */
  lastUsedAt: z.string().nullable(),
  /** Mit welchen Werkzeugen dort gearbeitet wurde. */
  tools: z.array(z.enum(["claude", "codex"])),
  /** Empfohlen: dort wurde wirklich gearbeitet (Sessions gefunden). */
  recommended: z.boolean(),
});
export type ProjectRootInfo = z.infer<typeof ProjectRootInfoSchema>;

export const SetupStateSchema = z.object({
  bridgeOnline: z.boolean(),
  os: SetupOsSchema,
  /** Home-Ordner des Rechners (neuere Brücken) — für die Anzeige als „~/…“. */
  home: z.string().optional(),
  /** Projektordner, deren Sessions NyxOS erfasst. Leer = alle Sessions. */
  projectRoots: z.array(z.string()),
  /** Obsidian-Vault (nur lesend eingelesen), `null` = keiner. */
  vaultDir: z.string().nullable(),
  vaultExists: z.boolean(),
  /** Stehen die NyxOS-Hooks in `~/.claude/settings.json` bzw. `~/.codex/hooks.json`? */
  hooks: z.object({ claude: z.boolean(), codex: z.boolean() }),
  /** Startet `claude`/`codex` in der Shell automatisch in tmux (Block in `~/.zshrc`/`~/.bashrc`)? */
  shellIntegration: z.boolean(),
  /** Gefundene Programme; `node` = Version des node, mit dem die Brücke läuft. */
  tools: z.object({
    tmux: z.boolean(),
    git: z.boolean(),
    claude: z.boolean(),
    codex: z.boolean(),
    node: z.string().nullable(),
    /** Paketverwaltung (neuere Brücken). */
    packageManager: SetupPackageManagerSchema.optional(),
    /** Läuft die Brücke als root (dann ohne `sudo`)? */
    root: z.boolean().optional(),
  }),
  /**
   * Vorschläge: Projektordner (zuerst die, in denen zuletzt Sessions liefen, dann Ordner mit Git-Repos) und Ordner
   * mit `.obsidian`. `projectRoots` ohne die schon eingetragenen; `projectRootDetails` (neuere Brücken) beschreibt
   * die Vorschläge UND die eingetragenen Ordner.
   */
  suggestions: z.object({
    projectRoots: z.array(z.string()),
    vaults: z.array(z.string()),
    projectRootDetails: z.array(ProjectRootInfoSchema).optional(),
    /** `false`: die Suche wartet noch (z. B. auf die macOS-Freigabe für Dokumente) — gleich noch einmal fragen. */
    complete: z.boolean().optional(),
  }),
});
export type SetupState = z.infer<typeof SetupStateSchema>;

const PathSchema = z.string().trim().min(1).max(4096);

export const SetupApplySchema = z
  .object({
    /** Ersetzt die Liste der Projektordner (jeder muss existieren). */
    projectRoots: z.array(PathSchema).max(50).optional(),
    /** Vault setzen (`null` = keinen). Ohne `createVault` muss der Ordner existieren. */
    vaultDir: PathSchema.nullable().optional(),
    /** Vault-Ordner neu anlegen (mit `.obsidian/` und einer Willkommens-Notiz). */
    createVault: z.boolean().optional(),
    /** Hooks in Claude/Codex eintragen (`true`) oder entfernen (`false`). */
    installHooks: z.boolean().optional(),
    /** Shell-Anbindung ein- (`true`) oder ausschalten (`false`). */
    shellIntegration: z.boolean().optional(),
  })
  .strict();
export type SetupApply = z.infer<typeof SetupApplySchema>;

/** Ordner-Auswahl: Inhalt eines Ordners (nur Unterordner). Ohne `path`: das Home-Verzeichnis. */
export const SetupBrowseRequestSchema = z.object({ path: PathSchema.optional() }).strict();
export type SetupBrowseRequest = z.infer<typeof SetupBrowseRequestSchema>;

export const SetupBrowseEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  /** Der Ordner ist selbst ein Git-Repo. */
  isRepo: z.boolean(),
  /** Git-Repos direkt darin (nur gezählt, wenn billig), sonst fehlt das Feld. */
  repoCount: z.number().int().nonnegative().optional(),
});
export type SetupBrowseEntry = z.infer<typeof SetupBrowseEntrySchema>;

export const SetupBrowseResultSchema = z.object({
  /** Echter Pfad des angezeigten Ordners. */
  path: z.string(),
  /** Übergeordneter Ordner, `null` an der Wurzel. */
  parent: z.string().nullable(),
  home: z.string(),
  /** Der angezeigte Ordner ist selbst ein Git-Repo. */
  isRepo: z.boolean(),
  entries: z.array(SetupBrowseEntrySchema),
  /** Mehr Unterordner, als angezeigt werden. */
  truncated: z.boolean(),
});
export type SetupBrowseResult = z.infer<typeof SetupBrowseResultSchema>;

/** Stand ohne verbundene Brücke. */
export function emptySetupState(os: SetupOs = "other"): SetupState {
  return {
    bridgeOnline: false,
    os,
    projectRoots: [],
    vaultDir: null,
    vaultExists: false,
    hooks: { claude: false, codex: false },
    shellIntegration: false,
    tools: { tmux: false, git: false, claude: false, codex: false, node: null },
    suggestions: { projectRoots: [], vaults: [] },
  };
}

export function setupOsOf(platform: string): SetupOs {
  return platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "other";
}
