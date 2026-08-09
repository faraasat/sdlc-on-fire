CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"agent_target" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actors_kind_check" CHECK ("actors"."kind" IN ('human','agent'))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"gate_id" bigserial NOT NULL,
	"actor_id" uuid NOT NULL,
	"role_id" integer,
	"decision" text NOT NULL,
	"reason" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_decision_check" CHECK ("approvals"."decision" IN ('approve','request-changes','override')),
	CONSTRAINT "reason_required_on_override" CHECK ("approvals"."decision" <> 'override' OR "approvals"."reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb,
	"prev_hash" text,
	"record_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_type" text NOT NULL,
	"file_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"title" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_doc_type_check" CHECK ("docs"."doc_type" IN ('spec','change','decision','research','risk','archive','constitution'))
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_table" text NOT NULL,
	"source_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(384),
	"heading_breadcrumb" text,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"producer" text NOT NULL,
	"git_sha" text NOT NULL,
	"dirty_tree_hash" text,
	"env" jsonb NOT NULL,
	"command" jsonb,
	"content_hash" text NOT NULL,
	"signature" text,
	"confidence" numeric NOT NULL,
	"produced_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_producer_check" CHECK ("evidence"."producer" IN ('ci','daemon','human','agent-claim')),
	CONSTRAINT "evidence_confidence_check" CHECK ("evidence"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "gate_evidence" (
	"gate_id" bigserial NOT NULL,
	"evidence_id" bigserial NOT NULL,
	CONSTRAINT "gate_evidence_gate_id_evidence_id_pk" PRIMARY KEY("gate_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "gate_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_type" text,
	"risk_level" text,
	"path_pattern" text,
	"required_role_id" integer,
	"min_approvals" integer DEFAULT 1 NOT NULL,
	"overridable_by_role_id" integer
);
--> statement-breakpoint
CREATE TABLE "gates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"gate_name" text NOT NULL,
	"policy_id" integer,
	"result" text,
	"evaluated_at" timestamp with time zone,
	CONSTRAINT "gates_result_check" CHECK ("gates"."result" IN ('pending','pass','fail'))
);
--> statement-breakpoint
CREATE TABLE "lifecycle_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"is_terminal" boolean DEFAULT false NOT NULL,
	CONSTRAINT "lifecycle_states_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "lifecycle_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_id" uuid,
	"gate_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"description" text,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"skill_id" text,
	"agent_target" text,
	"model" text,
	"context_pack_path" text,
	"status" text,
	"pr_url" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" IN ('pending','running','pass','fail','error'))
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"work_type" text,
	"preset" text,
	"risk_level" text,
	"parent_id" text,
	"file_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"git_commit_sha" text,
	"claimed_by" text,
	"claim_kind" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_type_check" CHECK ("work_items"."type" IN ('epic','story','feature','bug','task')),
	CONSTRAINT "work_items_preset_check" CHECK ("work_items"."preset" IN ('lite','standard','strict'))
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_revoked_by_actors_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_policies" ADD CONSTRAINT "gate_policies_required_role_id_roles_id_fk" FOREIGN KEY ("required_role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_policies" ADD CONSTRAINT "gate_policies_overridable_by_role_id_roles_id_fk" FOREIGN KEY ("overridable_by_role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_policy_id_gate_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."gate_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_from_state_lifecycle_states_key_fk" FOREIGN KEY ("from_state") REFERENCES "public"."lifecycle_states"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_to_state_lifecycle_states_key_fk" FOREIGN KEY ("to_state") REFERENCES "public"."lifecycle_states"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_lifecycle_state_lifecycle_states_key_fk" FOREIGN KEY ("lifecycle_state") REFERENCES "public"."lifecycle_states"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docs_file_path_key" ON "docs" USING btree ("file_path");--> statement-breakpoint
CREATE INDEX "docs_doc_type_idx" ON "docs" USING btree ("doc_type");--> statement-breakpoint
CREATE INDEX "docs_updated_at_idx" ON "docs" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "evidence_git_sha_idx" ON "evidence" USING btree ("git_sha");--> statement-breakpoint
CREATE INDEX "evidence_kind_idx" ON "evidence" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "gates_work_item_idx" ON "gates" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "lifecycle_transitions_work_item_idx" ON "lifecycle_transitions" USING btree ("work_item_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_work_item_idx" ON "runs" USING btree ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_file_path_key" ON "work_items" USING btree ("file_path");--> statement-breakpoint
CREATE INDEX "work_items_lifecycle_state_idx" ON "work_items" USING btree ("lifecycle_state");--> statement-breakpoint
CREATE INDEX "work_items_parent_idx" ON "work_items" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "work_items_updated_at_idx" ON "work_items" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "work_items_claim_idx" ON "work_items" USING btree ("claimed_by","lease_expires_at");