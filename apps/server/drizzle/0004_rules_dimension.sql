ALTER TABLE "sort_rules" ALTER COLUMN "target_art" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "category_manual_art" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "category_manual_baustelle" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sort_rules" ADD COLUMN "dimension" text DEFAULT 'baustelle' NOT NULL;