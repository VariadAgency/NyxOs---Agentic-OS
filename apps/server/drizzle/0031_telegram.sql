CREATE TABLE "telegram_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"chat_id" text,
	"chat_name" text,
	"paired_at" timestamp with time zone,
	"pair_hash" text,
	"pair_salt" text,
	"pair_expires_at" timestamp with time zone,
	"pair_failures" integer DEFAULT 0 NOT NULL,
	"pair_locked_until" timestamp with time zone,
	"target" text DEFAULT 'nyx' NOT NULL,
	"session_key" text,
	"nyx_thread_id" integer,
	"talk_mode" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"forwarded" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"commands_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
