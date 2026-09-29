CREATE TABLE "docs" (
	"path" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"stage" text DEFAULT 'geplant' NOT NULL,
	"priority" text,
	"baustelle_slug" text,
	"baustelle_label" text,
	"progress_done_weight" integer DEFAULT 0 NOT NULL,
	"progress_total_weight" integer DEFAULT 0 NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"maturity" jsonb,
	"maturity_checked_at" timestamp with time zone,
	"source_type" text,
	"source_id" text,
	"file_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_suggestion" text,
	"estimate" text,
	"worktree_path" text,
	"git_branch" text,
	"tmux_name" text,
	"started_session_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_type" text NOT NULL,
	"from_id" text NOT NULL,
	"to_type" text NOT NULL,
	"to_id" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"title" text NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"done_by_session_key" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_started_session_key_sessions_id_fk" FOREIGN KEY ("started_session_key") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_events" ADD CONSTRAINT "entry_events_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtasks" ADD CONSTRAINT "subtasks_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtasks" ADD CONSTRAINT "subtasks_done_by_session_key_sessions_id_fk" FOREIGN KEY ("done_by_session_key") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entries_source_idx" ON "entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "entries_kind_stage_idx" ON "entries" USING btree ("kind","stage");--> statement-breakpoint
CREATE INDEX "entries_baustelle_idx" ON "entries" USING btree ("baustelle_slug");--> statement-breakpoint
CREATE INDEX "entry_events_entry_ts_idx" ON "entry_events" USING btree ("entry_id","ts");--> statement-breakpoint
CREATE INDEX "links_from_idx" ON "links" USING btree ("from_type","from_id");--> statement-breakpoint
CREATE INDEX "links_to_idx" ON "links" USING btree ("to_type","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "links_unique_idx" ON "links" USING btree ("from_type","from_id","to_type","to_id","relation");--> statement-breakpoint
CREATE INDEX "subtasks_entry_idx" ON "subtasks" USING btree ("entry_id");