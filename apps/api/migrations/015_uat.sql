-- User acceptance testing: a release is a set of acceptance criteria that business users
-- test and an owner/admin signs off. A decided release is locked until it is reopened.
create table uat_releases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  description text check (description is null or length(description) <= 4000),
  status text not null default 'open' check (status in ('open', 'signed_off', 'rejected')),
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 2000),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'open') = (decided_at is null))
);
create unique index uat_releases_name on uat_releases (project_id, lower(name));
create index uat_releases_project on uat_releases (project_id, created_at desc);

create table uat_criteria (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  release_id uuid not null references uat_releases(id) on delete cascade,
  position integer not null check (position >= 1),
  title text not null check (length(title) between 1 and 300),
  steps text check (steps is null or length(steps) <= 4000),
  scenario text check (scenario is null or length(scenario) <= 200),
  status text not null default 'untested' check (status in ('untested', 'passed', 'failed', 'blocked')),
  note text check (note is null or length(note) <= 2000),
  evidence_run_id uuid references runs(id) on delete set null,
  tested_by uuid references users(id) on delete set null,
  tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'untested') = (tested_at is null))
);
create index uat_criteria_release on uat_criteria (release_id, position);

do $$ declare t text; begin
  foreach t in array array['uat_releases', 'uat_criteria'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy org_isolation on %I using (org_id = app_org()) with check (org_id = app_org())', t);
    execute format('grant select, insert, update, delete on %I to qa_app', t);
  end loop;
end $$;
