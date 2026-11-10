#!/bin/sh
# Runs once, when the Postgres volume is created: the restricted role the API
# connects as. Its table rights come from the migrations (002_rls.sql).
set -e
psql -v ON_ERROR_STOP=1 -v app_pw="$QA_APP_PASSWORD" -v db="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
create role qa_app login password :'app_pw' nosuperuser nocreatedb nocreaterole;
grant connect on database :"db" to qa_app;
SQL
