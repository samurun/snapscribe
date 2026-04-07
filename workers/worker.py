"""
RabbitMQ consumer — single task type:

    { "jobId": "...", "task": "transcribe" }

transcribe:
    download input video → run transcriber/chirp.py as subprocess
    → upload cut.srt + cut.json to MinIO → mark job done
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import pika
import psycopg
from minio import Minio

HERE = Path(__file__).parent


def _load_dotenv() -> None:
    """Load KEY=VALUE pairs from the repo-root .env into os.environ.
    Existing env vars take precedence (so docker / CI overrides still win)."""
    for candidate in (HERE / ".env", HERE.parent / ".env"):
        if not candidate.exists():
            continue
        for raw in candidate.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)
        break


_load_dotenv()

TRANSCRIBE_CHIRP = HERE / "transcriber" / "chirp.py"


def env(key: str, default: str | None = None) -> str:
    v = os.environ.get(key, default)
    if v is None:
        raise SystemExit(f"missing env: {key}")
    return v


DATABASE_URL = env("DATABASE_URL")
_raw_s3 = env("S3_ENDPOINT", "localhost:9000")
# minio SDK wants "host:port" without scheme; strip http(s):// if present so
# the same env var works for both the API (aws-sdk, needs URL) and us.
S3_ENDPOINT = _raw_s3.replace("https://", "").replace("http://", "")
S3_SECURE = env("S3_SECURE", "false").lower() == "true" or _raw_s3.startswith("https://")
S3_ACCESS_KEY = env("S3_ACCESS_KEY")
S3_SECRET_KEY = env("S3_SECRET_KEY")
S3_BUCKET = env("S3_BUCKET")
AMQP_URL = env("AMQP_URL")
QUEUE_NAME = env("QUEUE_NAME", "jumpcut")
DLX_NAME = f"{QUEUE_NAME}.dlx"
DLQ_NAME = f"{QUEUE_NAME}.dlq"
MAX_RETRIES = int(env("MAX_RETRIES", "3"))

GCP_PROJECT = env("GCP_PROJECT")
GCP_BUCKET = os.environ.get("GCP_BUCKET")
GCP_LOCATION = env("GCP_LOCATION", "us-central1")
CHIRP_MODEL = env("CHIRP_MODEL", "chirp_2")
CHIRP_LANGUAGE = env("CHIRP_LANGUAGE", "th-TH")

minio_client = Minio(
    S3_ENDPOINT,
    access_key=S3_ACCESS_KEY,
    secret_key=S3_SECRET_KEY,
    secure=S3_SECURE,
)


def now() -> datetime:
    return datetime.now(timezone.utc)


def update_job(job_id: str, **fields) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k} = %s" for k in fields.keys())
    values = list(fields.values()) + [job_id]
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute(f"UPDATE jobs SET {cols} WHERE id = %s", values)


def fetch_job(job_id: str) -> dict:
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        row = conn.execute(
            "SELECT id, input_name, input_key FROM jobs WHERE id = %s",
            (job_id,),
        ).fetchone()
    if not row:
        raise RuntimeError(f"job not found: {job_id}")
    return {"id": row[0], "input_name": row[1], "input_key": row[2]}


def download(key: str, dest: Path) -> None:
    minio_client.fget_object(S3_BUCKET, key, str(dest))


def upload(key: str, src: Path, content_type: str) -> None:
    minio_client.fput_object(S3_BUCKET, key, str(src), content_type=content_type)


# ---------- task: transcribe ----------

def do_transcribe(job_id: str) -> None:
    print(f"[transcribe] {job_id} start", flush=True)
    update_job(
        job_id,
        transcribe_status="running",
        transcribe_started_at=now(),
        transcribe_progress=5,
        transcribe_error=None,
    )
    job = fetch_job(job_id)
    if not job["input_key"]:
        raise RuntimeError("no input video for transcribe")

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        local_video = tdp / Path(job["input_key"]).name
        download(job["input_key"], local_video)

        srt = tdp / "cut.srt"
        json_path = tdp / "cut.json"

        cmd = [
            sys.executable, "-u", str(TRANSCRIBE_CHIRP), str(local_video),
            "--project", GCP_PROJECT,
            "--location", GCP_LOCATION,
            "--model", CHIRP_MODEL,
            "--language", CHIRP_LANGUAGE,
            "--srt", str(srt),
            "--json", str(json_path),
        ]
        if GCP_BUCKET:
            cmd += ["--bucket", GCP_BUCKET]

        update_job(job_id, transcribe_progress=20)
        proc = subprocess.Popen(
            cmd, cwd=HERE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
        code = proc.wait()
        if code != 0:
            raise RuntimeError(f"transcribe exited with code {code}")

        update_job(job_id, transcribe_progress=85)
        srt_key = f"jobs/{job_id}/output/cut.srt"
        json_key = f"jobs/{job_id}/output/cut.json"
        upload(srt_key, srt, "application/x-subrip")
        upload(json_key, json_path, "application/json")

        update_job(
            job_id,
            transcribe_status="done",
            transcribe_progress=100,
            transcribe_finished_at=now(),
            output_srt_key=srt_key,
            output_json_key=json_key,
        )
    print(f"[transcribe] {job_id} done", flush=True)


# ---------- dispatch ----------

def process(job_id: str, task: str) -> None:
    try:
        if task == "transcribe":
            do_transcribe(job_id)
        else:
            raise RuntimeError(f"unknown task: {task}")
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        print(f"[worker] {task} {job_id} failed: {msg}", flush=True)
        update_job(
            job_id,
            transcribe_status="error",
            transcribe_error=msg,
            transcribe_finished_at=now(),
        )


_shutdown = False


def _request_shutdown(signum, _frame):
    global _shutdown
    print(f"\n[worker] received signal {signum}, finishing current task…", flush=True)
    _shutdown = True


def retry_count(properties) -> int:
    headers = (properties.headers or {}) if properties else {}
    return int(headers.get("x-retry-count", 0))


def on_message(ch, method, properties, body):
    try:
        payload = json.loads(body)
        job_id = payload["jobId"]
        task = payload["task"]
    except Exception as e:
        print(f"[worker] malformed message → DLQ: {e}", flush=True)
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
        return

    attempt = retry_count(properties) + 1
    print(f"[worker] {task} {job_id} attempt {attempt}/{MAX_RETRIES}", flush=True)

    process(job_id, task)
    ch.basic_ack(delivery_tag=method.delivery_tag)

    if _shutdown:
        ch.stop_consuming()


def connect_with_retry() -> pika.BlockingConnection:
    delay = 1.0
    for attempt in range(1, 11):
        try:
            return pika.BlockingConnection(pika.URLParameters(AMQP_URL))
        except Exception as e:
            if attempt == 10:
                raise
            print(f"[worker] amqp connect failed ({e}); retry in {delay:.1f}s", flush=True)
            time.sleep(delay)
            delay = min(delay * 2, 15)
    raise RuntimeError("unreachable")


def main() -> None:
    signal.signal(signal.SIGINT, _request_shutdown)
    signal.signal(signal.SIGTERM, _request_shutdown)

    connection = connect_with_retry()
    channel = connection.channel()

    channel.exchange_declare(exchange=DLX_NAME, exchange_type="fanout", durable=True)
    channel.queue_declare(queue=DLQ_NAME, durable=True)
    channel.queue_bind(queue=DLQ_NAME, exchange=DLX_NAME)

    channel.queue_declare(
        queue=QUEUE_NAME,
        durable=True,
        arguments={"x-dead-letter-exchange": DLX_NAME},
    )
    channel.basic_qos(prefetch_count=1)
    channel.basic_consume(queue=QUEUE_NAME, on_message_callback=on_message)
    print(
        f"[worker] consuming from {QUEUE_NAME} on {AMQP_URL} "
        f"(dlq={DLQ_NAME}, max_retries={MAX_RETRIES})",
        flush=True,
    )
    try:
        channel.start_consuming()
    finally:
        try:
            connection.close()
        except Exception:
            pass
        print("[worker] stopped", flush=True)


if __name__ == "__main__":
    main()
