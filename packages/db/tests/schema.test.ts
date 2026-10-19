import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { database } from "../src/client";
import * as schema from "../src/schema";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
});

it("Drizzle table metadata matches every migrated domain table and index", async () => {
  const actual = await env.DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' AND name NOT GLOB '_cf_*'",
  ).all<{ name: string }>();

  const tables = Object.values(schema).filter((value) =>
    is(value, SQLiteTable),
  );

  expect(tables.map(getTableName).sort()).toEqual(
    actual.results.map((row) => row.name).sort(),
  );

  for (const table of tables) {
    const name = getTableName(table),
      columns = Object.values(getTableColumns(table));

    // Read metadata independently of Drizzle, against real migrations, so a stale
    // schema cannot silently select the wrong column or forget a nullable field.
    const migrated = await env.DB.prepare(
      'SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info(?) ORDER BY cid',
    )
      .bind(name)
      .all<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>();

    expect(
      columns.map((column) => column.name),
      name,
    ).toEqual(migrated.results.map((column) => column.name));

    for (let i = 0; i < columns.length; i++) {
      const column = columns[i]!,
        actual = migrated.results[i]!;

      expect(
        column.getSQLType().toUpperCase(),
        `${name}.${column.name} type`,
      ).toBe(actual.type);

      if (!actual.pk)
        expect(column.notNull, `${name}.${column.name} nullability`).toBe(
          Boolean(actual.notnull),
        );

      if (column.default !== undefined) {
        const expected =
          typeof column.default === "string"
            ? `'${column.default}'`
            : String(column.default);

        expect(actual.dflt_value, `${name}.${column.name} default`).toBe(
          expected,
        );
      } else
        expect(actual.dflt_value, `${name}.${column.name} default`).toBeNull();
    }

    const indexes = await env.DB.prepare(
      "SELECT name FROM pragma_index_list(?)",
    )
      .bind(name)
      .all<{ name: string }>();

    for (const index of getTableConfig(table).indexes) {
      expect(
        indexes.results.map((row) => row.name),
        name,
      ).toContain(index.config.name);
    }
  }

  // Existing view metadata must execute against the actual window-function view.
  expect(await database(env.DB).select().from(schema.deliveryEvidence)).toEqual(
    [],
  );
});

it("Drizzle batches roll back earlier builder writes when a later constraint fails", async () => {
  const db = database(env.DB),
    id = crypto.randomUUID();

  await expect(
    db.batch([
      db.insert(schema.reviewers).values({
        id,
        email: `${id}@example.com`,
        name: "Rollback",
        password_hash: "test-only",
        allowed_recipient_email: "reviewer@example.com",
      }),
      db.insert(schema.agents).values({
        id,
        reviewer_id: "missing-reviewer",
        name: "Invalid FK",
        key_hash: id,
        key_ciphertext: "test-only",
        key_nonce: "test-only",
        key_encryption_version: 1,
      }),
    ]),
  ).rejects.toThrow();

  const count = await db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${schema.reviewers} WHERE ${schema.reviewers.id}=${id}`,
  );

  expect(count?.n).toBe(0);
});
