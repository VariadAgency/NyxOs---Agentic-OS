CREATE TABLE "conflict_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"decision_key" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_dismissals_decision_key_unique" UNIQUE("decision_key")
);
