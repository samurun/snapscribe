import { describe, expect, it } from "bun:test";
import {
  ARTIFACT_CONTENT_TYPE,
  artifactKey,
  jobView,
  sanitize,
} from "../src/jobs";
import type { JobRow } from "../src/db";

const baseJob: JobRow = {
  id: "11111111-1111-1111-1111-111111111111",
  userId: "user_abc",
  inputName: "demo.mp4",
  inputKey: "jobs/11111111-1111-1111-1111-111111111111/input/demo.mp4",
  transcribeStatus: "pending",
  transcribeProgress: 0,
  transcribeError: null,
  transcribeStartedAt: null,
  transcribeFinishedAt: null,
  outputSrtKey: null,
  outputJsonKey: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("sanitize", () => {
  it("keeps safe filename characters", () => {
    expect(sanitize("demo.mp4")).toBe("demo.mp4");
    expect(sanitize("my-file_v2.mov")).toBe("my-file_v2.mov");
  });
  it("replaces unsafe characters with underscore", () => {
    expect(sanitize("a b c.mp4")).toBe("a_b_c.mp4");
    expect(sanitize("hello!@#.mp4")).toBe("hello_.mp4");
    expect(sanitize("ไทย.mp4")).toBe("_.mp4");
  });
  it("falls back to default when name is empty", () => {
    expect(sanitize("")).toBe("input.mp4");
  });
});

describe("jobView", () => {
  it("returns URLs scoped to job id", () => {
    const v = jobView(baseJob);
    expect(v.id).toBe(baseJob.id);
    expect(v.inputName).toBe("demo.mp4");
    expect(v.outputs.inputVideo).toBe(`/jobs/${baseJob.id}/file/input`);
    expect(v.outputs.srt).toBeNull();
    expect(v.outputs.json).toBeNull();
  });

  it("exposes srt + json URLs once transcript is ready", () => {
    const v = jobView({
      ...baseJob,
      outputSrtKey: "jobs/x/output/cut.srt",
      outputJsonKey: "jobs/x/output/cut.json",
    });
    expect(v.outputs.srt).toBe(`/jobs/${baseJob.id}/file/cut.srt`);
    expect(v.outputs.json).toBe(`/jobs/${baseJob.id}/file/cut.json`);
  });

  it("returns null inputVideo when inputKey empty", () => {
    const v = jobView({ ...baseJob, inputKey: "" });
    expect(v.outputs.inputVideo).toBeNull();
  });

  it("mirrors transcribe step fields", () => {
    const startedAt = new Date("2026-01-01T00:01:00Z");
    const v = jobView({
      ...baseJob,
      transcribeStatus: "running",
      transcribeProgress: 42,
      transcribeError: null,
      transcribeStartedAt: startedAt,
    });
    expect(v.transcribe.status).toBe("running");
    expect(v.transcribe.progress).toBe(42);
    expect(v.transcribe.startedAt).toEqual(startedAt);
  });
});

describe("artifactKey", () => {
  it("returns inputKey for 'input'", () => {
    expect(artifactKey(baseJob, "input")).toBe(baseJob.inputKey);
  });
  it("returns null for 'input' when inputKey empty", () => {
    expect(artifactKey({ ...baseJob, inputKey: "" }, "input")).toBeNull();
  });
  it("returns srt / json keys when present", () => {
    const job = {
      ...baseJob,
      outputSrtKey: "jobs/x/output/cut.srt",
      outputJsonKey: "jobs/x/output/cut.json",
    };
    expect(artifactKey(job, "cut.srt")).toBe(job.outputSrtKey);
    expect(artifactKey(job, "cut.json")).toBe(job.outputJsonKey);
  });
  it("returns null when artifact not generated", () => {
    expect(artifactKey(baseJob, "cut.srt")).toBeNull();
    expect(artifactKey(baseJob, "cut.json")).toBeNull();
  });
});

describe("ARTIFACT_CONTENT_TYPE", () => {
  it("maps every artifact name to a content type", () => {
    expect(ARTIFACT_CONTENT_TYPE["input"]).toBe("video/mp4");
    expect(ARTIFACT_CONTENT_TYPE["cut.srt"]).toBe("application/x-subrip");
    expect(ARTIFACT_CONTENT_TYPE["cut.json"]).toBe("application/json");
  });
});
