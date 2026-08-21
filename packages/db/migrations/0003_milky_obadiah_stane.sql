ALTER TABLE "gates" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "gates_updated_at_idx" ON "gates" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "runs_updated_at_idx" ON "runs" USING btree ("updated_at");