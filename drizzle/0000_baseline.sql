CREATE TABLE "account" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "ai_provider_cooldown" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_daily" (
	"user_id" text NOT NULL,
	"day" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_daily_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "application_form_fields" (
	"user_id" text PRIMARY KEY NOT NULL,
	"work_authorization" text,
	"visa_sponsorship_needed" boolean,
	"eeo_answers" jsonb,
	"salary_expectation" text,
	"notice_period" text
);
--> statement-breakpoint
CREATE TABLE "application" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"resume_snapshot_id" text NOT NULL,
	"role_title" text NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"score" real,
	"status" text DEFAULT 'draft' NOT NULL,
	"applied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"record_id" text,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"diff" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_token" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"expires" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "contact_info" (
	"user_id" text PRIMARY KEY NOT NULL,
	"full_name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text,
	"location" text,
	"portfolio_url" text,
	"github_url" text,
	"linkedin_url" text
);
--> statement-breakpoint
CREATE TABLE "dismissed_record" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"content_hash" text NOT NULL,
	"identity_key" text,
	"label" text DEFAULT '' NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_run" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp DEFAULT now() NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"role_title" text DEFAULT '' NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"snapshot_id" text,
	"score" real,
	"keyword_coverage_pct" real,
	"halt_reason" text,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_calls" integer DEFAULT 0 NOT NULL,
	"budget_tokens" integer DEFAULT 0 NOT NULL,
	"rewrite_attempted" integer DEFAULT 0 NOT NULL,
	"rewrite_fallbacks" integer DEFAULT 0 NOT NULL,
	"rewrite_fallback_reason" text DEFAULT 'none' NOT NULL,
	"error_kind" text,
	"error_detail" text,
	"idempotency_key" text
);
--> statement-breakpoint
CREATE TABLE "enrichment_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'all' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_question" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"record_id" text,
	"subject_key" text NOT NULL,
	"kind" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"quote" text DEFAULT '' NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"asked_count" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"answer_record_id" text,
	"answer" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"settled_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "github_installation" (
	"id" integer PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_login" text NOT NULL,
	"target_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"removed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "profile_record" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"content_hash" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"flagged_for_removal" boolean DEFAULT false NOT NULL,
	"review_state" text DEFAULT 'approved' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document" jsonb NOT NULL,
	"job_requirement" jsonb,
	"score" real,
	"score_detail" jsonb,
	"record_hash_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"render_mode" text DEFAULT 'ats-strict' NOT NULL,
	"file_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"location" text,
	"start_date" text NOT NULL,
	"end_date" text DEFAULT 'present' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"content_hash" text NOT NULL,
	"review_state" text DEFAULT 'approved' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_category" (
	"name_key" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"source" text DEFAULT 'ai' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steward_dismissal" (
	"user_id" text NOT NULL,
	"suggestion_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "steward_dismissal_user_id_suggestion_id_pk" PRIMARY KEY("user_id","suggestion_id")
);
--> statement-breakpoint
CREATE TABLE "sync_job" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"total_steps" integer DEFAULT 7 NOT NULL,
	"message" text DEFAULT 'Starting…' NOT NULL,
	"sha" text,
	"corpus" jsonb,
	"partials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp,
	"password_hash" text,
	"sessions_valid_from" timestamp,
	"image" text,
	"github_login" text,
	"last_synced_sha" text,
	"last_synced_at" timestamp,
	"portfolio_repo" text,
	"approval" text DEFAULT 'pending' NOT NULL,
	"approval_decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"phase" text DEFAULT 'plan' NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"total_steps" integer DEFAULT 0 NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "radar_search" (
	"run_id" text NOT NULL,
	"key" text NOT NULL,
	"engine" text NOT NULL,
	"q" text DEFAULT '' NOT NULL,
	"search_id" text DEFAULT '' NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radar_search_run_id_key_pk" PRIMARY KEY("run_id","key")
);
--> statement-breakpoint
CREATE TABLE "serp_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"engine" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_code" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_by" text,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invite_code_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "invite_redemption" (
	"id" text PRIMARY KEY NOT NULL,
	"invite_id" text,
	"user_id" text,
	"redeemed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invite_redemption_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"terms_version" text NOT NULL,
	"age_attested" boolean NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_call" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_run_id" text,
	"user_id" text,
	"stage" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"path" text NOT NULL,
	"prompt_version" text,
	"in_tokens" integer DEFAULT 0 NOT NULL,
	"out_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"error_class" text,
	"finish_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_form_fields" ADD CONSTRAINT "application_form_fields_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_resume_snapshot_id_resume_snapshot_id_fk" FOREIGN KEY ("resume_snapshot_id") REFERENCES "public"."resume_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_info" ADD CONSTRAINT "contact_info_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissed_record" ADD CONSTRAINT "dismissed_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_run" ADD CONSTRAINT "draft_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_run" ADD CONSTRAINT "draft_run_snapshot_id_resume_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."resume_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_preference" ADD CONSTRAINT "enrichment_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_question" ADD CONSTRAINT "enrichment_question_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_question" ADD CONSTRAINT "enrichment_question_record_id_profile_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."profile_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation" ADD CONSTRAINT "github_installation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_record" ADD CONSTRAINT "profile_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_snapshot" ADD CONSTRAINT "resume_snapshot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_dismissal" ADD CONSTRAINT "steward_dismissal_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_job" ADD CONSTRAINT "sync_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radar_search" ADD CONSTRAINT "radar_search_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code" ADD CONSTRAINT "invite_code_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_redemption" ADD CONSTRAINT "invite_redemption_invite_id_invite_code_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invite_code"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_redemption" ADD CONSTRAINT "invite_redemption_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_consent" ADD CONSTRAINT "user_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_daily_day_idx" ON "ai_usage_daily" USING btree ("day","calls","tokens");--> statement-breakpoint
