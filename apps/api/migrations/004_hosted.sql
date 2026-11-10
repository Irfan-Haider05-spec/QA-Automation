-- 004_hosted: the platform runs tests itself (hosted runner) on demand and on schedules.
--
-- * project_profiles: latest route list + non-secret config from a CI run that read
--   the source. Hosted runs work from it, never from customer code.
-- * run_jobs: a queue. "Run now" and schedules add jobs; hosted runners claim them,
--   send heartbeats and report the finished run. At most one running job per
--   environment, because test accounts usually allow one session at a time.
-- * schedules: cron + time zone per environment and suite; next_run_at is
--   computed by the API (cron parsing happens in JS).

create table project_profiles (
  project_id   uuid primary key references projects(id) on delete cascade,
  org_id       uuid not null references orgs(id) on delete cascade,
  profile      jsonb not null,
  routes_count int not null,
  git          jsonb,
  api_key_id   uuid references api_keys(id) on delete set null,
  uploaded_at  timestamptz not null default now()
);
alter table project_profiles enable row level security;
create policy project_profiles_org_isolation on project_profiles using (org_id = app_org()) with check (org_id = app_org());

create table schedules (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  environment_id  uuid not null references environments(id) on delete cascade,
  suite           text not null check (suite in ('staging', 'nightly')),
  cron            text not null,
  timezone        text not null default 'UTC',
  enabled         boolean not null default true,
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  last_job_id     uuid,
  last_error      text,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index schedules_due on schedules (next_run_at) where enabled;
alter table schedules enable row level security;
create policy schedules_org_isolation on schedules using (org_id = app_org()) with check (org_id = app_org());

create table run_jobs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id) on delete cascade,
  project_id       uuid not null references projects(id) on delete cascade,
  environment_id   uuid not null references environments(id) on delete cascade,
  schedule_id      uuid references schedules(id) on delete set null,
  suite            text not null check (suite in ('staging', 'nightly')),
  trigger_type     text not null check (trigger_type in ('manual', 'schedule', 'deploy')),
  status           text not null default 'queued' check (status in ('queued', 'running', 'done', 'cancelled', 'error')),
  cancel_requested boolean not null default false,
  requested_by     uuid references users(id) on delete set null,
  runner_id        text,
  attempts         int not null default 0,
  claimed_at       timestamptz,
  heartbeat_at     timestamptz,
  finished_at      timestamptz,
  run_id           uuid references runs(id) on delete set null,
  error            text,
  created_at       timestamptz not null default now()
);
create index run_jobs_queue on run_jobs (status, created_at);
create index run_jobs_project on run_jobs (project_id, created_at desc);
-- The database itself refuses a second running job on one environment
create unique index run_jobs_one_running_per_env on run_jobs (environment_id) where status = 'running';
alter table run_jobs enable row level security;
create policy run_jobs_org_isolation on run_jobs using (org_id = app_org()) with check (org_id = app_org());

alter table schedules add constraint schedules_last_job_fk foreign key (last_job_id) references run_jobs(id) on delete set null;

-- ── Cross-organization work for runners and the scheduler (security definer) ──

-- Hand the oldest runnable job to a runner: its environment is verified and has
-- no running job. Claims are serialized so two runners can't race to one environment.
create function qa_claim_job(p_runner text) returns setof run_jobs
  language plpgsql security definer set search_path = public as $$
  begin
    perform pg_advisory_xact_lock(hashtext('qa_claim_job'));
    return query
      update run_jobs j set status = 'running', runner_id = p_runner, claimed_at = now(), heartbeat_at = now(), attempts = j.attempts + 1
      where j.id = (
        select q.id from run_jobs q join environments e on e.id = q.environment_id
        where q.status = 'queued' and not q.cancel_requested and e.verified_at is not null
          and not exists (select 1 from run_jobs r where r.environment_id = q.environment_id and r.status = 'running')
        order by q.created_at
        limit 1
        for update of q skip locked
      )
      returning j.*;
  end $$;

-- The org a job belongs to, for a runner that holds its id (runners act inside that org afterwards)
create function qa_job_org(p_job uuid, p_runner text) returns uuid
  language sql stable security definer set search_path = public as $$
    select org_id from run_jobs where id = p_job and runner_id = p_runner
  $$;

-- Housekeeping: jobs whose runner went silent are retried once, then failed;
-- cancelled queued jobs are closed; queued jobs on environments that lost
-- their verification fail with a reason instead of waiting forever.
create function qa_maintain_jobs(p_stale_seconds int) returns table (requeued int, failed int, cancelled int)
  language plpgsql security definer set search_path = public as $$
  declare r int; f int; c int; u int;
  begin
    update run_jobs set status = 'queued', runner_id = null, claimed_at = null, heartbeat_at = null
      where status = 'running' and heartbeat_at < now() - make_interval(secs => p_stale_seconds) and attempts < 2 and not cancel_requested;
    get diagnostics r = row_count;
    update run_jobs set status = 'error', finished_at = now(), error = 'The runner stopped responding'
      where status = 'running' and heartbeat_at < now() - make_interval(secs => p_stale_seconds);
    get diagnostics f = row_count;
    update run_jobs set status = 'cancelled', finished_at = now() where status = 'queued' and cancel_requested;
    get diagnostics c = row_count;
    update run_jobs j set status = 'error', finished_at = now(), error = 'The environment''s domain is no longer verified'
      from environments e where e.id = j.environment_id and j.status = 'queued' and e.verified_at is null;
    get diagnostics u = row_count;
    return query select r, f + u, c;
  end $$;

create function qa_due_schedules(p_limit int) returns table (id uuid, org_id uuid, cron text, timezone text, next_run_at timestamptz)
  language sql stable security definer set search_path = public as $$
    select s.id, s.org_id, s.cron, s.timezone, s.next_run_at from schedules s
    where s.enabled and s.next_run_at <= now() order by s.next_run_at limit p_limit
  $$;

revoke all on function qa_claim_job(text), qa_job_org(uuid, text), qa_maintain_jobs(int), qa_due_schedules(int) from public;
grant execute on function qa_claim_job(text), qa_job_org(uuid, text), qa_maintain_jobs(int), qa_due_schedules(int) to qa_app;
