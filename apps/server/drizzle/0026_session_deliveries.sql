CREATE TABLE "session_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_key" text NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dedupe_key" text,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_deliveries" ADD CONSTRAINT "session_deliveries_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_deliveries_session_idx" ON "session_deliveries" USING btree ("session_key","status","id");--> statement-breakpoint
CREATE INDEX "session_deliveries_status_idx" ON "session_deliveries" USING btree ("status","expires_at");