CREATE INDEX "application_user_idx" ON "application" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "application_snapshot_idx" ON "application" USING btree ("resume_snapshot_id");--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_attempt_idx" ON "auth_attempt" USING btree ("subject","action","created_at");--> statement-breakpoint
CREATE INDEX "auth_token_identifier_idx" ON "auth_token" USING btree ("identifier","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "dismissed_record_hash_idx" ON "dismissed_record" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "dismissed_record_identity_idx" ON "dismissed_record" USING btree ("user_id","identity_key");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_run_idem_uq" ON "draft_run" USING btree ("user_id","idempotency_key") WHERE "draft_run"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "draft_run_user_idx" ON "draft_run" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "draft_run_snapshot_idx" ON "draft_run" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "draft_run_started_idx" ON "draft_run" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "enrichment_user_state_idx" ON "enrichment_question" USING btree ("user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_user_subject_idx" ON "enrichment_question" USING btree ("user_id","subject_key");--> statement-breakpoint
CREATE INDEX "github_installation_user_idx" ON "github_installation" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "record_user_type_idx" ON "profile_record" USING btree ("user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "record_user_hash_idx" ON "profile_record" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "snapshot_user_idx" ON "resume_snapshot" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "role_user_idx" ON "role" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "syncjob_user_idx" ON "sync_job" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_run_user_created_idx" ON "agent_run" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_one_active_idx" ON "agent_run" USING btree ("user_id") WHERE "agent_run"."status" in ('running', 'awaiting');--> statement-breakpoint
CREATE INDEX "serp_cache_fetched_idx" ON "serp_cache" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "invite_redemption_invite_idx" ON "invite_redemption" USING btree ("invite_id");--> statement-breakpoint
CREATE INDEX "invite_redemption_at_idx" ON "invite_redemption" USING btree ("redeemed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_consent_user_version_idx" ON "user_consent" USING btree ("user_id","policy_version");--> statement-breakpoint
CREATE INDEX "ai_call_created_idx" ON "ai_call" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_call_provider_created_idx" ON "ai_call" USING btree ("provider","created_at");