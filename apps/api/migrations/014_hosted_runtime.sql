-- Preserve server-measured runtime across hosted runner retries. A requeued
-- attempt loses claimed_at, so its elapsed time must be accumulated first.
alter table run_jobs add column runtime_ms bigint not null default 0 check (runtime_ms >= 0);

create or replace function qa_maintain_jobs(p_stale_seconds int) returns table (requeued int, failed int, cancelled int)
  language plpgsql security definer set search_path = public as $$
  declare r int; f int; c int; u int;
  begin
    update run_jobs set
      runtime_ms = runtime_ms + greatest(0, floor(extract(epoch from now() - claimed_at) * 1000)::bigint),
      status = 'queued', runner_id = null, claimed_at = null, heartbeat_at = null
      where status = 'running' and heartbeat_at < now() - make_interval(secs => p_stale_seconds) and attempts < 2 and not cancel_requested;
    get diagnostics r = row_count;
    update run_jobs set
      runtime_ms = runtime_ms + greatest(0, floor(extract(epoch from now() - claimed_at) * 1000)::bigint),
      status = 'error', finished_at = now(), error = 'The runner stopped responding', runner_id = null, claimed_at = null, heartbeat_at = null
      where status = 'running' and heartbeat_at < now() - make_interval(secs => p_stale_seconds);
    get diagnostics f = row_count;
    update run_jobs set status = 'cancelled', finished_at = now() where status = 'queued' and cancel_requested;
    get diagnostics c = row_count;
    update run_jobs j set status = 'error', finished_at = now(), error = 'The environment''s domain is no longer verified'
      from environments e where e.id = j.environment_id and j.status = 'queued' and e.verified_at is null;
    get diagnostics u = row_count;
    return query select r, f + u, c;
  end $$;
