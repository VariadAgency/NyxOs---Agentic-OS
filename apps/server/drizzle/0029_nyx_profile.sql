CREATE TABLE "nyx_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sliders" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nyx_profile" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"user_profile" jsonb NOT NULL,
	"personality" jsonb NOT NULL,
	"sliders" jsonb NOT NULL,
	"active_preset" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "nyx_presets_label_idx" ON "nyx_presets" USING btree (lower("label"));
