ALTER TABLE "sessions" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "turn_open" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "turn_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "session_end_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "closed_by" text;--> statement-breakpoint
CREATE INDEX "sessions_state_idx" ON "sessions" USING btree ("state");