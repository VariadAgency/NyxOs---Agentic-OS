CREATE TABLE "approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rule" text NOT NULL,
	"reason" text NOT NULL,
	"tool" text NOT NULL,
	"command" text NOT NULL,
	"command_hash" text NOT NULL,
	"cwd" text,
	"session_key" text,
	"auftrag" text,
	"worktree" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "haiku_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"engine" text NOT NULL,
	"model" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"thread_id" integer,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "haiku_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimate" boolean DEFAULT false NOT NULL,
	"context" jsonb,
	"call_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "haiku_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"fingerprint" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "haiku_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"day" text NOT NULL,
	"content" jsonb NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"call_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "haiku_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"engine" text DEFAULT 'claude-cli' NOT NULL,
	"daily_budget_usd" double precision DEFAULT 0.5 NOT NULL,
	"briefing_time" text DEFAULT '07:00' NOT NULL,
	"recap_time" text DEFAULT '21:30' NOT NULL,
	"rundgang_minutes" integer DEFAULT 15 NOT NULL,
	"timeout_seconds" integer DEFAULT 90 NOT NULL,
	"idealink_budget_percent" integer DEFAULT 20 NOT NULL,
	"idealink_ideas_per_link_day" integer DEFAULT 10 NOT NULL,
	"idealink_ideas_per_day" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "haiku_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text DEFAULT 'full' NOT NULL,
	"topic" text NOT NULL,
	"day" text NOT NULL,
	"title" text NOT NULL,
	"claude_session_id" text,
	"idea_link_id" integer,
	"conversation_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_link_hits" (
	"id" serial PRIMARY KEY NOT NULL,
	"link_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text DEFAULT 'chat' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"rate_per_hour" integer DEFAULT 10 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"ideas_created" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "idea_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" jsonb,
	"session_key" text,
	"entry_id" integer,
	"baustelle" text,
	"decision_file" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text DEFAULT 'haiku' NOT NULL,
	"estimate_minutes" integer DEFAULT 2 NOT NULL,
	"yes_no" boolean DEFAULT false NOT NULL,
	"escalation" text,
	"delivery" jsonb,
	"fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "haiku_messages" ADD CONSTRAINT "haiku_messages_thread_id_haiku_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."haiku_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_link_hits" ADD CONSTRAINT "idea_link_hits_link_id_idea_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."idea_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "approvals_hash_idx" ON "approvals" USING btree ("command_hash","session_key");--> statement-breakpoint
CREATE INDEX "haiku_calls_created_idx" ON "haiku_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "haiku_calls_kind_idx" ON "haiku_calls" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "haiku_messages_thread_idx" ON "haiku_messages" USING btree ("thread_id","id");--> statement-breakpoint
CREATE INDEX "haiku_notes_kind_idx" ON "haiku_notes" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "haiku_notes_fp_idx" ON "haiku_notes" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "haiku_reports_kind_day_idx" ON "haiku_reports" USING btree ("kind","day","created_at");--> statement-breakpoint
CREATE INDEX "haiku_threads_scope_idx" ON "haiku_threads" USING btree ("scope","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "haiku_threads_link_conv_idx" ON "haiku_threads" USING btree ("idea_link_id","conversation_key");--> statement-breakpoint
CREATE INDEX "idea_link_hits_link_at_idx" ON "idea_link_hits" USING btree ("link_id","at");--> statement-breakpoint
CREATE INDEX "inbox_items_status_idx" ON "inbox_items" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "inbox_items_fp_idx" ON "inbox_items" USING btree ("fingerprint");