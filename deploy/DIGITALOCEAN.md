# VeriQ on one DigitalOcean Droplet (domain on Cloudflare)

The current setup: the whole platform (dashboard, API, PostgreSQL, hosted runner) runs on one
Droplet with `docker-compose.yml`, at a subdomain of a domain managed in Cloudflare, e.g.
`veriq.tmhdigital.com`. Moving to another domain later changes one DNS record and one line
of `.env` (see the end).

```
Browser / GitHub Actions ──► veriq.tmhdigital.com (Cloudflare DNS)
                                   │
                    Droplet: caddy :443 ──► dashboard (nginx: app + /api) ──► api ──► postgres
                                                                               ▲
                                                                 runner ───────┘
```

Not used by this setup: Supabase (`.env.supabase.example`, `SETUP-GUIDE.md`), Cloudflare
Pages (`CLOUDFLARE.md`, `docker-compose.api.yml`), Render.

## 1. Code and the `v1` tag (on your computer)

```bash
git push
git tag v1 && git push origin v1   # CI workflows use the action at @v1
```

## 2. Droplet

DigitalOcean → Create → Droplets:

| Setting | Value |
|---|---|
| Region | Singapore (SGP1) or Bangalore (BLR1) |
| Image | Ubuntu 24.04 (LTS) x64 |
| Size | Basic, Regular, 4 GB RAM / 2 vCPU (the runner starts Chromium) |
| Authentication | SSH key (`ssh-keygen -t ed25519 -f ~/.ssh/veriq_do`) |
| Backups | Weekly backups on |
| Monitoring | On |

## 3. Cloud Firewall

Networking → Firewalls → Create: inbound SSH 22 (your IP if it is fixed), HTTP 80 and HTTPS
443 from all IPv4 and IPv6; apply it to the Droplet. Use this firewall rather than `ufw` on the
Droplet: Docker opens published ports past `ufw`.

## 4. DNS

Cloudflare → your domain → DNS → Add record: `A`, name `veriq`, the Droplet's IPv4,
**DNS only (grey cloud)**. Caddy needs that to get its Let's Encrypt certificate. Step 9
turns the orange cloud on later.

## 5. Prepare the Droplet

```bash
ssh -i ~/.ssh/veriq_do root@DROPLET_IP
adduser veriq && usermod -aG sudo veriq && rsync --archive --chown=veriq:veriq ~/.ssh /home/veriq
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
apt update && apt -y upgrade
```

Log in as `veriq` in a new terminal; when that works, turn off root and password logins:

```bash
sudo tee /etc/ssh/sshd_config.d/99-veriq.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
EOF
sudo systemctl restart ssh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker veriq && newgrp docker
```

## 6. Code and `deploy/.env`

```bash
git clone https://github.com/Irfan-Haider05-spec/QA-Automation.git ~/qa-agent
cd ~/qa-agent/deploy && cp .env.example .env && chmod 600 .env && nano .env
```

| Variable | Value |
|---|---|
| `DOMAIN` | `veriq.tmhdigital.com` |
| `OPERATOR_NAME`, `CONTACT_EMAIL` | shown on the terms and privacy pages |
| `POSTGRES_PASSWORD`, `QA_APP_PASSWORD` | `openssl rand -base64 24 \| tr -d '/+='` (each separately) |
| `JWT_SECRET`, `RUNNER_TOKEN` | `openssl rand -hex 32` (each separately) |
| `VAULT_MASTER_KEY` | `openssl rand -base64 32`; keep a copy in a password manager |
| `SIGNUP_MODE` | `invite` |
| `SMTP_URL`, `MAIL_FROM` | optional; without them reset links go to the API log |
| `API_DOMAIN`, `DASHBOARD_URL` | leave empty (they are for `docker-compose.api.yml`) |

Add at the end, so the hosted runner always starts with the stack:

```
COMPOSE_PROFILES=hosted
```

## 7. Start

```bash
docker compose up -d --build        # the first build takes 10-15 minutes
docker compose ps                   # migrate: Exited (0); the rest running / healthy
curl -s https://veriq.tmhdigital.com/health
```

Open the address and sign up straight away: the first account owns the platform, everyone
else joins by invite.

## 8. Backups

```bash
mkdir -p ~/backups && crontab -e
15 2 * * * cd /home/veriq/qa-agent/deploy && docker compose exec -T postgres pg_dump -U qa_owner -Fc qa_platform > /home/veriq/backups/veriq-$(date +\%F).dump && find /home/veriq/backups -name 'veriq-*.dump' -mtime +14 -delete
```

Copy a dump off the Droplet regularly. Restore and upgrade steps: [`README.md`](README.md).

## 9. Optional: Cloudflare proxy (orange cloud)

1. Cloudflare → SSL/TLS → Origin Server → Create Certificate (RSA 2048, hostname
   `veriq.tmhdigital.com`, 15 years).
2. On the Droplet, save the certificate as `certs/cloudflare-origin.pem` and the private key
   as `certs/cloudflare-origin.key`, then:
   ```bash
   chmod 600 certs/cloudflare-origin.*
   echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.cloudflare.yml' >> .env
   docker compose up -d
   ```
3. Cloudflare → SSL/TLS → Overview → **Full (strict)** (never *Flexible*).
4. Switch the `veriq` DNS record to **Proxied**.
5. Optionally allow 80/443 in the Cloud Firewall only from [Cloudflare's ranges](https://www.cloudflare.com/ips/).

`docker-compose.cloudflare.yml` gives Caddy the origin certificate (`Caddyfile.cloudflare`),
trusts Cloudflare's published address ranges so the visitor's address reaches the API, and
sets `TRUST_PROXY=3` (Cloudflare → caddy → nginx → api). Without it, rate limits would see
every visitor as one of a few Cloudflare addresses. If Cloudflare adds ranges
(https://www.cloudflare.com/ips/), update the list in `Caddyfile.cloudflare`.

## Moving to another domain later

1. Add the new domain to Cloudflare and an `A` record to the same Droplet IP (grey first).
2. With the orange-cloud add-on: create an origin certificate for the new hostname and
   replace the two files in `certs/`.
3. `.env`: `DOMAIN=<new address>` (and `OPERATOR_NAME` if the name changes), then
   `docker compose up -d` (`docker compose up -d --build dashboard` after an
   `OPERATOR_NAME` / `CONTACT_EMAIL` change: they are built into the dashboard).
4. Update `QA_PLATFORM_URL` in every project's GitHub variables; redirect the old address
   with a Cloudflare redirect rule for a while.

The database, API keys, the vault, `RUNNER_TOKEN` and test accounts stay as they are; people
sign in again once on the new address.
