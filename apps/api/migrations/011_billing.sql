create table subscriptions (
  org_id uuid primary key references orgs(id) on delete cascade,
  plan_id text not null,
  status text not null check(status in ('active','trialing','past_due','cancelled')),
  sequence bigint not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  updated_at timestamptz not null default now()
);
create table billing_events (
  id text primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  payload_hash text not null,
  sequence bigint not null,
  received_at timestamptz not null default now()
);
create table usage_months (
  org_id uuid not null references orgs(id) on delete cascade,
  month date not null,
  runs integer not null default 0,
  hosted_ms bigint not null default 0,
  primary key(org_id, month)
);
create table billing_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  plan_id text not null,
  request_key text not null,
  created_at timestamptz not null default now(),
  unique(org_id,request_key)
);
do $$ declare t text; begin
  foreach t in array array['subscriptions','billing_events','usage_months','billing_requests'] loop
    execute format('alter table %I enable row level security',t);
    execute format('create policy org_isolation on %I using (org_id = app_org()) with check (org_id = app_org())',t);
    execute format('grant select, insert, update, delete on %I to qa_app',t);
  end loop;
end $$;
