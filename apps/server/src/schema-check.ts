// `/health` prüfte bisher nur, ob die DB erreichbar ist — nicht, ob das
// Schema zum ausgelieferten Code passt. Migrationen laufen von Hand per `psql` (
// "Deploy P2"), NICHT über den Drizzle-Migrator (der eine eigene Protokoll-Tabelle führen würde) —
// eine vergessene Migration fällt sonst erst auf, wenn ein Endpunkt, der die neue Spalte anfasst,
// mit 500 abstürzt (eine von Hand gepflegte Liste lag hier schon einmal falsch,
// obwohl `0004_rules_dimension.sql` längst existierte). Diese Datei embedded die Migrationsliste aus
// `drizzle/meta/_journal.json` ZUR BUILD-ZEIT (JSON-Import, von esbuild mit in `dist/main.js`
// gebündelt) und prüft je Migration eine robuste Leit-Spalte/-Tabelle über `information_schema` —
// unabhängig davon, ob `apps/server/drizzle/` zur Laufzeit überhaupt neben `dist/` liegt.
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import journal from "../drizzle/meta/_journal.json" with { type: "json" };

interface JournalEntry {
  tag: string;
}

/**
 * Je Migration (ab `0001` — `0000_init` legt die Basistabellen selbst an; dass sie existieren, prüft
 * der normale DB-Check in `health.ts` schon über `sessions`) eine Spalte/Tabelle, die GENAU diese
 * Migration neu einführt (s. jeweilige `apps/server/drizzle/000X_*.sql`).
 *
 * **Pflicht bei jeder neuen additiven Migration:** hier einen Eintrag ergänzen (Tag exakt wie in
 * `drizzle/meta/_journal.json`) — sonst bleibt `/health` blind für eine fehlende Migration. Siehe
 * Abschnitt „Deploy P2".
 */
