ALTER TABLE "files" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_jobs" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_jobs" ADD COLUMN "deleted_by" text;--> statement-breakpoint
CREATE INDEX "media_jobs_deleted_idx" ON "media_jobs" USING btree ("deleted_at");