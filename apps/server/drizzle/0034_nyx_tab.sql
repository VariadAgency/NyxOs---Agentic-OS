CREATE TABLE "nyx_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"stored_path" text NOT NULL,
	"thread_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "haiku_messages" ADD COLUMN "interrupted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "nyx_files_kind_idx" ON "nyx_files" USING btree ("kind","id");
