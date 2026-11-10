-- Runs once when the Docker volume is created. Migrations (002_rls.sql) grant this role its table access.
-- Development password only; production creates qa_app with a generated password.
create role qa_app login password 'qa_app_dev_only' nosuperuser nocreatedb nocreaterole;
grant connect on database qa_platform to qa_app;
