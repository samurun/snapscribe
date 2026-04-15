"""Integration tests — require live Postgres + MinIO.

Run with `uv run pytest -m integration` after:
    docker compose up -d postgres minio

The API migrations must have run at least once (api/src/db.ts → bootstrap).
These tests create rows with a unique user_id and clean up after themselves.
"""
from __future__ import annotations

import io
import uuid
from pathlib import Path

import psycopg
import pytest

pytestmark = pytest.mark.integration


SUITE_USER = f"worker_int_{uuid.uuid4().hex[:8]}"


@pytest.fixture
def bucket(integration):
    """Ensure the test bucket exists before running integration tests."""
    client = integration["minio"]
    name = integration["bucket"]
    if not client.bucket_exists(name):
        client.make_bucket(name)
    return name


@pytest.fixture
def db_conn(integration):
    with psycopg.connect(integration["database_url"], autocommit=True) as conn:
        yield conn
        conn.execute("DELETE FROM jobs WHERE user_id = %s", (SUITE_USER,))


def _insert_job(conn, input_key: str = "jobs/test/input/demo.mp4") -> str:
    row = conn.execute(
        """
        INSERT INTO jobs (user_id, input_name, input_key)
        VALUES (%s, %s, %s) RETURNING id
        """,
        (SUITE_USER, "demo.mp4", input_key),
    ).fetchone()
    return str(row[0])


def test_fetch_job_returns_row(db_conn):
    import worker

    job_id = _insert_job(db_conn)
    job = worker.fetch_job(job_id)
    assert job["id"] == uuid.UUID(job_id) or str(job["id"]) == job_id
    assert job["input_name"] == "demo.mp4"


def test_fetch_job_raises_for_unknown_id():
    import worker

    with pytest.raises(RuntimeError):
        worker.fetch_job("00000000-0000-0000-0000-000000000000")


def test_update_job_writes_columns(db_conn):
    import worker

    job_id = _insert_job(db_conn)
    worker.update_job(
        job_id, transcribe_status="running", transcribe_progress=42
    )

    row = db_conn.execute(
        "SELECT transcribe_status, transcribe_progress FROM jobs WHERE id = %s",
        (job_id,),
    ).fetchone()
    assert row[0] == "running"
    assert row[1] == 42


def test_upload_and_download_roundtrip(tmp_path, bucket, integration):
    import worker

    src = tmp_path / "src.txt"
    payload = b"hello snapscribe"
    src.write_bytes(payload)

    key = f"tests/{uuid.uuid4().hex}.txt"
    worker.upload(key, src, content_type="text/plain")

    dst = tmp_path / "dst.txt"
    worker.download(key, dst)
    assert dst.read_bytes() == payload

    # cleanup
    integration["minio"].remove_object(bucket, key)
