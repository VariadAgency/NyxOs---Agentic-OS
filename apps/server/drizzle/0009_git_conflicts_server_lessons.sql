CREATE TABLE "conflict_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"folder" text NOT NULL,
	"path" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deploys" (
	"id" serial PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"container_name" text NOT NULL,
	"image_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"git_rev" text,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"name" text NOT NULL,
	"ahead" integer DEFAULT 0 NOT NULL,
	"behind" integer DEFAULT 0 NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"last_commit_at" timestamp with time zone,
	"upstream" text
);
--> statement-breakpoint
CREATE TABLE "git_catchup_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"worktree_path" text NOT NULL,
	"branch" text NOT NULL,
	"outcome" text NOT NULL,
	"main_sha_before" text NOT NULL,
	"main_sha_after" text,
	"detail" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_commits" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"sha" text NOT NULL,
	"author_date" timestamp with time zone NOT NULL,
	"subject" text NOT NULL,
	"branch" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_probe_merges" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"branch" text NOT NULL,
	"status" text NOT NULL,
	"conflict_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checksum_before" text NOT NULL,
	"checksum_after" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_repos" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"root" text NOT NULL,
	"current_branch" text,
	"head_sha" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_uncommitted" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"path" text NOT NULL,
	"status_code" text NOT NULL,
	"group" text NOT NULL,
	"from_path" text
);
--> statement-breakpoint
CREATE TABLE "git_worktrees" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"path" text NOT NULL,
	"branch" text,
	"head_sha" text,
	"locked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"path_glob" text NOT NULL,
	"label" text NOT NULL,
	"session_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"condition" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"origin" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_hit_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "git_branches" ADD CONSTRAINT "git_branches_repo_id_git_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."git_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_catchup_history" ADD CONSTRAINT "git_catchup_history_repo_id_git_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."git_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commits" ADD CONSTRAINT "git_commits_repo_id_git_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."git_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_probe_merges" ADD CONSTRAINT "git_probe_merges_repo_id_git_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."git_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_uncommitted" ADD CONSTRAINT "git_uncommitted_repo_id_git_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."git_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_worktrees" ADD CONSTRAINT "git_worktrees_repo_id_git_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."git_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conflict_events_folder_detected_idx" ON "conflict_events" USING btree ("folder","detected_at");--> statement-breakpoint
CREATE INDEX "deploys_project_created_idx" ON "deploys" USING btree ("project","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_branches_repo_name_idx" ON "git_branches" USING btree ("repo_id","name");--> statement-breakpoint
CREATE INDEX "git_catchup_history_repo_idx" ON "git_catchup_history" USING btree ("repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_commits_repo_sha_idx" ON "git_commits" USING btree ("repo_id","sha");--> statement-breakpoint
CREATE INDEX "git_commits_author_date_idx" ON "git_commits" USING btree ("author_date");--> statement-breakpoint
CREATE UNIQUE INDEX "git_probe_merges_repo_branch_idx" ON "git_probe_merges" USING btree ("repo_id","branch");--> statement-breakpoint
CREATE UNIQUE INDEX "git_uncommitted_repo_path_idx" ON "git_uncommitted" USING btree ("repo_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "git_worktrees_path_idx" ON "git_worktrees" USING btree ("path");--> statement-breakpoint
CREATE INDEX "reservations_path_glob_idx" ON "reservations" USING btree ("path_glob");