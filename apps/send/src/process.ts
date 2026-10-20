import { z } from "zod";
import {
  LIMITS,
  canonicalContent,
  sha256,
  TEST_RECIPIENTS,
} from "@countersign/core";
import {
  SendStore,
  type AttemptResult,
  type ClaimedSend,
} from "@countersign/db";
import type { Provider } from "./resend";

const payloadSchema = z.strictObject({
  from: z.string(),
  to: z.tuple([z.string()]),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  tags: z
    .array(z.strictObject({ name: z.string(), value: z.string() }))
    .length(2),
  headers: z.strictObject({ "X-Entity-Ref-ID": z.string() }),
});

async function checkedPayload(
  send: ClaimedSend,
  sender: string,
): Promise<Record<string, unknown>> {
  if ((await sha256(send.payload)) !== send.payload_hash)
    throw new Error("payload_hash_mismatch");

  const raw: unknown = JSON.parse(send.payload),
    body = payloadSchema.parse(raw);

  if (
    body.from !== sender ||
    body.to[0] !== send.recipient ||
    body.from !== send.sender ||
    body.subject !== send.subject ||
    body.text !== (send.text_body ?? undefined) ||
    body.html !== (send.html_body ?? undefined)
  )
    throw new Error("approved_payload_mismatch");

  if (
    body.to[0] !== send.allowed_recipient_email &&
    !TEST_RECIPIENTS.includes(body.to[0])
  )
    throw new Error("recipient_policy_changed");

  if (
    (await sha256(
      canonicalContent({
        from: body.from,
        to: body.to,
        subject: body.subject,
        ...(body.text === undefined ? {} : { text: body.text }),
        ...(body.html === undefined ? {} : { html: body.html }),
      }),
    )) !== send.approved_hash
  )
    throw new Error("approval_hash_mismatch");

  if (
    send.idempotency_key !== `send/${send.revision_id}` ||
    body.headers["X-Entity-Ref-ID"] !== send.revision_id ||
    body.tags[0]?.name !== "draft_id" ||
    body.tags[0].value !== send.draft_id ||
    body.tags[1]?.name !== "revision_id" ||
    body.tags[1].value !== send.revision_id
  )
    throw new Error("send_metadata_mismatch");

  // Validation must not reorder, regenerate or transform the stored request.
  if (JSON.stringify(raw) !== send.payload)
    throw new Error("noncanonical_frozen_payload");

  return raw as Record<string, unknown>;
}

export function retryAfterMs(
  value: string | undefined,
  now: number,
): number | null {
  if (value === undefined || /^\s*-\d/.test(value)) return null;

  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const milliseconds = Number(value) * 1000;

    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  const date = Date.parse(value);

  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export interface ProcessOptions {
  now?: () => number;
  random?: () => number;
  timeoutMs?: number;
}

export async function processSend(
  db: D1Database,
  id: string,
  sender: string,
  provider: Provider,
  options: ProcessOptions = {},
): Promise<{ kind: "ignored" | "sent" | "failed" | "retry"; nextAt?: number }> {
  const now = options.now ?? Date.now,
    store = new SendStore(db, now),
    send = await store.claim(id);

  if (!send) return { kind: "ignored" };

  let payload: Record<string, unknown>;

  try {
    payload = await checkedPayload(send, sender);
  } catch {
    await store.finish(send, {
      kind: "failed",
      unknown: false,
      dispatched: false,
      error: "Send integrity or recipient policy validation failed",
      errorName: "send_integrity_failure",
    });

    return { kind: "failed" };
  }

  if (!(await store.isLive(send))) {
    // If time expired after validation, do not dispatch. Expired leases are recovered by Cron.
    await store.finish(send, {
      kind: "failed",
      unknown: false,
      dispatched: false,
      error: "Safe dispatch window expired",
      errorName: "dispatch_window_expired",
    });

    return { kind: "ignored" };
  }

  const signal = AbortSignal.timeout(
    options.timeoutMs ?? LIMITS.requestTimeoutMs,
  );

  let response: Awaited<ReturnType<Provider>>;

  try {
    response = await provider(payload, send.idempotency_key, signal);
  } catch {
    response = {
      error: {
        name: "application_error",
        message: "Transport failure; outcome unknown",
        statusCode: null,
      },
    };
  }

  if (response.id) {
    const saved = await store.finish(send, {
      kind: "accepted",
      providerId: response.id,
      unknown: false,
      httpStatus: 200,
    });

    return { kind: saved ? "sent" : "ignored" };
  }

  const error = response.error ?? {
    name: "application_error",
    message: "Provider result unknown",
    statusCode: null,
  };

  const transient =
    error.name === "rate_limit_exceeded" ||
    error.name === "concurrent_idempotent_requests" ||
    error.name === "service_unavailable" ||
    error.name === "application_error" ||
    (error.statusCode !== null && error.statusCode >= 500);

  const unknown =
    error.name !== "rate_limit_exceeded" &&
    (transient || error.name === "invalid_idempotent_request");

  const delay = Math.max(
    1000,
    Math.floor(
      (options.random ?? Math.random)() *
        Math.min(
          LIMITS.maxBackoffSeconds * 1000,
          5000 * 2 ** (send.attempts - 1),
        ),
    ),
    retryAfterMs(response.retryAfter, now()) ?? 0,
  );

  const nextAt = now() + delay;

  const result: AttemptResult = {
    kind: transient ? "retry" : "failed",
    unknown,
    error: `${error.name}: ${error.message.slice(0, 500)}`,
    errorName: error.name,
    httpStatus: error.statusCode,
    retryAfter:
      response.retryAfter === undefined
        ? null
        : Math.ceil((retryAfterMs(response.retryAfter, now()) ?? 0) / 1000),
    ...(transient ? { nextAt } : {}),
  };

  const saved = await store.finish(send, result);

  if (!saved) return { kind: "ignored" };

  const exhausted =
    send.attempts >= LIMITS.maxSendAttempts ||
    nextAt + LIMITS.requestTimeoutMs >= send.retry_deadline;

  return transient && !exhausted
    ? { kind: "retry", nextAt }
    : { kind: "failed" };
}
