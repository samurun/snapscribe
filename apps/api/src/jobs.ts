import { eq, desc } from "drizzle-orm";
import { db, jobs, type JobRow } from "./db";
import { putObject } from "./storage";
import { publishTask, type Task } from "./queue";

export type ArtifactName = "input" | "cut.srt" | "cut.json";

function sanitize(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_") || "input.mp4";
}

export async function createJob(file: File): Promise<JobRow> {
  const safeName = sanitize(file.name);
  const buf = Buffer.from(await file.arrayBuffer());

  const [row] = await db
    .insert(jobs)
    .values({ inputName: safeName, inputKey: "" })
    .returning();

  if (!row) throw new Error("failed to insert job");

  const inputKey = `jobs/${row.id}/input/${safeName}`;
  await putObject(inputKey, buf, file.type || "application/octet-stream");

  const [updated] = await db
    .update(jobs)
    .set({ inputKey })
    .where(eq(jobs.id, row.id))
    .returning();

  return updated!;
}

export async function enqueue(id: string, task: Task): Promise<JobRow | null> {
  const job = await getJobById(id);
  if (!job) return null;

  const [updated] = await db
    .update(jobs)
    .set({
      transcribeStatus: "queued",
      transcribeProgress: 0,
      transcribeError: null,
    })
    .where(eq(jobs.id, id))
    .returning();

  await publishTask(id, task);
  return updated!;
}

export async function getJobById(id: string): Promise<JobRow | null> {
  const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listJobs(limit = 50): Promise<JobRow[]> {
  return await db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
}

export async function deleteJob(id: string): Promise<boolean> {
  const job = await getJobById(id);
  if (!job) return false;
  // Best-effort: remove every artifact we know about from MinIO before
  // dropping the row. Failures are logged but don't block the delete.
  const keys = [job.inputKey, job.outputSrtKey, job.outputJsonKey].filter(
    (k): k is string => !!k,
  );
  const { deleteObject } = await import("./storage");
  await Promise.allSettled(keys.map((k) => deleteObject(k)));
  await db.delete(jobs).where(eq(jobs.id, id));
  return true;
}

export function jobView(job: JobRow) {
  const hasTranscript = !!job.outputJsonKey;
  return {
    id: job.id,
    inputName: job.inputName,
    createdAt: job.createdAt,
    transcribe: {
      status: job.transcribeStatus,
      progress: job.transcribeProgress,
      error: job.transcribeError,
      startedAt: job.transcribeStartedAt,
      finishedAt: job.transcribeFinishedAt,
    },
    outputs: {
      inputVideo: job.inputKey ? `/jobs/${job.id}/file/input` : null,
      srt: hasTranscript ? `/jobs/${job.id}/file/cut.srt` : null,
      json: hasTranscript ? `/jobs/${job.id}/file/cut.json` : null,
    },
  };
}

export function artifactKey(job: JobRow, name: ArtifactName): string | null {
  switch (name) {
    case "input":
      return job.inputKey || null;
    case "cut.srt":
      return job.outputSrtKey;
    case "cut.json":
      return job.outputJsonKey;
  }
}

export const ARTIFACT_CONTENT_TYPE: Record<ArtifactName, string> = {
  input: "video/mp4",
  "cut.srt": "application/x-subrip",
  "cut.json": "application/json",
};
