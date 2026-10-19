export const LIMITS = Object.freeze({
  subjectCodePoints: 200,
  bodyBytes: 100 * 1024,
  requestBytes: 256 * 1024,
  defaultPageSize: 20,
  maxPageSize: 100,
  pollSeconds: 5,
  pollBudgetSeconds: 120,
  requestTimeoutMs: 10_000,
  leaseSeconds: 60,
  maxSendAttempts: 20,
  retryWindowSeconds: 23 * 60 * 60,
  maxBackoffSeconds: 15 * 60,
  sessionSeconds: 24 * 60 * 60,
});

export { canonicalContent, sha256 } from "./content";

export type { EmailContent } from "./content";

export {
  hashPassword,
  verifyPassword,
  randomToken,
  encryptAgentKey,
  decryptAgentKey,
} from "./security";

/** Exact provider test inboxes enabled in v1; aliases require an explicit policy change. */
export const TEST_RECIPIENTS: readonly string[] = Object.freeze([
  "delivered@resend.dev",
  "bounced@resend.dev",
  "complained@resend.dev",
  "suppressed@resend.dev",
]);
