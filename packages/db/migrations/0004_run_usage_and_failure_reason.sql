ALTER TABLE "runs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cost_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_failure_reason_check" CHECK ("runs"."failure_reason" IS NULL OR "runs"."failure_reason" IN ('output-contract','forbidden-claim','transport','timeout','depth-cap'));