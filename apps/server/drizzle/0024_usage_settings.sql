CREATE TABLE "usage_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"default_range" text DEFAULT '30' NOT NULL,
	"goal_scope" text DEFAULT 'all' NOT NULL,
	"goal_month_tokens" bigint,
	"goal_week_tokens" bigint,
	"warn_window_pct" integer,
	"warn_daily_tokens" bigint,
	"warn_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
