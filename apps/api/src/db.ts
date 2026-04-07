import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env";

// Per-step state machine: pending → queued → running → done / error
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  inputName: text("input_name").notNull(),
  inputKey: text("input_key").notNull(),

  transcribeStatus: text("transcribe_status").notNull().default("pending"),
  transcribeProgress: integer("transcribe_progress").notNull().default(0),
  transcribeError: text("transcribe_error"),
  transcribeStartedAt: timestamp("transcribe_started_at", { withTimezone: true }),
  transcribeFinishedAt: timestamp("transcribe_finished_at", { withTimezone: true }),

  outputSrtKey: text("output_srt_key"),
  outputJsonKey: text("output_json_key"),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type JobRow = typeof jobs.$inferSelect;

const client = postgres(env.DATABASE_URL, { max: 10 });
export const db = drizzle(client);

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "..", "drizzle");

export async function bootstrap(): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
