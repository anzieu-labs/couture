// Applies db/schema.sql to the Neon branch of .env.local (its direct connection: migrations do
// not go through the pooler). Run with `npm run db:migrate`; the statements are idempotent.
import { readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set: run `neon env pull` first.");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  const { rows } = await client.query("select count(*)::int as patterns from patterns");
  console.log(`schema applied on branch ${process.env.NEON_BRANCH ?? "?"}: ${rows[0].patterns} pattern(s) in the library`);
} finally {
  await client.end();
}
