function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env: ${key}`);
  return v;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  S3_ENDPOINT: required("S3_ENDPOINT"),
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_ACCESS_KEY: required("S3_ACCESS_KEY"),
  S3_SECRET_KEY: required("S3_SECRET_KEY"),
  S3_BUCKET: required("S3_BUCKET"),
  AMQP_URL: required("AMQP_URL"),
  QUEUE_NAME: process.env.QUEUE_NAME ?? "jumpcut",
  PORT: Number(process.env.PORT ?? 3001),
};
