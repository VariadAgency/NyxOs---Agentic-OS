CREATE TABLE "archive_digests" (
	"archive_id" integer PRIMARY KEY NOT NULL,
	"session_key" text NOT NULL,
	"agent_id" text,
	"sha256" text NOT NULL,
	"version" integer NOT NULL,
	"digest" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_change_ops" (
	"id" serial PRIMARY KEY NOT NULL,
	"archive_id" integer NOT NULL,
	"session_key" text NOT NULL,
	"agent_id" text,
	"ts" timestamp with time zone,
	"file_path" text NOT NULL,
	"tool" text NOT NULL,
	"added" integer NOT NULL,
	"removed" integer NOT NULL,
	"added_text" text DEFAULT '' NOT NULL,
	"removed_text" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archive_digests" ADD CONSTRAINT "archive_digests_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_digests" ADD CONSTRAINT "archive_digests_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_change_ops" ADD CONSTRAINT "session_change_ops_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_change_ops" ADD CONSTRAINT "session_change_ops_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archive_digests_session_idx" ON "archive_digests" USING btree ("session_key");--> statement-breakpoint
CREATE INDEX "session_change_ops_session_file_idx" ON "session_change_ops" USING btree ("session_key","file_path");--> statement-breakpoint
CREATE INDEX "session_change_ops_archive_idx" ON "session_change_ops" USING btree ("archive_id");