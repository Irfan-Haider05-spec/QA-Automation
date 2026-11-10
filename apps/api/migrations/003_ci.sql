-- 003_ci: CI integration (GitHub Action, PR checks, deploy tracking).
--
-- * API key scopes: every key can upload runs; a key may also read test-account
--   passwords so a CI runner gets them from the vault instead of duplicating them
--   as CI secrets. Only owners/admins can create such keys.
-- * deployments: a CI pipeline reports "version X is now live on staging"; the run
--   that follows is linked to it, so the dashboard shows which deploy broke what.
-- * runs.trigger_type: why the run happened (PR, push, deploy, schedule, manual).

alter table api_keys add column scopes text[] not null default array['runs:write'];
alter table api_keys add constraint api_keys_scopes_valid
  check (scopes <@ array['runs:write', 'credentials:read']::text[] and 'runs:write' = any(scopes));

create table deployments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  environment_id  uuid references environments(id) on delete set null,
  api_key_id      uuid references api_keys(id) on delete set null,
  sha             text,
  ref             text,
  version         text,
  url             text,
  description     text,
  source          text not null default 'ci',
  created_at      timestamptz not null default now()
);
create index deployments_project_created on deployments (project_id, created_at desc);
alter table deployments enable row level security;
create policy deployments_org_isolation on deployments using (org_id = app_org()) with check (org_id = app_org());

alter table runs
  add column trigger_type text check (trigger_type in ('pr', 'push', 'deploy', 'schedule', 'manual')),
  add column deployment_id uuid references deployments(id) on delete set null;
create index runs_deployment on runs (deployment_id);

-- The API-key lookup now also returns the key's scopes (return type changes → drop first)
drop function if exists qa_resolve_api_key(text);
create function qa_resolve_api_key(p_hash text)
  returns table (api_key_id uuid, org_id uuid, project_id uuid, scopes text[])
  language sql stable security definer set search_path = public as $$
    select k.id, k.org_id, k.project_id, k.scopes from api_keys k where k.key_hash = p_hash and k.revoked_at is null
  $$;
revoke all on function qa_resolve_api_key(text) from public;
grant execute on function qa_resolve_api_key(text) to qa_app;
