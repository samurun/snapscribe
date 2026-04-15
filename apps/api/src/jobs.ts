import { and, eq, desc } from "drizzle-orm";
import { db, jobs, type JobRow } from "./db";
import { putObject } from "./storage";
import { publishTask, type Task } from "./queue";

export type ArtifactName = "input" | "cut.srt" | "cut.json";

export function sanitize(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_") || "input.mp4";
}

export async function createJob(
  userId: string,
  file: File,
): Promise<JobRow> {
  const safeName = sanitize(file.name);
  const buf = Buffer.from(await file.arrayBuffer());

  const [row] = await db
    .insert(jobs)
    .values({ userId, inputName: safeName, inputKey: "" })
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

export async function enqueue(
  userId: string,
  id: string,
  task: Task,
): Promise<JobRow | null> {
  const job = await getJobById(userId, id);
  if (!job) return null;

  const [updated] = await db
    .update(jobs)
    .set({
      transcribeStatus: "queued",
      transcribeProgress: 0,
      transcribeError: null,
    })
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
    .returning();

  await publishTask(id, task);
  return updated!;
}

export async function getJobById(
  userId: string,
  id: string,
): Promise<JobRow | null> {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listJobs(
  userId: string,
  limit = 50,
): Promise<JobRow[]> {
  return await db
    .select()
    .from(jobs)
    .where(eq(jobs.userId, userId))
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
}

export async function deleteJob(
  userId: string,
  id: string,
): Promise<boolean> {
  const job = await getJobById(userId, id);
  if (!job) return false;
  const keys = [job.inputKey, job.outputSrtKey, job.outputJsonKey].filter(
    (k): k is string => !!k,
  );
  const { deleteObject } = await import("./storage");
  await Promise.allSettled(keys.map((k) => deleteObject(k)));
  await db.delete(jobs).where(and(eq(jobs.id, id), eq(jobs.userId, userId)));
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
