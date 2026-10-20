import { Hono } from "hono";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import { LIMITS } from "@countersign/core";
import { DeliveryStore } from "@countersign/db";

const supported = new Set([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
]);

const eventSchema = z
  .object({
    type: z.string(),
    created_at: z.iso.datetime({ offset: true }),
    data: z
      .object({
        email_id: z.string().min(1).max(200),
        tags: z.record(z.string(), z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

class BodyError extends Error {
  constructor(public readonly status: 400 | 413) {
    super("Invalid webhook body");
  }
}

async function rawBody(request: Request): Promise<string> {
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];

  let size = 0;

  if (reader)
    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        size += value.byteLength;

        if (size > LIMITS.requestBytes) {
          await reader.cancel();

          throw new BodyError(413);
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

  const bytes = new Uint8Array(size);

  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);

    offset += chunk.length;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new BodyError(400);
  }
}

const webhooks = new Hono<{ Bindings: Env }>();

webhooks.post("/resend", async (c) => {
  c.header("Cache-Control", "no-store");

  let verifier: Webhook;

  try {
    if (!c.env.RESEND_WEBHOOK_SECRET?.startsWith("whsec_"))
      throw new Error("Unconfigured webhook secret");

    // This is the exact verifier used by Resend SDK 6.34.1. It needs no sending key.
    verifier = new Webhook(c.env.RESEND_WEBHOOK_SECRET);
  } catch {
    return c.json({ error: { code: "webhook_unavailable" } }, 503);
  }

  const id = c.req.header("svix-id"),
    timestamp = c.req.header("svix-timestamp"),
    signature = c.req.header("svix-signature");

  if (
    !id ||
    id.length > 200 ||
    /\s/.test(id) ||
    !timestamp ||
    !/^\d{1,20}$/.test(timestamp) ||
    !signature ||
    signature.length > 2048
  )
    return c.json({ error: { code: "invalid_webhook" } }, 400);

  if (c.req.header("Content-Encoding"))
    return c.json({ error: { code: "encoded_body_unsupported" } }, 400);

  if (
    c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return c.json({ error: { code: "json_required" } }, 415);

  let raw: string;

  try {
    raw = await rawBody(c.req.raw);
  } catch (error) {
    return c.json(
      {
        error: {
          code:
            error instanceof BodyError && error.status === 413
              ? "payload_too_large"
              : "invalid_webhook",
        },
      },
      error instanceof BodyError ? error.status : 400,
    );
  }

  let value: unknown;

  try {
    value = verifier.verify(raw, {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    });
  } catch {
    return c.json({ error: { code: "invalid_webhook" } }, 400);
  }

  const envelope = z.object({ type: z.string() }).safeParse(value);

  if (!envelope.success)
    return c.json({ error: { code: "invalid_webhook_payload" } }, 422);

  if (!supported.has(envelope.data.type))
    return c.json({ received: true, ignored: true });

  const parsed = eventSchema.safeParse(value);

  if (!parsed.success)
    return c.json({ error: { code: "invalid_webhook_payload" } }, 422);

  try {
    await new DeliveryStore(c.env.DB).record({
      id,
      emailId: parsed.data.data.email_id,
      type: parsed.data.type,
      occurredAt: Date.parse(parsed.data.created_at),
      raw,
    });
  } catch {
    console.error(
      JSON.stringify({ event: "webhook_persistence_failed", svix_id: id }),
    );

    return c.json({ error: { code: "webhook_unavailable" } }, 503);
  }

  return c.json({ received: true });
});

export { webhooks };
