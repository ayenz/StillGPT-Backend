ALTER TABLE "media_jobs" ADD COLUMN "batch_id" text;--> statement-breakpoint
CREATE INDEX "media_jobs_batch_idx" ON "media_jobs" USING btree ("batch_id");