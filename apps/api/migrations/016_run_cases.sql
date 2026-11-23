-- Named tests a run executed (API scenarios) with their outcome. UAT criteria that link a
-- scenario by name show its latest result here as automated evidence.
create table run_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  run_id uuid not null references runs(id) on delete cascade,
  plugin text not null check (length(plugin) between 1 and 100),
  name text not null check (length(name) between 1 and 200),
  status text not null check (status in ('passed', 'failed', 'skipped')),
  tags text[] not null default '{}',
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now()
);
create index run_cases_latest on run_cases (project_id, name, created_at desc);
create index run_cases_run on run_cases (run_id);

alter table run_cases enable row level security;
create policy org_isolation on run_cases using (org_id = app_org()) with check (org_id = app_org());
grant select, insert, update, delete on run_cases to qa_app;