export const MIGRATION_SENTINELS: Record<string, { table: string; column: string }> = {
  "0001_session_state": { table: "sessions", column: "state" },
  "0002_sort_rules": { table: "sessions", column: "category_art" },
  "0003_search": { table: "search_docs", column: "id" },
  "0004_rules_dimension": { table: "sessions", column: "category_manual_art" },
  "0005_category_undo": { table: "sessions", column: "category_undo" },
  "0006_push_builds_night": { table: "push_settings", column: "topic" },
  "0007_terminal": { table: "sessions", column: "attachable" },
  "0008_entries": { table: "entries", column: "id" },
  "0009_git_conflicts_server_lessons": { table: "git_repos", column: "id" },
  "0010_usage_agents": { table: "agent_catalog", column: "id" },
  "0011_graph": { table: "vault_notes", column: "path" },
  "0012_assistant": { table: "idea_link_hits", column: "kind" },
  "0013_context_guard": { table: "context_guard_state", column: "session_key" },
  // Verlauf der Brücken-Verbindung.
  "0014_bridge_events": { table: "bridge_events", column: "state" },
  // „Zuletzt geöffnet“.
  "0015_session_opens": { table: "session_opens", column: "last_opened_at" },
  // „Ignorieren/Erledigt“ je Konflikt-Entscheidung.
  "0016_conflict_dismissals": { table: "conflict_dismissals", column: "decision_key" },
  // Altersgrenze „abgestürzt“ (Einstellung) + Ordner je Build-Lauf.
  "0017_overview": { table: "build_runs", column: "folder" },
  // Notiz-Anfang für die Info-Karte.
  "0018_note_excerpt": { table: "vault_notes", column: "excerpt" },
  // Session-Seitenpanels.
  "0019_session_digests": { table: "session_change_ops", column: "added_text" },
  // Import-Quellen: letzte Anweisung der Migration.
  "0020_import_sources": { table: "entries", column: "source_removed_at" },
  // Git: Aktions-Log + Commit→Session.
  "0021_git_details": { table: "git_actions", column: "action" },
  // Wegwerf-Chats: temporäre Sessions + Archiv.
  "0022_temporary": { table: "sessions", column: "archived_at" },
  // „Session zusammenfassen & prüfen“.
  "0023_session_audits": { table: "session_audits", column: "items_read" },
  // Nutzung: Ziele/Warnschwellen.
  "0024_usage_settings": { table: "usage_settings", column: "warn_state" },
  // Quelldatei je Code-Notiz → Bibliothek im Gehirn.
  "0025_note_source": { table: "vault_notes", column: "source_path" },
  // Zustell-Warteschlange „sobald die Session wartet“.
  "0026_session_deliveries": { table: "session_deliveries", column: "dedupe_key" },
  // Menü „⋯“ an Nyx-Fäden: Archiv + Karten im Faden.
  "0027_thread_archive": { table: "haiku_threads", column: "archived_at" },
  // Modelle, Geheimnisse, Konnektoren.
  "0028_models_secrets": { table: "mcp_connectors", column: "allowed_tools" },
  "0029_nyx_profile": { table: "nyx_profile", column: "sliders" },
  // Nyx-Kern.
  "0030_nyx_core": { table: "haiku_threads", column: "turns_since_memory" },
  // Telegram: Kopplung, Ziel, Einstellungen.
  "0031_telegram": { table: "telegram_state", column: "commands_hash" },
  // Skill-Bibliothek.
  "0032_skills": { table: "skills", column: "missing_since" },
  // Agenten-Kacheln: Modell/Werkzeuge/Prompt je Agent-Datei.
  "0033_agent_details": { table: "agent_catalog", column: "details" },
  "0034_nyx_tab": { table: "nyx_files", column: "stored_path" },
  "0035_skill_backfill": { table: "skill_scan_state", column: "backfill_version" },
  "0036_push_channels": { table: "push_settings", column: "ntfy_target" },
  "0037_nyx_voice_settings": { table: "nyx_voice_settings", column: "lexicon" },
  "0038_away_settings": { table: "away_settings", column: "settings" },
  "0039_push_log_channels": { table: "push_log", column: "channels" },
  "0040_nyx_app_api": { table: "nyx_api_calls", column: "pending_body" },
  // App-Einstellungen (Sprache, Name, Onboarding, automatische Updates).
  "0041_app_settings": { table: "app_settings", column: "user_name" },
  // Feedback & Unterstützen: Postausgang + Adresse der Meldestelle.
  "0042_support": { table: "support_outbox", column: "client_id" },
  // Notifications: rules of the pipeline + decision/feedback per notification.
  "0043_notification_rules": { table: "push_log", column: "feedback_at" },
  // Agents in the session chat: agents hidden in the archive.
  "0044_session_agent_marks": { table: "session_agent_marks", column: "hidden_at" },
  // Betrieb & Zugriff: chosen way, form values, checks, last outside access.
  "0045_hosting_profile": { table: "hosting_profile", column: "remote_seen" },
  // „Nyx fasst zusammen“ – Session-Zusammenfassungen.
  "0046_session_summaries": { table: "session_summaries", column: "messages_covered" },
  // Focus button (auto / away / do not disturb).
  "0048_focus_state": { table: "focus_state", column: "set_by" },
};

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: unknown[] }).rows;
  return [];
}

export interface SchemaCheckResult {
  ok: boolean;
  /** Migrations-Tags, deren Leit-Spalte/-Tabelle fehlt (fehlende Migration oder falscher DB-Stand). */
  missing: string[];
}

/** Prüft für jede Migration aus dem eingebetteten Journal, ob ihre Leit-Spalte existiert. */
export async function checkMigrationsApplied(db: Db): Promise<SchemaCheckResult> {
  const missing: string[] = [];
  for (const entry of journal.entries as JournalEntry[]) {
    const sentinel = MIGRATION_SENTINELS[entry.tag];
    if (!sentinel) continue; // 0000_init: keine Leit-Spalte nötig
    const result = await db.execute(
      sql`select 1 from information_schema.columns where table_name = ${sentinel.table} and column_name = ${sentinel.column} limit 1`,
    );
    if (rowsOf(result).length === 0) missing.push(entry.tag);
  }
  return { ok: missing.length === 0, missing };
}
