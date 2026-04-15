#!/usr/bin/env bash
# Run the full test suite locally (web + api + workers, unit + integration).
#
# Assumes `./scripts/test-infra.sh up` has been run so Postgres/MinIO/RabbitMQ
# are reachable on their default host ports.

set -euo pipefail

cd "$(dirname "$0")/.."

# Test env — mirrors .github/workflows/test.yml
export DATABASE_URL="${DATABASE_URL:-postgres://snapscribe:snapscribe@localhost:5433/snapscribe}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-snapscribe}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-snapscribe-secret}"
export S3_BUCKET="${S3_BUCKET:-snapscribe-test}"
export AMQP_URL="${AMQP_URL:-amqp://snapscribe:snapscribe@localhost:5672}"
export QUEUE_NAME="${QUEUE_NAME:-jumpcut-test}"
export CLERK_SECRET_KEY="${CLERK_SECRET_KEY:-sk_test_ci}"
export CLERK_PUBLISHABLE_KEY="${CLERK_PUBLISHABLE_KEY:-pk_test_ci}"
export GCP_PROJECT="${GCP_PROJECT:-dummy-project}"

SCOPE="${1:-all}"

run_web() {
  echo "=== web (Vitest) ==="
  pnpm --filter web test
}

run_api() {
  echo "=== api (Bun test) ==="
  (cd apps/api && bun test)
}

run_workers() {
  echo "=== workers (pytest) ==="
  # S3_ENDPOINT for workers must be host:port without scheme (minio SDK)
  (
    cd workers
    export S3_ENDPOINT="${S3_ENDPOINT#http://}"
    export S3_ENDPOINT="${S3_ENDPOINT#https://}"
    export S3_BUCKET="${S3_BUCKET_WORKERS:-snapscribe-workers-test}"
    uv run pytest -q
  )
}

case "$SCOPE" in
  all)
    run_web
    run_api
    run_workers
    ;;
  web) run_web ;;
  api) run_api ;;
  workers) run_workers ;;
  unit)
    pnpm --filter web test
    (cd apps/api && bun test test/jobs.test.ts test/auth.test.ts)
    (cd workers && uv run pytest -q -m "not integration")
    ;;
  *)
    echo "Usage: $0 {all|web|api|workers|unit}" >&2
    exit 1
    ;;
esac
