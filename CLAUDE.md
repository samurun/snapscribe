# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager: **pnpm 9.15.9** (workspaces) + **Turborepo**. Node >=20. The API app uses **Bun**.

Run from repo root (turbo fans out to workspaces):
- `pnpm dev` — start all dev servers (web uses `next dev --turbopack`)
- `pnpm build` / `pnpm lint` / `pnpm typecheck` / `pnpm format`

Per-app:
- `apps/web` (Next.js): `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm lint`, `pnpm typecheck`
- `apps/api` (Bun + Elysia): `bun run dev` (watches `src/index.ts`, listens on `:3001`)

Adding shadcn components (from repo root): `pnpm dlx shadcn@latest add <component> -c apps/web` — installs into `packages/ui/src/components`.

No test runner is configured yet.

### Infrastructure (docker-compose)

`docker compose up -d` starts:
- **postgres** :5433 (host) → 5432 (container), user/pass/db = `snapscribe` (host port is 5433 to avoid clashing with another local Postgres container)
- **minio** :9000 (S3 API), :9001 (console) — user `snapscribe`, password `snapscribe-secret`, bucket `snapscribe` auto-created by `minio-init`
- **rabbitmq** :5672 (AMQP), :15672 (management) — user/pass `snapscribe`

The API also needs a worker running: `cd workers && uv run python worker.py`. Without it, jobs stay `queued` forever.

### Python workers

Workers live in `workers/`. Use a single shared `uv` venv at `workers/.venv`:

```bash
cd workers
uv venv --python 3.12
uv pip install -r requirements.txt
```

Self-contained CLIs:

```bash
# Phase 1 — silence removal (Silero VAD)
uv run python vad-processor/jumpcut.py path/to/input.mp4 -o out.mp4 \
    --threshold 0.5 --min-silence 400 --pad 80

# Phase 2 — transcription (Faster-Whisper)
uv run python transcriber/transcribe.py path/to/input.mp4 --model small --language th
```

**Combined pipeline** (jumpcut → transcribe in one shot) — this is what the API invokes:

```bash
uv run python pipeline.py path/to/input.mp4
# → input_cut.mp4, input_cut.srt, input_cut.json
```

Useful flags: `--vad-preset {default,interview,podcast,lecture,aggressive,lenient}`, `--dry-run` (Phase 1 only, dumps `<stem>_segments.json`), `--burn` (hard-burn subtitles), `--model {tiny,base,small,medium,large-v3}`, `--language th`.

`ffmpeg` must be on PATH. `transcribe.py` auto-picks `cuda`/`cpu` (MPS falls back to CPU — faster-whisper / ctranslate2 has no Metal backend).

## Repository Architecture

**pnpm + Turborepo monorepo** with a separate Python workers tree (not in pnpm workspaces).

Current layout:
- `apps/web` — Next.js 16 (React 19, App Router, Turbopack), Tailwind v4, next-themes
- `apps/api` — Bun + Elysia API gateway. Accepts uploads → MinIO, persists job rows in Postgres (Drizzle ORM), publishes to RabbitMQ. Streams artifacts back from MinIO. Stateless — safe to scale horizontally.
- `workers/` — Python pipeline (`pipeline.py`) + `worker.py` (RabbitMQ consumer). Worker pulls jobs, downloads input from MinIO, runs `pipeline.py` as subprocess (keeps torch/ctranslate2 OpenMP isolated), uploads artifacts back to MinIO, updates the Postgres row. `vad-processor/` (Silero VAD + ffmpeg) and `transcriber/` (Faster-Whisper) hold the underlying CLIs. Shared `requirements.txt` and `.venv` at the `workers/` root.
- `packages/ui` — shared shadcn/ui components, imported as `@workspace/ui/components/*`
- `packages/eslint-config` — `@workspace/eslint-config`
- `packages/typescript-config` — `@workspace/typescript-config`; root `tsconfig.json` extends `base.json`

Workspace conventions:
- Internal packages are referenced via `workspace:*` and the `@workspace/*` namespace.
- UI components live in `packages/ui` (not `apps/web`) — keep shared primitives there so future apps can reuse them.
- Turbo `build` outputs `.next/**` and depends on upstream `^build`; `dev` is non-cached and persistent.
- `apps/api` is **not** a pnpm workspace member yet — it's managed standalone with Bun. Run it from `apps/api/`.

### API ↔ Worker contract

Distributed via Postgres + MinIO + RabbitMQ:

1. `POST /jobs` — API writes input to `s3://snapscribe/jobs/<id>/input/<name>`, inserts a `jobs` row (`status=queued`), publishes `{ jobId }` to the `jumpcut` queue.
2. **Worker** (`workers/worker.py`, `pika` consumer) — picks up the message, downloads the input, runs `pipeline.py` in a temp dir, uploads outputs to `s3://snapscribe/jobs/<id>/output/{cut.mp4,cut.srt,cut.json}`, updates the row to `done` (or `error` with the message). Always acks — failures are visible in the DB row, not the queue.
3. `GET /jobs/:id` — reads from Postgres.
4. `GET /jobs/:id/file/:name` — streams the artifact from MinIO via `GetObject`.

