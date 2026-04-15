-- Wipe existing rows (no auth before this migration → cannot attribute ownership)
TRUNCATE TABLE "jobs";

ALTER TABLE "jobs" ADD COLUMN "user_id" text NOT NULL;
CREATE INDEX "jobs_user_id_idx" ON "jobs" ("user_id");
CREATE INDEX "jobs_user_id_created_at_idx" ON "jobs" ("user_id", "created_at" DESC);
