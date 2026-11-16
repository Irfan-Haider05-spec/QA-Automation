create table artifacts (
  id uuid primary key default gen_random_uuid(),
  -- Keep the object key as a cleanup tombstone when its owner/run is deleted.
  -- No org foreign key: cleanup still scopes by this immutable org id.
  org_id uuid not null,
  project_id uuid references projects(id) on delete set null,
  run_id uuid references runs(id) on delete set null,
  name text not null,
  object_key text not null unique,
  sha256 text not null,
  size_bytes integer not null check (size_bytes between 1 and 5242880),
  state text not null default 'pending' check (state in ('pending','ready')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (run_id, name)
);
alter table artifacts enable row level security;
create policy artifacts_org_isolation on artifacts using (org_id = app_org()) with check (org_id = app_org());
grant select, insert, update, delete on artifacts to qa_app;
create index artifacts_expiry on artifacts(expires_at);

create function qa_expired_artifacts(p_limit int) returns table(id uuid, org_id uuid, object_key text)
language sql security definer set search_path = public as $$
  select a.id, a.org_id, a.object_key from artifacts a
  where (a.expires_at <= now() or a.run_id is null)
    -- A run may be deleted while S3 is still accepting its upload. Do not
    -- remove that cleanup record until the bounded upload has settled.
    and (a.state = 'ready' or a.expires_at <= now() or a.created_at < now() - interval '5 minutes')
  order by a.expires_at limit least(greatest(p_limit, 0), 100)
$$;
revoke all on function qa_expired_artifacts(int) from public;
grant execute on function qa_expired_artifacts(int) to qa_app;
