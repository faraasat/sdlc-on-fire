ALTER TABLE "gates" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cache_creation_tokens" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "turns" integer;