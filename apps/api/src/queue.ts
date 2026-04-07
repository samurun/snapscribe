import amqp, { type Channel, type ChannelModel } from "amqplib";
import { env } from "./env";

let conn: ChannelModel | null = null;
let channel: Channel | null = null;

export async function getChannel(): Promise<Channel> {
  if (channel) return channel;
  conn = await amqp.connect(env.AMQP_URL);
  channel = await conn.createChannel();

  const dlx = `${env.QUEUE_NAME}.dlx`;
  const dlq = `${env.QUEUE_NAME}.dlq`;
  await channel.assertExchange(dlx, "fanout", { durable: true });
  await channel.assertQueue(dlq, { durable: true });
  await channel.bindQueue(dlq, dlx, "");
  await channel.assertQueue(env.QUEUE_NAME, {
    durable: true,
    arguments: { "x-dead-letter-exchange": dlx },
  });
  return channel;
}

export type Task = "transcribe";

export async function publishTask(jobId: string, task: Task): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(
    env.QUEUE_NAME,
    Buffer.from(JSON.stringify({ jobId, task })),
    { persistent: true, contentType: "application/json" },
  );
}

export async function closeQueue(): Promise<void> {
  await channel?.close();
  await conn?.close();
  channel = null;
  conn = null;
}
