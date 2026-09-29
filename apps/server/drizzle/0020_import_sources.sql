CREATE TABLE "import_files" (
	"path" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"machine_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_status" (
	"source" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"message" text,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "source_removed_at" timestamp with time zone;