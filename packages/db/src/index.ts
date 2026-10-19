import { eq } from "drizzle-orm";
import { database } from "./client";
import { scaffoldMetadata } from "./schema";

/** Proves the configured D1 binding and local migration work together. */
export async function readSchemaVersion(binding: D1Database): Promise<number> {
  const row = await database(binding)
    .select()
    .from(scaffoldMetadata)
    .where(eq(scaffoldMetadata.id, 1))
    .get();

  if (!row) throw new Error("Missing scaffold metadata");

  return row.schema_version;
}

export { database } from "./client";

export * as schema from "./schema";

export { DraftStore, Conflict } from "./drafts";

export type { MutationResult } from "./drafts";

export { AuthStore, AuthError } from "./auth";

export type { Session, ProvisionInput } from "./auth";

export { AgentReads } from "./agent-reads";

export type { AgentIdentity, RevisionRow, StatusRow } from "./agent-reads";

export { ReviewerReads } from "./reviewer-reads";

export { SendStore } from "./sends";

export type { ClaimedSend, AttemptResult } from "./sends";

export { DeliveryStore } from "./delivery";

export type { VerifiedDeliveryEvent, DeliveryDetail } from "./delivery";

export type { ReviewQueuePage, ReviewQueueOptions } from "./reviewer-reads";
