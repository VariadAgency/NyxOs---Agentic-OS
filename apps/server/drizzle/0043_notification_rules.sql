-- Notifications: rules of the pipeline (when/style/templates/Nyx) as one JSON column on the existing push settings,
-- plus per notification in the log the decision with reason, Nyx' part and the user's feedback.
-- Purely additive: old rows stay NULL or '{}' (= defaults).
ALTER TABLE "push_settings" ADD COLUMN IF NOT EXISTS "rules" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "push_log" ADD COLUMN IF NOT EXISTS "decision" text;
--> statement-breakpoint
ALTER TABLE "push_log" ADD COLUMN IF NOT EXISTS "decision_note" text;
--> statement-breakpoint
ALTER TABLE "push_log" ADD COLUMN IF NOT EXISTS "nyx" jsonb;
--> statement-breakpoint
ALTER TABLE "push_log" ADD COLUMN IF NOT EXISTS "feedback" text;
--> statement-breakpoint
ALTER TABLE "push_log" ADD COLUMN IF NOT EXISTS "feedback_at" timestamp with time zone;