Schema lives in [apps/api/src/db.ts](apps/api/src/db.ts) (Drizzle). At API boot we run an idempotent `CREATE TABLE IF NOT EXISTS jobs` — replace with `drizzle-kit` migrations once the schema starts moving.

### Endpoints (apps/api)

- `POST /jobs` — multipart upload, field `file`. Returns `{ jobId, status }`.
- `GET /jobs/:id` — `{ status: queued|running|done|error, outputs?, error? }`
- `GET /jobs/:id/file/:name` — stream an artifact (`cut.mp4`, `cut.srt`, `cut.json`)

---

🎞️ AutoCut SaaS: Local-First AI Video Editor
ระบบจัดการวิดีโออัจฉริยะที่เน้นการทำงานแบบ Local Processing เพื่อความปลอดภัยของข้อมูล (Data Privacy) โดยเน้นฟีเจอร์หลักคือการทำ Jumpcut (Silence Removal) และ Auto-Transcription ด้วย AI

🛠️ Tech Stack
- **VAD**: Silero VAD
- **Media**: FFmpeg
- **Transcription**: Faster-Whisper
- **Workers runtime**: Python 3.12 (uv-managed)
- **Task queue**: RabbitMQ (`amqplib` in API, `pika` in worker)
- **Frontend**: Next.js 16, Tailwind v4, shadcn/ui
- **API**: Bun + Elysia + Drizzle ORM
- **DB**: PostgreSQL 16 (Drizzle schema, idempotent bootstrap on boot)
- **Object storage**: MinIO via S3 API (`@aws-sdk/client-s3` in API, `minio` SDK in worker)

📐 System Workflow
1. **Ingestion** — user uploads via web → API stores file under `apps/api/storage/<jobId>/`
2. **Audio Extraction** — pipeline uses ffmpeg to make 16kHz mono wav
3. **VAD Analysis** — Silero VAD with tunable threshold / min_silence / pad
4. **Segment Generation** — JSON of keep/cut timestamps
5. **Smart Render** — ffmpeg `filter_complex` stitches kept segments with short fades
6. **Transcription** — Faster-Whisper on the cut video → SRT + JSON

🔮 Roadmap
- [x] Phase 1 — Precision Jumpcut & Segment Analysis
- [x] Phase 2 — Faster-Whisper Thai/English transcription
- [x] Phase 2.5 — End-to-end pipeline CLI (`workers/pipeline.py`)
- [x] Phase 3 — API gateway + web UI for upload/preview
- [x] Phase 4 — Postgres-backed jobs, RabbitMQ-driven worker, MinIO storage
- [ ] **Phase 5 (next)** — Interactive transcript editor
- [ ] Phase 6 — Multi-user SaaS subscription system

## Phase 1 Key Metrics
- **Accuracy** — must distinguish background noise from speech (VAD, not dB threshold)
- **Speed** — at least 10x real-time on CPU
- **Seamless** — no clicks/pops between cuts (short fades in ffmpeg)

## Self-host (one command)

For deploying or sharing with someone who only has Docker installed:

1. `cp .env.prod.example .env` and edit values (passwords + `NEXT_PUBLIC_API_BASE` + `GCP_PROJECT` + `GCP_BUCKET`)
2. **Place a real GCP service-account JSON at `secrets/gcp-sa.json` BEFORE first `up`.** If the file is missing at start time, Docker bind-mount auto-creates it as an empty directory and the worker dies with `IsADirectoryError`. Recover by `docker compose down && rm -rf secrets/gcp-sa.json && cp <real-key>.json secrets/gcp-sa.json`.
   - Must be a real key (`"type": "service_account"`, `"private_key_id"` = hex string). A placeholder/dummy key makes google-auth fall back to a metadata server and fail with `Connection refused localhost:8080/token`.
   - Roles needed on the SA: `roles/speech.client`, `roles/storage.objectAdmin`. APIs: Cloud Speech-to-Text + Cloud Storage.
3. `pnpm apptear:up` (alias for `docker compose up -d --build`)

Endpoints: web `:3000` · api `:3001` · MinIO console `:9001` · RabbitMQ `:15672`.

Other root scripts: `apptear:down`, `apptear:logs`, `apptear:ps`, `apptear:rebuild`, `apptear:reset` (drops volumes — destructive). Full walkthrough in [docs/ONBOARDING.md](docs/ONBOARDING.md).

`NEXT_PUBLIC_API_BASE` is baked into the Next bundle at build time, so changing it requires `pnpm apptear:rebuild`.

## Getting Started (Development on the host)

This is the workflow when you want hot-reload on web/api/worker but run infra in Docker.

1. Install `ffmpeg` and `uv` (or `pip`) on your machine
2. `pnpm install` at the repo root
3. `cd workers && uv venv --python 3.12 && uv pip install -r requirements.txt`
4. `cd apps/api && bun install`
5. `cp .env.example .env`
6. `docker compose up -d postgres minio minio-init rabbitmq` (just the infra)
7. From repo root: `pnpm dev` (web) and in another shell `cd apps/api && bun run dev`
8. In a third shell: `cd workers && uv run python worker.py`
