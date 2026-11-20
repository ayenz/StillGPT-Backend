ALTER TABLE "faces" ADD COLUMN "portrait_file_id" text;--> statement-breakpoint
ALTER TABLE "faces" ADD COLUMN "combo_file_id" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "head_traits" jsonb;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_portrait_file_id_files_id_fk" FOREIGN KEY ("portrait_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_combo_file_id_files_id_fk" FOREIGN KEY ("combo_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;