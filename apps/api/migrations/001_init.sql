-- 001_init: core tables for the QA platform.
-- Every customer-owned table carries org_id; 002_rls.sql makes Postgres enforce it.

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);
create unique index users_email_lower on users (lower(email));

create table refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table orgs (
  id          uuid primary key,
  name        text not null,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table memberships (
  org_id      uuid not null references orgs(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'developer', 'viewer')),
  -- null = all clients; otherwise the member only sees projects of these clients
  client_ids  uuid[],
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user on memberships (user_id);

create table invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  email        text not null,
  role         text not null check (role in ('admin', 'developer', 'viewer')),
  client_ids   uuid[],
  token_hash   text not null,
  invited_by   uuid references users(id) on delete set null,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index invites_org on invites (org_id);

-- An agency's customer. A SaaS team usually has exactly one.
create table clients (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);
create unique index clients_org_name on clients (org_id, lower(name));

create table projects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  client_id   uuid references clients(id) on delete restrict,
  name        text not null,
  repo_url    text,
  stack       text not null default 'node-express',
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index projects_org on projects (org_id);
create index projects_client on projects (client_id);

create table environments (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete cascade,
  project_id          uuid not null references projects(id) on delete cascade,
  name                text not null,
  api_base_url        text,
  web_apps            jsonb not null default '[]'::jsonb,
  -- true = throwaway database, write tests allowed; false = shared, read-only probes only
  disposable          boolean not null default false,
  domain              text,
  verification_token  text not null,
  verified_at         timestamptz,
  created_at          timestamptz not null default now()
);
create index environments_project on environments (project_id);
create unique index environments_project_name on environments (project_id, lower(name));

-- Test-account secrets. The secret is envelope-encrypted (see src/lib/vault.ts) and never returned by the API.
create table credentials (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  environment_id  uuid not null references environments(id) on delete cascade,
  name            text not null,
  role            text not null,
  identifier      text not null,
  device          text,
  secret_blob     text not null,
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index credentials_env_name on credentials (environment_id, name);

create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  project_id    uuid not null references projects(id) on delete cascade,
  name          text not null,
  prefix        text not null,
  key_hash      text not null unique,
  created_by    uuid references users(id) on delete set null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index api_keys_project on api_keys (project_id);

create table runs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  project_id        uuid not null references projects(id) on delete cascade,
  environment_id    uuid references environments(id) on delete set null,
  api_key_id        uuid references api_keys(id) on delete set null,
  suite             text not null,
  source            text not null,
  status            text not null check (status in ('passed', 'failed', 'env_error')),
  target            text,
  started_at        timestamptz not null,
  duration_ms       integer not null,
  routes_total      integer not null,
  routes_selected   integer not null,
  selection_reason  text not null,
  full_coverage     boolean not null,
  requests          integer not null,
  gate_fail_on      text not null,
  blocking          integer not null,
  new_issues        integer not null default 0,
  fixed_issues      integer not null default 0,
  env_error         text,
  git               jsonb,
  created_at        timestamptz not null default now()
);
create index runs_project_created on runs (project_id, created_at desc);

create table plugin_results (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  run_id         uuid not null references runs(id) on delete cascade,
  plugin         text not null,
  status         text not null,
  reason         text,
  duration_ms    integer not null,
  stats          jsonb,
  finding_count  integer not null
);
create index plugin_results_run on plugin_results (run_id);

-- One issue per (project, fingerprint) across all runs; findings are its per-run occurrences.
create table issues (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete cascade,
  project_id          uuid not null references projects(id) on delete cascade,
  fingerprint         text not null,
  plugin              text not null,
  severity            text not null,
  category            text not null,
  title               text not null,
  target              text not null,
  status              text not null default 'open' check (status in ('open', 'known', 'ignored', 'fixed')),
  status_reason       text,
  status_until        date,
  assignee_id         uuid references users(id) on delete set null,
  first_seen_run_id   uuid references runs(id) on delete set null,
  last_seen_run_id    uuid references runs(id) on delete set null,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  occurrences         integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index issues_project_fp on issues (project_id, fingerprint);
create index issues_project_status on issues (project_id, status);

create table findings (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  run_id       uuid not null references runs(id) on delete cascade,
  issue_id     uuid references issues(id) on delete set null,
  plugin       text not null,
  severity     text not null,
  category     text not null,
  title        text not null,
  detail       text,
  target       text not null,
  fingerprint  text not null,
  evidence     jsonb,
  known        boolean not null default false
);
create index findings_run on findings (run_id);

create table audit_events (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  actor_user_id     uuid references users(id) on delete set null,
  actor_api_key_id  uuid references api_keys(id) on delete set null,
  action            text not null,
  entity_type       text not null,
  entity_id         uuid,
  data              jsonb,
  created_at        timestamptz not null default now()
);
create index audit_org_created on audit_events (org_id, created_at desc);
