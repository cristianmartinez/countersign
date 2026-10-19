import { and, eq, gt, sql } from "drizzle-orm";
import { database, type Database } from "./client";
import { reviewers, agents, reviewerSessions, loginThrottles } from "./schema";
import {
  hashPassword,
  verifyPassword,
  randomToken,
  encryptAgentKey,
  decryptAgentKey,
  sha256,
  LIMITS,
} from "@countersign/core";

export class AuthError extends Error {
  constructor(
    public readonly code: "unauthorized" | "rate_limited" | "not_found",
    public readonly retryAfter = 900,
  ) {
    super(code);
  }
}

export interface Session {
  reviewer_id: string;
  token_hash: string;
  csrf_hash: string;
  expires_at: number;
}

export interface ProvisionInput {
  email: string;
  name: string;
  password: string;
  recipient: string;
  agentName: string;
}

export class AuthStore {
  private readonly db: Database;

  constructor(
    binding: D1Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db = database(binding);
  }

  async provision(input: ProvisionInput, secret: string) {
    const email = input.email.trim().toLowerCase();

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !input.name.trim() ||
      !input.agentName.trim()
    )
      throw new Error("Invalid account details");

    const recipient = input.recipient.trim();

    const at = recipient.lastIndexOf("@");

    if (at < 1 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient))
      throw new Error("Invalid recipient");

    const normalized =
      recipient.slice(0, at) + "@" + recipient.slice(at + 1).toLowerCase();

    const reviewer = crypto.randomUUID(),
      agent = crypto.randomUUID(),
      key = "cs_agent_" + randomToken();

    const [passwordHash, keyHash, encrypted] = await Promise.all([
      hashPassword(input.password),
      sha256(key),
      encryptAgentKey(key, secret, agent),
    ]);

    await this.db.batch([
      this.db.insert(reviewers).values({
        id: reviewer,
        email,
        name: input.name,
        password_hash: passwordHash,
        allowed_recipient_email: normalized,
      }),
      this.db.insert(agents).values({
        id: agent,
        reviewer_id: reviewer,
        name: input.agentName,
        key_hash: keyHash,
        key_ciphertext: encrypted.ciphertext,
        key_nonce: encrypted.nonce,
        key_encryption_version: encrypted.version,
      }),
    ]);

    // Raw agent keys are retrieved only through the reviewer-scoped reveal path.
    return { reviewer_id: reviewer, agent_id: agent };
  }

  async resetPassword(reviewer: string, password: string) {
    const hash = await hashPassword(password);

    const result = await this.db.batch([
      this.db
        .update(reviewers)
        .set({
          password_hash: hash,
          auth_version: sql`${reviewers.auth_version}+1`,
        })
        .where(eq(reviewers.id, reviewer)),
      this.db
        .delete(reviewerSessions)
        .where(eq(reviewerSessions.reviewer_id, reviewer)),
    ]);

    if (!result[0]?.meta.changes) throw new AuthError("not_found");
  }

  async login(email: string, password: string, ip: string, oldToken?: string) {
    const normalized = email.trim().toLowerCase(),
      now = this.now(),
      start = Math.floor(now / 900000) * 900000;

    const accountScope = await sha256("account:" + normalized),
      ipScope = await sha256("ip:" + ip);

    // Reserve before password hashing: atomically bound concurrent expensive work across instances.
    const reserve = (scope: string) =>
      this.db
        .insert(loginThrottles)
        .values({ scope_hash: scope, attempts: 1, window_start: start })
        .onConflictDoUpdate({
          target: loginThrottles.scope_hash,
          set: {
            attempts: sql`CASE WHEN ${loginThrottles.window_start}=${start} THEN ${loginThrottles.attempts}+1 ELSE 1 END`,
            window_start: start,
          },
        })
        .returning({ attempts: loginThrottles.attempts });

    const reservations = await this.db.batch([
      reserve(accountScope),
      reserve(ipScope),
    ]);

    if (
      (reservations[0]?.[0]?.attempts ?? 0) > 5 ||
      (reservations[1]?.[0]?.attempts ?? 0) > 30
    )
      throw new AuthError(
        "rate_limited",
        Math.ceil((start + 900000 - now) / 1000),
      );

    const row = await this.db
      .select({
        id: reviewers.id,
        password_hash: reviewers.password_hash,
        auth_version: reviewers.auth_version,
      })
      .from(reviewers)
      .where(eq(reviewers.email, normalized))
      .get();

    // Unknown users pay the same KDF cost; salt/hash are public dummy data, never a credential.
    const dummy = "scrypt-v1$" + "00".repeat(16) + "$" + "00".repeat(32);

    const valid = await verifyPassword(password, row?.password_hash ?? dummy);

    if (!row || !valid) throw new AuthError("unauthorized");

    const token = randomToken(),
      csrf = randomToken(),
      tokenHash = await sha256(token),
      csrfHash = await sha256(csrf);

    // Freeze the credential/version check into the INSERT itself: password reset
    // may race the expensive password verification above.
    const createSession = this.db.insert(reviewerSessions).select(
      this.db
        .select({
          token_hash: sql`${tokenHash}`.as("token_hash"),
          reviewer_id: reviewers.id,
          created_at: sql`${now}`.as("created_at"),
          expires_at: sql`${now + LIMITS.sessionSeconds * 1000}`.as(
            "expires_at",
          ),
          csrf_hash: sql`${csrfHash}`.as("csrf_hash"),
          auth_version: reviewers.auth_version,
        })
        .from(reviewers)
        .where(
          sql`id=${row.id} AND password_hash=${row.password_hash} AND auth_version=${row.auth_version}`,
        ),
    );

    const revokeOldSession = oldToken
      ? [
          this.db
            .delete(reviewerSessions)
            .where(eq(reviewerSessions.token_hash, await sha256(oldToken))),
        ]
      : [];

    // Keep concurrent failures accounted for; remove just this successful reservation.
    const result = await this.db.batch([
      createSession,
      ...revokeOldSession,
      this.db
        .update(loginThrottles)
        .set({ attempts: sql`max(0,${loginThrottles.attempts}-1)` })
        .where(
          and(
            eq(loginThrottles.scope_hash, accountScope),
            eq(loginThrottles.window_start, start),
          ),
        ),
    ]);

    if (!result[0]?.meta.changes) throw new AuthError("unauthorized");

    return { token, csrf, reviewer_id: row.id };
  }

  async session(token: string | undefined): Promise<Session | null> {
    if (!token) return null;

    return (
      (await this.db
        .select({
          reviewer_id: reviewerSessions.reviewer_id,
          token_hash: reviewerSessions.token_hash,
          csrf_hash: reviewerSessions.csrf_hash,
          expires_at: reviewerSessions.expires_at,
        })
        .from(reviewerSessions)
        .innerJoin(reviewers, eq(reviewers.id, reviewerSessions.reviewer_id))
        .where(
          and(
            eq(reviewerSessions.token_hash, await sha256(token)),
            gt(reviewerSessions.expires_at, this.now()),
            eq(reviewerSessions.auth_version, reviewers.auth_version),
          ),
        )
        .get()) ?? null
    );
  }

  async logout(token: string) {
    await this.db
      .delete(reviewerSessions)
      .where(eq(reviewerSessions.token_hash, await sha256(token)));
  }

  async reveal(reviewer: string, secret: string) {
    const row = await this.db
      .select({
        id: agents.id,
        key_ciphertext: agents.key_ciphertext,
        key_nonce: agents.key_nonce,
        key_encryption_version: agents.key_encryption_version,
      })
      .from(agents)
      .where(eq(agents.reviewer_id, reviewer))
      .get();

    if (!row) throw new AuthError("not_found");

    return {
      agent_id: row.id,
      key: await decryptAgentKey(
        {
          ciphertext: row.key_ciphertext,
          nonce: row.key_nonce,
          version: row.key_encryption_version,
        },
        secret,
        row.id,
      ),
    };
  }
}
