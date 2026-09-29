CREATE TABLE IF NOT EXISTS "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"lang" text DEFAULT 'de' NOT NULL,
	"user_name" text DEFAULT '' NOT NULL,
	"onboarding_done" boolean DEFAULT false NOT NULL,
	"auto_update" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
