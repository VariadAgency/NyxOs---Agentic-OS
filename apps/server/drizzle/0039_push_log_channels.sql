-- Nyx kennt seine Mitteilungen: je Protokoll-Zeile die Wege (Mac/Browser/iPhone/Telegram) mit Ergebnis,
-- dazu ein Sammel-Kennzeichen (Abwesenheits-Bündel). Rein additiv, alte Zeilen bleiben NULL bzw. false.
ALTER TABLE "push_log" ADD COLUMN IF NOT EXISTS "channels" jsonb;
--> statement-breakpoint
ALTER TABLE "push_log" ADD COLUMN IF NOT EXISTS "bundle" boolean DEFAULT false NOT NULL;
