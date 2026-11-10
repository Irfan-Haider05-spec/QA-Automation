-- Run ONCE in Supabase → SQL Editor (as the default "postgres" user).
-- Replace both passwords first (letters and numbers only, 24+ characters).
-- qa_owner creates and changes the tables (migrations); qa_app is what the API logs in as:
-- it can only read/write rows, and row-level security keeps each organization's data apart.

create role qa_owner login password 'CHANGE_ME_OWNER_PASSWORD';
create role qa_app   login password 'CHANGE_ME_APP_PASSWORD';

grant usage, create on schema public to qa_owner;
grant usage on schema public to qa_app;

-- check: both rows should show up
select rolname, rolcanlogin from pg_roles where rolname in ('qa_owner', 'qa_app');
