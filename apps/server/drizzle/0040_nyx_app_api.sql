-- Nyx bedient NyxOS über die eigene API (Werkzeug app_api): Protokoll jedes Aufrufs und riskante Aufrufe, die auf
-- des Nutzers „Ausführen“ warten. Rein additiv (neue Tabelle), nichts Bestehendes wird verändert.
CREATE TABLE IF NOT EXISTS "nyx_api_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel" text,
	"call_kind" text,
	"thread_id" integer,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"query" jsonb,
	"body_redacted" text,
	"outcome" text NOT NULL,
	"reason" text,
	"label" text,
	"status" integer,
	"pending_body" jsonb,
	"inbox_item_id" integer,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"result_excerpt" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nyx_api_calls" ADD CONSTRAINT "nyx_api_calls_thread_id_haiku_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."haiku_threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nyx_api_calls" ADD CONSTRAINT "nyx_api_calls_inbox_item_id_inbox_items_id_fk" FOREIGN KEY ("inbox_item_id") REFERENCES "public"."inbox_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nyx_api_calls_created_idx" ON "nyx_api_calls" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nyx_api_calls_inbox_idx" ON "nyx_api_calls" USING btree ("inbox_item_id");
