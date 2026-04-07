import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { env } from "./env";
import { bootstrap } from "./db";
import { ensureBucket, getObjectStream } from "./storage";
import {
  createJob,
  deleteJob,
  enqueue,
  getJobById,
  listJobs,
  jobView,
  artifactKey,
  ARTIFACT_CONTENT_TYPE,
  type ArtifactName,
} from "./jobs";

await bootstrap();
await ensureBucket();

const app = new Elysia()
  .use(cors())
  .get("/", () => ({ ok: true, service: "snapscribe-api" }))
  .get("/jobs", async () => {
    const rows = await listJobs();
    return { jobs: rows.map(jobView) };
  })
  .post(
    "/jobs",
    async ({ body, set }) => {
      const file = body.file;
      if (!file || !(file instanceof File)) {
        set.status = 400;
        return { error: "missing file" };
      }
      const job = await createJob(file);
      return jobView(job);
    },
    {
      body: t.Object({
        file: t.File(),
      }),
    },
  )
  .delete("/jobs/:id", async ({ params, set }) => {
    const ok = await deleteJob(params.id);
    if (!ok) {
      set.status = 404;
      return { error: "not found" };
    }
    return { ok: true };
  })
  .get("/jobs/:id", async ({ params, set }) => {
    const job = await getJobById(params.id);
    if (!job) {
      set.status = 404;
      return { error: "not found" };
    }
    return jobView(job);
  })
  .post("/jobs/:id/transcribe", async ({ params, set }) => {
    try {
      const job = await enqueue(params.id, "transcribe");
      if (!job) {
        set.status = 404;
        return { error: "not found" };
      }
      return jobView(job);
    } catch (e) {
      set.status = 400;
      return { error: e instanceof Error ? e.message : String(e) };
    }
  })
  .get("/jobs/:id/file/:name", async ({ params, set }) => {
    const job = await getJobById(params.id);
    if (!job) {
      set.status = 404;
      return { error: "not found" };
    }
    const name = params.name as ArtifactName;
    if (!(name in ARTIFACT_CONTENT_TYPE)) {
      set.status = 404;
      return { error: "unknown artifact" };
    }
    const key = artifactKey(job, name);
    if (!key) {
      set.status = 404;
      return { error: "artifact not ready" };
    }
    try {
      const obj = await getObjectStream(key);
      if (!obj.body) {
        set.status = 404;
        return { error: "empty body" };
      }
      set.headers["content-type"] =
        obj.contentType ?? ARTIFACT_CONTENT_TYPE[name];
      if (obj.contentLength != null) {
        set.headers["content-length"] = String(obj.contentLength);
      }
      return obj.body;
    } catch (e) {
      set.status = 404;
      return { error: e instanceof Error ? e.message : "fetch failed" };
    }
  })
  .listen(env.PORT);

console.log(
  `🦊 snapscribe-api running at ${app.server?.hostname}:${app.server?.port}`,
);
