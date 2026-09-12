-- The LINE as a first-class table. Raw events (substance) land here —
-- append-only, no CAS contention, built for volume. The model blob keeps only
-- STATE (the knots), which grows with decision density, not message count.
-- A message is substance; a knot is born when substance distills.

create table if not exists engine_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  venture_id text not null,
  kind text not null default 'ingest',          -- ingest | verdicts | system
  type text,                                    -- message | decision | document | signal
  role text,
  text text,
  idem_key text,
  payload jsonb not null default '{}'::jsonb,   -- understood summary after distill
  distilled_at timestamptz,                     -- null = raw substance, not yet a knot source
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists engine_events_space
  on engine_events (user_id, venture_id, created_at desc);
create unique index if not exists engine_events_idem
  on engine_events (user_id, venture_id, idem_key) where idem_key is not null;
create index if not exists engine_events_undistilled
  on engine_events (user_id, venture_id, created_at asc) where distilled_at is null;

-- Service-role only (same posture as the rest of the engine schema).
alter table engine_events enable row level security;
