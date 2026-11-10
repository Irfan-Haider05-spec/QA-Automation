-- 005_notify_reports: notifications (Slack, email, webhooks) and shareable client reports.
--
-- * notification_channels: where to send what. Slack/webhook URLs (and the
--   webhook signing secret) are encrypted with the vault, like test-account passwords.
-- * notification_deliveries: a transactional outbox. Runs enqueue messages in the
--   same transaction that stores them; a dispatcher sends and retries with backoff.
-- * report_shares: a frozen report snapshot behind an expiring, revocable link a
--   software house can send to its client. Only the token's hash is stored.
-- * issues.fixed_at / reopened_at: exact dates for "fixed this month" in reports.

alter table issues add column fixed_at timestamptz, add column reopened_at timestamptz;
update issues set fixed_at = updated_at where status = 'fixed';

create table notification_channels (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  name              text not null,
  kind              text not null check (kind in ('slack', 'email', 'webhook')),
  recipients        text[],                 -- email only; not secret
  secret_blob       text,                   -- slack/webhook: vault-encrypted JSON { url, signingSecret? }
  target_hint       text,                   -- shown in the UI instead of the secret, e.g. "hooks.slack.com/…/a1B2"
  events            text[] not null,
  project_ids       uuid[],                 -- null = all projects
  include_local     boolean not null default false,
  enabled           boolean not null default true,
  last_delivery_at  timestamptz,
  last_error        text,
  created_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint notification_channels_events_valid check (
    cardinality(events) > 0 and events <@ array['run.failed', 'run.recovered', 'run.env_error', 'issue.regression', 'job.error']::text[]
  ),
  constraint notification_channels_target check (
    (kind = 'email' and cardinality(recipients) between 1 and 20) or (kind <> 'email' and secret_blob is not null)
  )
);
alter table notification_channels enable row level security;
create policy notification_channels_org_isolation on notification_channels using (org_id = app_org()) with check (org_id = app_org());

create table notification_deliveries (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id) on delete cascade,
  channel_id       uuid not null references notification_channels(id) on delete cascade,
  event            text not null,
  payload          jsonb not null,
  status           text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  claimed_at       timestamptz,
  sent_at          timestamptz,
  last_error       text,
  created_at       timestamptz not null default now()
);
create index notification_deliveries_queue on notification_deliveries (status, next_attempt_at);
create index notification_deliveries_channel on notification_deliveries (channel_id, created_at desc);
alter table notification_deliveries enable row level security;
create policy notification_deliveries_org_isolation on notification_deliveries using (org_id = app_org()) with check (org_id = app_org());

create table report_shares (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  token_hash      text not null unique,
  scope_type      text not null check (scope_type in ('project', 'client')),
  scope_id        uuid not null,
  scope_name      text not null,
  period_from     date not null,
  period_to       date not null,
  snapshot        jsonb not null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  view_count      int not null default 0,
  last_viewed_at  timestamptz,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now()
);
alter table report_shares enable row level security;
create policy report_shares_org_isolation on report_shares using (org_id = app_org()) with check (org_id = app_org());

-- Dispatcher: take due deliveries across orgs (and deliveries stuck in "sending" after a crash)
create function qa_claim_deliveries(p_limit int) returns setof notification_deliveries
  language sql security definer set search_path = public as $$
    update notification_deliveries d set status = 'sending', claimed_at = now(), attempts = d.attempts + 1
    where d.id in (
      select q.id from notification_deliveries q
      where (q.status = 'queued' and q.next_attempt_at <= now()) or (q.status = 'sending' and q.claimed_at < now() - interval '5 minutes')
      order by q.created_at limit p_limit
      for update skip locked
    )
    returning d.*
  $$;

-- Public report links: the snapshot for a valid token, counting the view
create function qa_open_report(p_token_hash text) returns table (snapshot jsonb, scope_name text, expires_at timestamptz, created_at timestamptz)
  language sql security definer set search_path = public as $$
    update report_shares s set view_count = s.view_count + 1, last_viewed_at = now()
    where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now()
    returning s.snapshot, s.scope_name, s.expires_at, s.created_at
  $$;

revoke all on function qa_claim_deliveries(int), qa_open_report(text) from public;
grant execute on function qa_claim_deliveries(int), qa_open_report(text) to qa_app;
