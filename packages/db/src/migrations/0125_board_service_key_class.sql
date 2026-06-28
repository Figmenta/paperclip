ALTER TABLE "board_api_keys" ADD COLUMN "key_class" text DEFAULT 'human_cli' NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_auth_challenges" ADD COLUMN "key_class" text DEFAULT 'human_cli' NOT NULL;
