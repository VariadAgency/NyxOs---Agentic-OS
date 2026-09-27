CREATE TABLE "nyx_media" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"file" text,
	"mime" text,
	"bytes" integer,
	"source" text DEFAULT 'nyx' NOT NULL,
	"thread_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nyx_memory" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"fact" text NOT NULL,
	"source_thread_id" integer,
	"source_message_id" integer,
	"created_by" text DEFAULT 'nyx' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nyx_memory_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"fact" text NOT NULL,
	"memory_id" integer,
	"reason" text,
	"source_thread_id" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "nyx_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"mode" text DEFAULT 'remind' NOT NULL,
	"kind" text NOT NULL,
	"run_at" timestamp with time zone,
	"cron" text,
	"event" text,
	"event_filter" text,
	"event_cursor" jsonb,
	"precheck" text,
	"active_start" text,
	"active_end" text,
	"deliver" text DEFAULT 'web' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_output" text,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_by" text DEFAULT 'nyx' NOT NULL,
	"source_thread_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nyx_todos" (
	"thread_id" integer PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "haiku_messages" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "haiku_messages" ADD COLUMN "speak" text;--> statement-breakpoint
ALTER TABLE "haiku_threads" ADD COLUMN "memory_snapshot" text;--> statement-breakpoint
ALTER TABLE "haiku_threads" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "haiku_threads" ADD COLUMN "summary_upto_id" integer;--> statement-breakpoint
ALTER TABLE "haiku_threads" ADD COLUMN "turns_since_memory" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nyx_media" ADD CONSTRAINT "nyx_media_thread_id_haiku_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."haiku_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nyx_memory" ADD CONSTRAINT "nyx_memory_source_thread_id_haiku_threads_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "public"."haiku_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nyx_memory_suggestions" ADD CONSTRAINT "nyx_memory_suggestions_memory_id_nyx_memory_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."nyx_memory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nyx_memory_suggestions" ADD CONSTRAINT "nyx_memory_suggestions_source_thread_id_haiku_threads_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "public"."haiku_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nyx_schedules" ADD CONSTRAINT "nyx_schedules_source_thread_id_haiku_threads_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "public"."haiku_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nyx_todos" ADD CONSTRAINT "nyx_todos_thread_id_haiku_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."haiku_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nyx_media_created_idx" ON "nyx_media" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "nyx_memory_category_idx" ON "nyx_memory" USING btree ("category","id");--> statement-breakpoint
CREATE INDEX "nyx_memory_suggestions_status_idx" ON "nyx_memory_suggestions" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "nyx_schedules_due_idx" ON "nyx_schedules" USING btree ("paused","next_run_at");--> statement-breakpoint
CREATE INDEX "haiku_messages_fts_idx" ON "haiku_messages" USING gin (to_tsvector('german', "text"));
