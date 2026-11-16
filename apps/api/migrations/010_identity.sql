alter table users add column auth_version integer not null default 0;

create table user_mfa (
  user_id uuid primary key references users(id) on delete cascade,
  secret_enc text not null,
  enabled boolean not null default false,
  setup_expires_at timestamptz not null default now() + interval '10 minutes',
  last_step bigint not null default -1,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  recovery_hashes jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create table login_challenges (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  auth_version integer not null,
  attempts integer not null default 0,
  expires_at timestamptz not null default now() + interval '5 minutes'
);
create index login_challenges_expiry on login_challenges(expires_at);
create table sso_identities (
  issuer text not null,
  subject text not null,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (issuer, subject), unique (issuer, user_id)
);
create table sso_transactions (
  state_hash text primary key,
  browser_hash text not null,
  verifier_enc text not null,
  nonce text not null,
  user_id uuid references users(id) on delete cascade,
  auth_version integer,
  expires_at timestamptz not null default now() + interval '5 minutes'
);
-- Identity tables are global, like users. Only the API role may access them.
grant select, insert, update, delete on user_mfa, login_challenges, sso_identities, sso_transactions to qa_app;
