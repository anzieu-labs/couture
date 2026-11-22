-- The shared library of patterns (app/api/library, lib/library/store.ts): what the assistant
-- drew, for every visitor. A row tells a pattern — its name, the pattern maker's note, what its
-- card shows — and where its drawing is: a JSON document in the "patterns" bucket (Neon Object
-- Storage, neon.ts), on the same branch as this table. Rows are only ever added.
create table if not exists patterns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  note text not null default '',
  -- Key of the drawing in the bucket: { free, clasps, belts }.
  object_key text not null,
  -- The pieces side by side, as the card draws them: { pieces: [{ id, points }], width, height }.
  thumb jsonb not null,
  pieces integer not null,
  created_at timestamptz not null default now()
);
create index if not exists patterns_created_at on patterns (created_at desc);
