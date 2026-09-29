CREATE TABLE "search_docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_key" text NOT NULL,
	"field" text NOT NULL,
	"position" integer,
	"text" text NOT NULL,
	"tsv_german" "tsvector" NOT NULL,
	"tsv_simple" "tsvector" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_docs" ADD CONSTRAINT "search_docs_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_docs_tsv_german_idx" ON "search_docs" USING gin ("tsv_german");--> statement-breakpoint
CREATE INDEX "search_docs_tsv_simple_idx" ON "search_docs" USING gin ("tsv_simple");--> statement-breakpoint
CREATE INDEX "search_docs_session_field_idx" ON "search_docs" USING btree ("session_key","field");--> statement-breakpoint
CREATE INDEX "search_docs_session_field_position_idx" ON "search_docs" USING btree ("session_key","field","position");