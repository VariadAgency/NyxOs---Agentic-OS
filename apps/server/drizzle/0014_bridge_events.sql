CREATE TABLE "bridge_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"machine_id" text,
	"at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE INDEX "bridge_events_at_idx" ON "bridge_events" USING btree ("at");