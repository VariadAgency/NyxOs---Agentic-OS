CREATE TABLE "agent_catalog" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"path" text NOT NULL,
	"source" text NOT NULL,
	"machine_id" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"input_per_token" double precision NOT NULL,
	"output_per_token" double precision NOT NULL,
	"cache_read_per_token" double precision NOT NULL,
	"cache_creation_5m_per_token" double precision NOT NULL,
	"cache_creation_1h_per_token" double precision,
	"context_window" integer,
	"valid_from" text NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"tool" text NOT NULL,
	"model" text,
	"project" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_5m_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_1h_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"cost" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"tool" text NOT NULL,
	"model" text,
	"project" text NOT NULL,
	"session_key" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_5m_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_1h_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"cost" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_usage" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_usage_model" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "model_context_window" integer;--> statement-breakpoint
ALTER TABLE "agent_catalog" ADD CONSTRAINT "agent_catalog_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_catalog_kind_path_idx" ON "agent_catalog" USING btree ("kind","path");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_model_valid_from_idx" ON "prices" USING btree ("model","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_daily_day_tool_model_project_idx" ON "usage_daily" USING btree ("day","tool","model","project");--> statement-breakpoint
CREATE INDEX "usage_daily_day_idx" ON "usage_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "usage_events_ts_idx" ON "usage_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "usage_events_tool_ts_idx" ON "usage_events" USING btree ("tool","ts");--> statement-breakpoint
CREATE INDEX "usage_events_project_ts_idx" ON "usage_events" USING btree ("project","ts");--> statement-breakpoint
CREATE INDEX "usage_events_session_idx" ON "usage_events" USING btree ("session_key");