-- „Feedback & Unterstützen“ (nur Open-Source-Fassung): Postausgang für Fehlermeldungen/Ideen und die Adresse der
-- Meldestelle aus den Einstellungen. Rein additiv (nur neue Tabellen).
CREATE TABLE IF NOT EXISTS "support_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"client_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_outbox_status_idx" ON "support_outbox" USING btree ("status","next_attempt_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
