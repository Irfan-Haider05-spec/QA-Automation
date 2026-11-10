-- Account recovery and verified email addresses.
alter table users add column email_verified_at timestamptz;

-- One-time links sent by email. Only the hash is stored; a link works once and expires.
create table account_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  purpose     text not null check (purpose in ('password_reset', 'email_verify')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index account_tokens_user on account_tokens (user_id, purpose, created_at);
-- Global table like users: access is controlled in application code (grants come from 002's default privileges)

-- Why a refresh token stopped working. Only a token that was already exchanged ('rotated')
-- coming back means it was copied; a logged-out or password-changed one is just stale.
alter table refresh_tokens add column revoke_reason text check (revoke_reason in ('rotated', 'reuse', 'logout', 'password', 'reset'));
