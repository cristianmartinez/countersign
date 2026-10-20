import { Resend } from "resend";

export interface ProviderResult {
  id?: string;
  error?: { name: string; message: string; statusCode: number | null };
  retryAfter?: string;
}

export type Provider = (
  payload: Record<string, unknown>,
  key: string,
  signal: AbortSignal,
) => Promise<ProviderResult>;

export function resendProvider(apiKey: string): Provider {
  if (!apiKey?.startsWith("re_"))
    throw new Error("Missing Resend sending credential");

  // Explicit URL prevents ambient SDK configuration from redirecting credentials.
  const client = new Resend(apiKey, { baseUrl: "https://api.resend.com" });

  return async (payload, key, signal) => {
    // The public SDK post method preserves the frozen API payload field order and bytes.
    // emails.send rebuilds/reorders fields and is deliberately avoided here.
    const response = await client.post<{ id: string }>("/emails", payload, {
      idempotencyKey: key,
      signal,
    });

    if (response.error)
      return {
        error: {
          name: response.error.name,
          message: response.error.message,
          statusCode: response.error.statusCode ?? null,
        },
        ...(response.headers?.["retry-after"]
          ? { retryAfter: response.headers["retry-after"] }
          : {}),
      };

    if (typeof response.data?.id !== "string" || !response.data.id)
      return {
        error: {
          name: "application_error",
          message: "Missing provider receipt; outcome unknown",
          statusCode: null,
        },
      };

    return { id: response.data.id };
  };
}
