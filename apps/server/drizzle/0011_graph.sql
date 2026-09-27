CREATE TABLE "vault_notes" (
	"path" text NOT NULL,
	"machine_id" text,
	"root" text NOT NULL,
	"title" text NOT NULL,
	"heading" text,
	"folder" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mtime" timestamp with time zone,
	"size" integer DEFAULT 0 NOT NULL,
	"sync_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_notes_root_path_pk" PRIMARY KEY("root","path")
);
--> statement-breakpoint
ALTER TABLE "vault_notes" ADD CONSTRAINT "vault_notes_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_notes_sync_idx" ON "vault_notes" USING btree ("sync_id");