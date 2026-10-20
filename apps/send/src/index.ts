import { z } from "zod";
import { SendStore, DeliveryStore } from "@countersign/db";
import { processSend } from "./process";
import { resendProvider, type Provider } from "./resend";

type SenderBindings = Pick<
  SendEnv,
  "DB" | "SEND_ENABLED" | "SENDER_EMAIL" | "RESEND_API_KEY"
> & { SEND_QUEUE: Pick<SendEnv["SEND_QUEUE"], "send"> };

const messageSchema = z.strictObject({ send_id: z.string().uuid() });

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: SenderBindings,
  provider?: Provider,
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = messageSchema.safeParse(message.body);

    if (!parsed.success) {
      console.warn(
        JSON.stringify({
          event: "invalid_send_message",
          message_id: message.id,
        }),
      );

      message.ack();

      continue;
    }

    if (env.SEND_ENABLED !== "true") {
      message.ack();

      continue;
    }

    try {
      const outcome = await processSend(
        env.DB,
        parsed.data.send_id,
        env.SENDER_EMAIL,
        provider ?? resendProvider(env.RESEND_API_KEY),
      );

      if (outcome.kind === "retry" && outcome.nextAt !== undefined) {
        try {
          await env.SEND_QUEUE.send(parsed.data, {
            delaySeconds: Math.min(
              86400,
              Math.max(1, Math.ceil((outcome.nextAt - Date.now()) / 1000)),
            ),
          });
        } catch {
          console.warn(
            JSON.stringify({
              event: "retry_hint_publish_failed",
              send_id: parsed.data.send_id,
            }),
          );
        }
      }

      message.ack();
    } catch {
      console.error(
        JSON.stringify({
          event: "send_processing_failed",
          send_id: parsed.data.send_id,
        }),
      );

      message.retry({ delaySeconds: 60 });
    }
  }
}

export async function recover(env: SenderBindings): Promise<void> {
  // Apply verified evidence even while new dispatch is paused.
  await new DeliveryStore(env.DB).recover(50);

  if (env.SEND_ENABLED !== "true") return;

  const store = new SendStore(env.DB);

  for (const candidate of await store.recoverable(50)) {
    await store.settleUnavailable(candidate.id);

    // Republish is harmless if the intent settled or was claimed concurrently.
    await env.SEND_QUEUE.send({ send_id: candidate.id });
  }
}

export default {
  async queue(batch, env) {
    await handleQueue(batch, env);
  },
  async scheduled(_event, env) {
    await recover(env);
  },
} satisfies ExportedHandler<SendEnv>;
