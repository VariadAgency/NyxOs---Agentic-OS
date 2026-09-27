CREATE TABLE "git_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"worktree_path" text NOT NULL,
	"ref" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"new_sha" text,
	"identity" text
);
--> statement-breakpoint
ALTER TABLE "git_branches" ADD COLUMN "ahead_shas" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "author_name" text;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "parent_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "files" jsonb;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "files_changed" integer;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "insertions" integer;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "deletions" integer;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "session_key" text;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "session_confidence" text;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "session_reason" text;--> statement-breakpoint
ALTER TABLE "git_commits" ADD COLUMN "attributed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_repos" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "git_repos" ADD COLUMN "main_branch" text;--> statement-breakpoint
ALTER TABLE "git_repos" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_actions" ADD CONSTRAINT "git_actions_repo_id_git_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."git_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_actions_at_idx" ON "git_actions" USING btree ("at");--> statement-breakpoint
CREATE INDEX "git_commits_committed_at_idx" ON "git_commits" USING btree ("committed_at");--> statement-breakpoint
CREATE INDEX "session_events_tool_call_ts_idx" ON "session_events" USING btree ("ts") WHERE "session_events"."kind" = 'tool_call';