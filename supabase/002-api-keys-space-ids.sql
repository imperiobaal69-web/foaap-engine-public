-- Engine API hardening: per-key space restriction (spec §2).
-- NULL = key sees every space in its workspace (default, back-compat).
-- Non-empty array = key can ONLY touch those venture_ids; other spaces 404.
alter table public.api_keys
  add column if not exists space_ids text[];
