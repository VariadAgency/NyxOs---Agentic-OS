CREATE TABLE "mcp_connectors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"template" text,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth" text DEFAULT 'none' NOT NULL,
	"auth_name" text,
	"auth_config" jsonb,
	"enabled" boolean DEFAULT false NOT NULL,
	"oauth_expires_at" timestamp with time zone,
	"allowed_tools" jsonb,
	"last_test" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connectors_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"via" text DEFAULT 'direct' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_test" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_roles" (
	"role" text PRIMARY KEY NOT NULL,
	"provider_id" text,
	"model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"last4" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_roles" ADD CONSTRAINT "model_roles_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;
