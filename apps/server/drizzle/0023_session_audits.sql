CREATE TABLE "session_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_key" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" text,
	"items_read" integer,
	"items_total" integer,
	"call_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_audits" ADD CONSTRAINT "session_audits_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_audits_session_idx" ON "session_audits" USING btree ("session_key","created_at");