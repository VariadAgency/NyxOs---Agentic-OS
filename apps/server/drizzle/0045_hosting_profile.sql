-- „Betrieb & Zugriff“: chosen way + form values (one row, id = 1), last check per target and the last access through
-- an outside address. Additive only. No secrets (they live in the secret store `secrets` under `hosting.*`).
CREATE TABLE IF NOT EXISTS "hosting_profile" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"remote_seen" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
