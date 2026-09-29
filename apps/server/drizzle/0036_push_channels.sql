ALTER TABLE "push_settings" ADD COLUMN "channels" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "push_settings" ADD COLUMN "ntfy_target" text DEFAULT 'own' NOT NULL;