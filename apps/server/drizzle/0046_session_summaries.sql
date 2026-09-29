-- „Nyx fasst zusammen“: ausführliche Session-Zusammenfassungen, je Lauf eine Zeile. Rein additiv (neue
-- Tabelle), nichts Bestehendes wird verändert. Löschen der Session räumt die Zusammenfassungen mit weg.
CREATE TABLE IF NOT EXISTS "session_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_key" text NOT NULL,
	"status" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"error" text,
	"messages_covered" integer DEFAULT 0 NOT NULL,
	"covered_until_item" text,
	"covered_until" timestamp with time zone,
	"items_read" integer,
	"items_total" integer,
	"dropped" integer DEFAULT 0 NOT NULL,
	"call_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_summaries" ADD CONSTRAINT "session_summaries_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_summaries_session_idx" ON "session_summaries" USING btree ("session_key","created_at");
