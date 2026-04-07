CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"input_name" text NOT NULL,
	"input_key" text NOT NULL,
	"jumpcut_status" text DEFAULT 'pending' NOT NULL,
	"jumpcut_progress" integer DEFAULT 0 NOT NULL,
	"jumpcut_error" text,
	"jumpcut_started_at" timestamp with time zone,
	"jumpcut_finished_at" timestamp with time zone,
	"transcribe_status" text DEFAULT 'pending' NOT NULL,
	"transcribe_progress" integer DEFAULT 0 NOT NULL,
	"transcribe_error" text,
	"transcribe_started_at" timestamp with time zone,
	"transcribe_finished_at" timestamp with time zone,
	"output_video_key" text,
	"output_srt_key" text,
	"output_json_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
