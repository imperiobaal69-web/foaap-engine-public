-- =============================================================================
--  FOAAP Engine — full schema for a STANDALONE Supabase project.
--  Everything the engine touches, consolidated from foaap-new's migrations
--  (setup-memory*, version-cas, setup-substrate, engine-api, usage_events)
--  plus the cloud-only request_logs table.
--  Posture: RLS enabled + closed on every table — the API layer (service
--  role) is the only reader/writer. Idempotent: safe to re-run.
-- =============================================================================

create extension if not exists vector;

-- ── spaces: the canonical model store ────────────────────────────────────────
create table if not exists public.venture_models (
  user_id      uuid not null references auth.users(id) on delete cascade,
  venture_id   text not null default 'default',
  model        jsonb not null default '{}'::jsonb,
  synthesis    jsonb,
  synthesis_at timestamptz,
  version      int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, venture_id)
);
create index if not exists venture_models_updated_idx on public.venture_models (updated_at desc);
alter table public.venture_models enable row level security;

create or replace function public.venture_models_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists venture_models_touch on public.venture_models;
create trigger venture_models_touch before update on public.venture_models
  for each row execute function public.venture_models_touch_updated_at();

-- Atomic version-CAS write (same contract as foaap-new/supabase/version-cas.sql).
-- p_base = -1 forces; p_base >= 0 writes only if current version matches;
-- stale base returns 'conflict' + the server's state for reconciliation.
create or replace function public.save_venture_model(
  p_user uuid, p_venture text, p_model jsonb, p_base int
) returns table (out_status text, out_version int, out_model jsonb, out_updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare cur_version int;
begin
  select v.version into cur_version from public.venture_models v
    where v.user_id = p_user and v.venture_id = p_venture for update;
  if not found then
    insert into public.venture_models (user_id, venture_id, model, version)
      values (p_user, p_venture, p_model, 1);
    return query select 'created'::text, 1, p_model, now(); return;
  end if;
  if p_base = -1 or cur_version = p_base then
    update public.venture_models set model = p_model, version = cur_version + 1
      where user_id = p_user and venture_id = p_venture;
    return query select 'ok'::text, cur_version + 1, p_model, now(); return;
  end if;
  return query select 'conflict'::text, v.version, v.model, v.updated_at
    from public.venture_models v
    where v.user_id = p_user and v.venture_id = p_venture;
end $$;
revoke all on function public.save_venture_model(uuid, text, jsonb, int) from public, anon, authenticated;

-- ── semantic substrate (pgvector) ─────────────────────────────────────────────
create table if not exists public.venture_substrate (
  id          bigserial primary key,
  user_id     text not null,
  venture_id  text not null default 'default',
  -- No CHECK constraints on event_type/pillar: the ontology is CONFIG, not
  -- schema. `pillar` stores the space's axis id (column name kept for
  -- compatibility); any ontology's axes are valid values.
  event_type  text not null,
  source_id   text,
  pillar      text,
  subnode_id  text,
  text        text not null,
  metadata    jsonb not null default '{}'::jsonb,
  embedding   vector(1024) not null,
  created_at  timestamptz not null default now()
);
-- NOT partial: PostgREST's on_conflict can only infer full unique indexes
-- (42P10 otherwise). NULL source_ids stay insertable — NULLS DISTINCT default.
create unique index if not exists venture_substrate_source_unique
  on public.venture_substrate (user_id, venture_id, event_type, source_id);
create index if not exists venture_substrate_embedding_hnsw_idx
  on public.venture_substrate using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists venture_substrate_user_venture_idx on public.venture_substrate (user_id, venture_id);
create index if not exists venture_substrate_recency_idx on public.venture_substrate (user_id, venture_id, created_at desc);
alter table public.venture_substrate enable row level security;
drop policy if exists venture_substrate_deny_all on public.venture_substrate;
create policy venture_substrate_deny_all on public.venture_substrate for select to anon, authenticated using (false);

create or replace function public.match_venture_substrate(
  query_embedding vector(1024),
  filter_user_id text,
  filter_venture_id text default 'default',
  match_count int default 30,
  filter_pillar text default null,
  filter_subnode_id text default null,
  filter_event_type text default null
) returns table (
  id bigint, event_type text, source_id text, pillar text, subnode_id text,
  text text, metadata jsonb, created_at timestamptz, similarity float
) language sql stable as $$
  select s.id, s.event_type, s.source_id, s.pillar, s.subnode_id, s.text, s.metadata, s.created_at,
         1 - (s.embedding <=> query_embedding) as similarity
  from public.venture_substrate s
  where s.user_id = filter_user_id
    and s.venture_id = filter_venture_id
    and (filter_pillar is null or s.pillar = filter_pillar)
    and (filter_subnode_id is null or s.subnode_id = filter_subnode_id)
    and (filter_event_type is null or s.event_type = filter_event_type)
  order by s.embedding <=> query_embedding
  limit match_count
$$;
revoke all on function public.match_venture_substrate(vector, text, text, int, text, text, text) from public, anon, authenticated;

-- ── API tenancy: workspaces + keys ────────────────────────────────────────────
create table if not exists public.workspaces (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name          text not null default 'default',
  created_at    timestamptz not null default now()
);
create index if not exists workspaces_owner_idx on public.workspaces (owner_user_id);
alter table public.workspaces enable row level security;

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key_hash     text not null unique,
  prefix       text,
  scopes       text[] not null default '{read}',
  space_ids    text[],
  label        text,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists api_keys_workspace_idx on public.api_keys (workspace_id);
alter table public.api_keys enable row level security;

-- ── metering ──────────────────────────────────────────────────────────────────
create table if not exists public.usage_events (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  surface    text not null,
  event_type text not null default 'call',
  amount     int not null default 1,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_user_time_idx on public.usage_events (user_id, created_at desc);
create index if not exists usage_events_user_surface_time_idx on public.usage_events (user_id, surface, created_at desc);
alter table public.usage_events enable row level security;

-- ── request logs (cloud: no local filesystem) ────────────────────────────────
create table if not exists public.request_logs (
  id           bigserial primary key,
  ts           timestamptz not null default now(),
  workspace_id uuid,
  key_prefix   text,
  method       text,
  path         text,
  status       int,
  ms           int
);
create index if not exists request_logs_ws_ts_idx on public.request_logs (workspace_id, ts desc);
alter table public.request_logs enable row level security;
