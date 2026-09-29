CREATE TABLE "nyx_voice_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"provider" text DEFAULT 'local' NOT NULL,
	"elevenlabs_voice_id" text,
	"elevenlabs_voice_name" text,
	"elevenlabs_model" text DEFAULT 'eleven_multilingual_v2' NOT NULL,
	"lexicon" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
