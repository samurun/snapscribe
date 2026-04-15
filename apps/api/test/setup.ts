// Provide env defaults before any module reads src/env.ts.
// Integration tests override these before import.
process.env.DATABASE_URL ??=
  "postgres://snapscribe:snapscribe@localhost:5433/snapscribe";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY ??= "snapscribe";
process.env.S3_SECRET_KEY ??= "snapscribe-secret";
process.env.S3_BUCKET ??= "snapscribe-test";
process.env.AMQP_URL ??= "amqp://snapscribe:snapscribe@localhost:5672";
process.env.CLERK_SECRET_KEY ??= "sk_test_dummy";
process.env.CLERK_PUBLISHABLE_KEY ??= "pk_test_dummy";
