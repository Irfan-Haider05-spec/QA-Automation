create table issue_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  issue_id uuid not null references issues(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  body text not null check(length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index issue_comments_page on issue_comments(issue_id, created_at, id);
create table issue_integrations (
  project_id uuid primary key references projects(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  destination text not null,
  enabled boolean not null default true
);
create table issue_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  issue_id uuid not null references issues(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  destination text not null,
  payload jsonb not null,
  status text not null default 'queued' check(status in ('queued','sending','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  remote_url text,
  last_error text,
  created_at timestamptz not null default now()
);
create unique index one_pending_issue_sync on issue_sync_jobs(issue_id) where status in ('queued','sending');
do $$ declare t text; begin
  foreach t in array array['issue_comments','issue_integrations','issue_sync_jobs'] loop
    execute format('alter table %I enable row level security',t);
    execute format('create policy org_isolation on %I using (org_id = app_org()) with check (org_id = app_org())',t);
    execute format('grant select, insert, update, delete on %I to qa_app',t);
  end loop;
end $$;
create function qa_claim_issue_sync(p_limit int) returns setof issue_sync_jobs
language plpgsql security definer set search_path = public as $$
begin
  update issue_sync_jobs set status = 'failed', last_error = 'Delivery attempts exhausted' where status in ('queued','sending') and attempts >= 5 and next_attempt_at <= now();
  return query update issue_sync_jobs j set status = 'sending', attempts = j.attempts + 1, next_attempt_at = now() + interval '2 minutes'
    where j.id in (select id from issue_sync_jobs where status in ('queued','sending') and attempts < 5 and next_attempt_at <= now() order by created_at for update skip locked limit least(greatest(p_limit,1),20)) returning j.*;
end $$;
revoke all on function qa_claim_issue_sync(int) from public;
grant execute on function qa_claim_issue_sync(int) to qa_app;
