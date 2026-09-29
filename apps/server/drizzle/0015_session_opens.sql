CREATE TABLE "session_opens" (
	"session_key" text PRIMARY KEY NOT NULL,
	"last_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"open_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_opens" ADD CONSTRAINT "session_opens_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_opens_last_idx" ON "session_opens" USING btree ("last_opened_at");