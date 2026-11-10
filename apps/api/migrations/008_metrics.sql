-- Platform-wide counts for /metrics. The app role can't see across organizations,
-- so this definer function returns only aggregate numbers, never rows.
create or replace function qa_platform_stats()
returns table (metric text, label text, value bigint)
language sql security definer set search_path = public stable as $$
  select 'jobs', status, count(*) from run_jobs group by status
  union all
  select 'deliveries', status, count(*) from notification_deliveries group by status
  union all
  select 'orgs', '', count(*) from orgs
  union all
  select 'users', '', count(*) from users
  union all
  select 'runs_24h', '', count(*) from runs where created_at > now() - interval '24 hours'
$$;
revoke all on function qa_platform_stats() from public;
grant execute on function qa_platform_stats() to qa_app;
