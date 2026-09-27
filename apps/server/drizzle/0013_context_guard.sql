CREATE TABLE "context_guard_defaults" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"default_hinweis_pct" integer DEFAULT 60 NOT NULL,
	"default_erzwingen_enabled" boolean DEFAULT true NOT NULL,
	"default_erzwingen_pct" integer DEFAULT 80,
	"haiku_hinweis_pct" integer DEFAULT 60 NOT NULL,
	"haiku_erzwingen_enabled" boolean DEFAULT true NOT NULL,
	"haiku_erzwingen_pct" integer DEFAULT 80,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_guard_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_key" text NOT NULL,
	"kind" text NOT NULL,
	"pct_at_trigger" integer,
	"action" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_guard_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"model" text,
	"session_key" text,
	"hinweis_pct" integer NOT NULL,
	"erzwingen_enabled" boolean DEFAULT true NOT NULL,
	"erzwingen_pct" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_guard_state" (
	"session_key" text PRIMARY KEY NOT NULL,
	"last_pct" integer,
	"hinweis_notified_at" timestamp with time zone,
	"erzwingen_attempted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_guard_events" ADD CONSTRAINT "context_guard_events_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_guard_overrides" ADD CONSTRAINT "context_guard_overrides_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_guard_state" ADD CONSTRAINT "context_guard_state_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_guard_events_session_idx" ON "context_guard_events" USING btree ("session_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cgo_model_idx" ON "context_guard_overrides" USING btree ("model");--> statement-breakpoint
CREATE UNIQUE INDEX "cgo_session_idx" ON "context_guard_overrides" USING btree ("session_key");