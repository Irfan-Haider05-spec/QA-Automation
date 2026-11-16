-- Hosted runs may finish successfully while their evidence files are still
-- uploading. Keep that state visible and record failures without changing the
-- run's security result.
alter table runs add column evidence_status text not null default 'complete'
  check (evidence_status in ('pending', 'complete', 'failed'));
alter table runs add column evidence_error text;

-- A terminal hosted job is charged exactly once. This also lets the scheduler
-- account for jobs made terminal by its database-side stale-job maintenance.
alter table run_jobs add column usage_accounted_at timestamptz;
update run_jobs set usage_accounted_at = now() where status in ('done', 'cancelled', 'error');

create function qa_unaccounted_hosted_jobs(p_limit int)
returns table(id uuid, org_id uuid, claimed_at timestamptz, finished_at timestamptz)
language sql security definer set search_path = public as $$
  select j.id, j.org_id, j.claimed_at, j.finished_at from run_jobs j
  where j.status in ('cancelled', 'error') and j.usage_accounted_at is null and j.finished_at is not null
  order by j.finished_at limit least(greatest(p_limit, 0), 100)
$$;
revoke all on function qa_unaccounted_hosted_jobs(int) from public;
grant execute on function qa_unaccounted_hosted_jobs(int) to qa_app;
