-- Focus button ("auto" / "away" / "dnd"): one row (`id = 1`), additive only (new table). Without the row "auto"
-- applies, so the migration needs no seed values.
CREATE TABLE IF NOT EXISTS "focus_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'auto' NOT NULL,
	"until" timestamp with time zone,
	"since" timestamp with time zone,
	"set_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
