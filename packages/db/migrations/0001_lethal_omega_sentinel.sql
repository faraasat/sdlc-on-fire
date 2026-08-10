CREATE TABLE "memory_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"work_item_id" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"source_type" text NOT NULL,
	"written_by" text NOT NULL,
	"importance" numeric,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"superseded_by" bigint,
	"conflict_status" text DEFAULT 'none' NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"file_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_entries_type_idx" ON "memory_entries" USING btree ("type");--> statement-breakpoint
CREATE INDEX "memory_entries_work_item_idx" ON "memory_entries" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "memory_entries_valid_idx" ON "memory_entries" USING btree ("valid_to");