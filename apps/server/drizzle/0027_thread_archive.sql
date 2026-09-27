ALTER TABLE "haiku_messages" ADD COLUMN "note_kind" text;--> statement-breakpoint
ALTER TABLE "haiku_threads" ADD COLUMN "archived_at" timestamp with time zone;