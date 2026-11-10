-- 002_rls: row-level security, the second wall between customers.
-- The API runs every request as role qa_app with app.org_id / app.user_id set for
-- that transaction (src/db/index.ts → withContext). Postgres then only returns and
-- accepts rows of that organization, even if application code forgets a filter.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'qa_app') then
    create role qa_app nologin;
  end if;
end
$$;

create or replace function app_org() returns uuid
  language sql stable as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;
create or replace function app_user() returns uuid
  language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

grant usage on schema public to qa_app;
grant select, insert, update, delete on all tables in schema public to qa_app;
-- Tables added by later migrations get the same grants automatically
alter default privileges in schema public grant select, insert, update, delete on tables to qa_app;
grant execute on function app_org(), app_user() to qa_app;

-- Global tables (no org): users, refresh_tokens. Access is controlled in application code.

-- memberships: visible inside the current org, or your own memberships across orgs (for "my orgs")
alter table memberships enable row level security;
create policy memberships_access on memberships
  using (org_id = app_org() or user_id = app_user())
  with check (org_id = app_org());

-- orgs: the current org, or any org you are a member of
alter table orgs enable row level security;
create policy orgs_select on orgs for select
  using (id = app_org() or exists (select 1 from memberships m where m.org_id = orgs.id and m.user_id = app_user()));
create policy orgs_insert on orgs for insert with check (id = app_org());
create policy orgs_update on orgs for update using (id = app_org()) with check (id = app_org());
create policy orgs_delete on orgs for delete using (id = app_org());

-- Every other customer table: strictly the current org
do $$
declare t text;
begin
  foreach t in array array['invites', 'clients', 'projects', 'environments', 'credentials', 'api_keys',
                           'runs', 'plugin_results', 'issues', 'findings', 'audit_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I using (org_id = app_org()) with check (org_id = app_org())', t || '_org_isolation', t);
  end loop;
end
$$;

-- Runner authentication happens before the org is known, so the API-key lookup is
-- a narrow SECURITY DEFINER function (owned by the migration user, bypasses RLS)
-- that returns only the ids needed to set the org context.
create or replace function qa_resolve_api_key(p_hash text)
  returns table (api_key_id uuid, org_id uuid, project_id uuid)
  language sql stable security definer set search_path = public as $$
    select k.id, k.org_id, k.project_id from api_keys k where k.key_hash = p_hash and k.revoked_at is null
  $$;
revoke all on function qa_resolve_api_key(text) from public;
grant execute on function qa_resolve_api_key(text) to qa_app;
