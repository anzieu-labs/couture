import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import { Files } from "files-sdk";
import { neon } from "files-sdk/neon";
import { Pool } from "pg";
import type { FreePattern } from "../pattern/free";
import { thumbOf, type PatternThumb } from "../pattern/thumb";
import type { Belt, Clasp } from "../pattern/types";

/**
 * The shared library of patterns, on Neon (neon.ts, db/schema.sql): what the assistant drew is
 * kept for every visitor. A pattern is a row of the `patterns` table (Lakebase Postgres) — its
 * name, its note, what its card shows — and a JSON document in the `patterns` bucket (Object
 * Storage) — its drawing; both on the same branch, so that a branch of the database has its
 * own library. The server is the only writer (app/api/pattern/route.ts, when a model is drawn),
 * and nothing is ever changed or removed from the app.
 *
 * Connections: node-postgres through the pooled DATABASE_URL, the pool kept across requests
 * on Vercel's Fluid compute (attachDatabasePool); the bucket through the Files SDK, which reads
 * the AWS_* variables Neon gives the branch.
 */

/** A pattern of the shared library as it is listed. */
export interface SharedPattern {
  id: string;
  name: string;
  note: string;
  thumb: PatternThumb;
  pieces: number;
  createdAt: string;
}

/** Its drawing, as it is worn. */
export interface SharedDrawing {
  free: FreePattern;
  clasps: Clasp[];
  belts: Belt[];
}

const BUCKET = "patterns";
/** Patterns listed: the latest. */
const LISTED = 200;

/** Whether the library's services are told to this deployment (their variables are set): without them, patterns stay in the visitor's browser. */
export const libraryConfigured = () => !!process.env.DATABASE_URL && !!process.env.AWS_ENDPOINT_URL_S3 && !!process.env.AWS_ACCESS_KEY_ID;

let pool: Pool | null = null;
function db(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    attachDatabasePool(pool);
  }
  return pool;
}

let bucket: Files | null = null;
const files = () => (bucket ??= new Files({ adapter: neon({ bucket: BUCKET }) }));

const listed = (row: { id: string; name: string; note: string; thumb: PatternThumb; pieces: number; created_at: Date }): SharedPattern => ({
  id: row.id,
  name: row.name,
  note: row.note,
  thumb: row.thumb,
  pieces: row.pieces,
  createdAt: row.created_at.toISOString(),
});

export async function listShared(): Promise<SharedPattern[]> {
  const { rows } = await db().query("select id, name, note, thumb, pieces, created_at from patterns order by created_at desc limit $1", [LISTED]);
  return rows.map(listed);
}

/** A pattern more in the library: its drawing in the bucket, then its row. Its name is made its own when another has it ("Robe" → "Robe 2"). */
export async function addShared(name: string, note: string, drawing: SharedDrawing): Promise<SharedPattern> {
  const base = name.trim().slice(0, 80) || "Patron";
  const { rows: taken } = await db().query("select lower(name) as name from patterns where lower(name) = lower($1) or lower(name) like lower($1) || ' %'", [base]);
  const names = new Set(taken.map((r: { name: string }) => r.name));
  let own = base;
  for (let n = 2; names.has(own.toLowerCase()); n++) own = `${base} ${n}`;

  const id = crypto.randomUUID(), key = `${id}.json`;
  await files().upload(key, JSON.stringify(drawing), { contentType: "application/json" });
  const { rows } = await db().query(
    "insert into patterns (id, name, note, object_key, thumb, pieces) values ($1, $2, $3, $4, $5, $6) returning id, name, note, thumb, pieces, created_at",
    [id, own, note.trim().slice(0, 400), key, JSON.stringify(thumbOf(drawing.free)), drawing.free.pieces.length],
  );
  return listed(rows[0]);
}

/** The drawing of a pattern of the library; null when there is no such pattern. */
export async function readShared(id: string): Promise<(SharedDrawing & { name: string; note: string }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db().query("select name, note, object_key from patterns where id = $1", [id]);
  if (!rows.length) return null;
  const file = await files().download(rows[0].object_key);
  const drawing = JSON.parse(await file.text()) as SharedDrawing;
  return { name: rows[0].name, note: rows[0].note, ...drawing };
}
