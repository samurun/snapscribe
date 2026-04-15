#!/usr/bin/env bash
# Start the minimum infra (Postgres + MinIO + RabbitMQ) for running integration
# tests locally. Matches the services layout the CI workflow uses.
#
# Usage:
#   ./scripts/test-infra.sh up      # bring services up
#   ./scripts/test-infra.sh down    # stop them
#   ./scripts/test-infra.sh reset   # down + drop volumes (destructive)

set -euo pipefail

cd "$(dirname "$0")/.."

# Dummy values so docker compose doesn't reject the required :? vars — these
# are only needed for web/api/worker build, not the bare infra services.
export CADDY_DOMAIN="${CADDY_DOMAIN:-localhost}"
export CLERK_SECRET_KEY="${CLERK_SECRET_KEY:-sk_test_dummy}"
export CLERK_PUBLISHABLE_KEY="${CLERK_PUBLISHABLE_KEY:-pk_test_dummy}"
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-pk_test_dummy}"

SERVICES=(postgres minio rabbitmq)

case "${1:-up}" in
  up)
    docker compose up -d "${SERVICES[@]}"
    echo ""
    echo "Infra ready. Export these before running tests:"
    echo "  export DATABASE_URL=postgres://snapscribe:snapscribe@localhost:5433/snapscribe"
    echo "  export S3_ENDPOINT=http://localhost:9000"
    echo "  export S3_ACCESS_KEY=snapscribe"
    echo "  export S3_SECRET_KEY=snapscribe-secret"
    echo "  export S3_BUCKET=snapscribe-test"
    echo "  export AMQP_URL=amqp://snapscribe:snapscribe@localhost:5672"
    echo "  export QUEUE_NAME=jumpcut-test"
    ;;
  down)
    docker compose stop "${SERVICES[@]}"
    ;;
  reset)
    docker compose down -v
    ;;
  *)
    echo "Usage: $0 {up|down|reset}" >&2
    exit 1
    ;;
esac
