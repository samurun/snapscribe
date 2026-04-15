"""Shared pytest fixtures for the workers test suite."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).parent
# workers/ is not a pnpm workspace; make its modules importable with plain `import worker`
sys.path.insert(0, str(HERE))


def _set_default_env() -> None:
    """Populate the env vars worker.py reads at import time.

    Tests that touch the real database / MinIO override these via monkeypatch
    or the integration fixture below.
    """
    defaults = {
        "DATABASE_URL": "postgres://snapscribe:snapscribe@localhost:5433/snapscribe",
        "S3_ENDPOINT": "localhost:9000",
        "S3_ACCESS_KEY": "snapscribe",
        "S3_SECRET_KEY": "snapscribe-secret",
        "S3_BUCKET": "snapscribe-workers-test",
        "AMQP_URL": "amqp://snapscribe:snapscribe@localhost:5672",
        "QUEUE_NAME": "jumpcut-test",
        "GCP_PROJECT": "dummy-project",
        "GCP_BUCKET": "dummy-bucket",
        "MAX_RETRIES": "3",
    }
    for k, v in defaults.items():
        os.environ.setdefault(k, v)


_set_default_env()


MIGRATIONS_DIR = HERE.parent / "apps" / "api" / "drizzle"


def _apply_migrations(database_url: str) -> None:
    """Ensure the schema workers care about exists.

    If the `jobs` table is already there (API job ran bootstrap, or a previous
    test run), we're done. Otherwise, apply the drizzle SQL migrations in
    order. Only the 0000_init.sql is strictly required — later migrations
    mutate columns that workers don't read/write.
    """
    import psycopg

    with psycopg.connect(database_url, autocommit=True) as conn:
        exists = conn.execute(
            "SELECT to_regclass('public.jobs')"
        ).fetchone()
        if exists and exists[0]:
            return

        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            sql = path.read_text().replace("--> statement-breakpoint", "")
            conn.execute(sql)


@pytest.fixture(scope="session")
def integration() -> dict:
    """Yield connection info for integration tests. Imports `worker` lazily so
    that unit-only runs don't open DB/MinIO connections."""
    import worker  # noqa: WPS433 — lazy import is intentional

    _apply_migrations(worker.DATABASE_URL)

    return {
        "bucket": worker.S3_BUCKET,
        "minio": worker.minio_client,
        "database_url": worker.DATABASE_URL,
    }
