/**
 * Integration tests — require live Postgres + MinIO + RabbitMQ.
 *
 * Assumes docker-compose services up (from repo root):
 *   docker compose up -d postgres minio minio-init rabbitmq
 *
 * Each test uses a fresh user id so they don't collide with each other or
 * leftover rows from previous runs. After the suite the whole jobs table for
 * those ids is truncated.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

process.env.S3_BUCKET ??= "snapscribe-test";
process.env.QUEUE_NAME ??= "jumpcut-test";

const { db, bootstrap, jobs } = await import("../src/db");
const { ensureBucket, objectExists } = await import("../src/storage");
const { closeQueue, getChannel } = await import("../src/queue");
const {
  createJob,
  deleteJob,
  enqueue,
  getJobById,
  listJobs,
} = await import("../src/jobs");

const suiteId = Math.random().toString(36).slice(2, 8);
const userA = `user_a_${suiteId}`;
const userB = `user_b_${suiteId}`;
const trackedUserIds = [userA, userB];

async function drainQueue() {
  const ch = await getChannel();
  await ch.purgeQueue(process.env.QUEUE_NAME!);
}

function fakeFile(name: string, body = "hello"): File {
  return new File([body], name, { type: "video/mp4" });
}

beforeAll(async () => {
  await bootstrap();
  await ensureBucket();
  await drainQueue();
  await db.delete(jobs).where(inArray(jobs.userId, trackedUserIds));
});

afterAll(async () => {
  await db.delete(jobs).where(inArray(jobs.userId, trackedUserIds));
  await closeQueue();
});

describe("createJob", () => {
  it("inserts a row and uploads the input file", async () => {
    const job = await createJob(userA, fakeFile("demo.mp4"));
    expect(job.userId).toBe(userA);
    expect(job.inputName).toBe("demo.mp4");
    expect(job.inputKey).toBe(`jobs/${job.id}/input/demo.mp4`);
    expect(await objectExists(job.inputKey)).toBe(true);
  });

  it("sanitizes unsafe filenames", async () => {
    const job = await createJob(userA, fakeFile("my file v2.mp4"));
    expect(job.inputName).toBe("my_file_v2.mp4");
  });
});

describe("listJobs / getJobById (user isolation)", () => {
  it("returns only jobs for the calling user", async () => {
    const jobA = await createJob(userA, fakeFile("a.mp4"));
    const jobB = await createJob(userB, fakeFile("b.mp4"));

    const listA = await listJobs(userA);
    const listB = await listJobs(userB);

    expect(listA.some((j) => j.id === jobA.id)).toBe(true);
    expect(listA.some((j) => j.id === jobB.id)).toBe(false);
    expect(listB.some((j) => j.id === jobB.id)).toBe(true);
    expect(listB.some((j) => j.id === jobA.id)).toBe(false);
  });

  it("returns null when fetching another user's job by id", async () => {
    const jobB = await createJob(userB, fakeFile("b2.mp4"));
    expect(await getJobById(userA, jobB.id)).toBeNull();
    expect((await getJobById(userB, jobB.id))?.id).toBe(jobB.id);
  });
});

describe("enqueue", () => {
  it("flips status to queued and publishes to RabbitMQ", async () => {
    await drainQueue();
    const job = await createJob(userA, fakeFile("q.mp4"));
    const updated = await enqueue(userA, job.id, "transcribe");
    expect(updated?.transcribeStatus).toBe("queued");
    expect(updated?.transcribeProgress).toBe(0);
    expect(updated?.transcribeError).toBeNull();

    // pull one message back off the queue to assert payload shape
    const ch = await getChannel();
    const msg = await ch.get(process.env.QUEUE_NAME!, { noAck: true });
    expect(msg).toBeTruthy();
    const payload = JSON.parse(msg!.content.toString());
    expect(payload).toEqual({ jobId: job.id, task: "transcribe" });
  });

  it("returns null when enqueueing another user's job", async () => {
    const jobB = await createJob(userB, fakeFile("foreign.mp4"));
    expect(await enqueue(userA, jobB.id, "transcribe")).toBeNull();
  });
});

describe("deleteJob", () => {
  it("removes row + artifacts for the owning user", async () => {
    const job = await createJob(userA, fakeFile("del.mp4"));
    const ok = await deleteJob(userA, job.id);
    expect(ok).toBe(true);
    const rows = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(rows.length).toBe(0);
    expect(await objectExists(job.inputKey)).toBe(false);
  });

  it("refuses to delete another user's job", async () => {
    const jobB = await createJob(userB, fakeFile("safe.mp4"));
    const ok = await deleteJob(userA, jobB.id);
    expect(ok).toBe(false);
    expect((await getJobById(userB, jobB.id))?.id).toBe(jobB.id);
  });

  it("returns false for unknown ids", async () => {
    expect(
      await deleteJob(userA, "00000000-0000-0000-0000-000000000000"),
    ).toBe(false);
  });
});
