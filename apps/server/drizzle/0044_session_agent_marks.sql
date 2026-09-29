-- Agents in the session chat: the user can hide agents from earlier runs in the archive. Purely additive (new table
-- + partial index), nothing existing is changed. Deleting the session removes its marks too.
CREATE TABLE IF NOT EXISTS "session_agent_marks" (
	"session_key" text NOT NULL,
	"agent_id" text NOT NULL,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_agent_marks_session_key_agent_id_pk" PRIMARY KEY("session_key","agent_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_agent_marks" ADD CONSTRAINT "session_agent_marks_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Partial index over sub-agent events only (per session and agent): the agents bar asks on every live signal.
-- Server mode with a large table: better create it by hand first with CREATE INDEX CONCURRENTLY (this line is then a no-op).
CREATE INDEX IF NOT EXISTS "session_events_agent_idx" ON "session_events" USING btree ("session_key",("data"->>'agentId'),"ts") WHERE "session_events"."data" ? 'agentId';
