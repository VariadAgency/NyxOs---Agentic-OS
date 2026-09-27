CREATE TABLE "sort_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"condition" jsonb NOT NULL,
	"target_art" text NOT NULL,
	"target_baustelle_slug" text,
	"target_baustelle_label" text,
	"origin" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "category_art" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "category_baustelle_slug" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "category_baustelle_label" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "category_reason" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "category_rule_id" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "category_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_category_rule_id_sort_rules_id_fk" FOREIGN KEY ("category_rule_id") REFERENCES "public"."sort_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_category_art_idx" ON "sessions" USING btree ("category_art");