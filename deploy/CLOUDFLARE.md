# Dashboard on Cloudflare Pages, API on your own server

> **Step-by-step for beginners (with Supabase as the database): [`SETUP-GUIDE.md`](SETUP-GUIDE.md).**
> This page is the shorter variant where PostgreSQL also runs on your server (`docker-compose.api.yml`).

```
Browser ──► qa.example.com (Cloudflare Pages: the dashboard, static files)
   │
   └──── API calls ──► api.qa.example.com (your server: Caddy → API → PostgreSQL, + hosted runner)
                               ▲
GitHub Actions (QA runs) ──────┘
```

Why the split: the dashboard is static files, which Cloudflare Pages serves free and fast. The API
can't run on Pages/Workers or Vercel functions: it keeps database connections open, runs the
scheduler and the notification sender in the background all the time, and the hosted runner starts
Chromium for minutes at a time. Those need a normal server (a VM or a container host).

## Accounts you need

| Account | For | Cost |
|---|---|---|
| GitHub | the qa-agent code (Pages builds from it) and the MLITech workflow | free |
| Cloudflare | Pages (dashboard) and DNS for your domain | free plan |
| A server: Oracle Cloud (Always Free Ampere VM) or any VPS (Hetzner, DigitalOcean, Contabo…) | API, PostgreSQL, hosted runner | Oracle Always Free: $0 (needs a card for verification); a VPS: a few dollars a month |
| A domain | e.g. `qa.mlitech.com` and `api.qa.mlitech.com` (subdomains of a domain you already have work) | the domain you have |
| Email sending: Resend, Brevo, SendGrid or your mail server's SMTP | password reset, email confirmation, email alerts | free plans exist |
| Slack (optional) | alert channel (incoming webhook) | free |

Vercel instead of Cloudflare Pages works too (section at the end), but Vercel's free Hobby plan is
for personal, non-commercial use only; a company tool or a paid SaaS needs Vercel Pro.

## Step 1: Put the code on GitHub

```bash
cd F:\mlitech-qa-agent-v2\qa-agent
git init && git add . && git commit -m "QA platform"
git remote add origin https://github.com/tmhdigital/qa-agent.git
git push -u origin main
git tag v1 && git push --tags        # the MLITech workflow uses @v1
```

`.env` files are not in the repository; secrets go into the server's `.env` and the hosts' settings only.

## Step 2: The server (API + database + runner)

Example with Oracle Cloud; on another VPS skip to "Install Docker".

1. Oracle console → Compute → Instances → Create instance
   - Image: Ubuntu 24.04. Shape: Ampere `VM.Standard.A1.Flex`, 2 OCPU / 12 GB (the Always Free size).
   - Add your SSH public key. Create, note the public IP.
2. Open ports 80 and 443:
   - Networking → your VCN → Security list → Add ingress rules: source `0.0.0.0/0`, TCP, ports 80 and 443.
   - On the VM (Oracle's Ubuntu image also has its own firewall rules):
     ```bash
     sudo iptables -I INPUT 6 -p tcp --dport 80 -m state --state NEW -j ACCEPT
     sudo iptables -I INPUT 6 -p tcp --dport 443 -m state --state NEW -j ACCEPT
     sudo netfilter-persistent save
     ```
3. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   ```
4. DNS (Cloudflare → your domain → DNS): `A  api.qa  <server IP>`, **DNS only (grey cloud)** so Caddy
   can get its certificate. (Turning the orange cloud on later is fine: then set `TRUST_PROXY=2`.)
5. Get the code and configure:
   ```bash
   git clone https://github.com/tmhdigital/qa-agent.git && cd qa-agent/deploy
   cp .env.example .env && nano .env
   ```
   Fill in (generate each secret separately):

   | Variable | Value |
   |---|---|
   | `API_DOMAIN` | `api.qa.mlitech.com` |
   | `DASHBOARD_URL` | `https://qa.mlitech.com` (exactly the dashboard's address; it becomes the allowed CORS origin and the base of email links) |
   | `POSTGRES_PASSWORD`, `QA_APP_PASSWORD` | `openssl rand -base64 24 \| tr -d '/+='` |
   | `JWT_SECRET`, `RUNNER_TOKEN` | `openssl rand -hex 32` |
   | `VAULT_MASTER_KEY` | `openssl rand -base64 32` (**back it up**: it decrypts stored test-account passwords) |
   | `SIGNUP_MODE` | `invite` |
   | `SMTP_URL`, `MAIL_FROM` | from your email provider, e.g. `smtp://user:pass@smtp-relay.brevo.com:587` |
   | `METRICS_TOKEN` | optional, `openssl rand -hex 24` |

6. Start it:
   ```bash
   docker compose -f docker-compose.api.yml up -d --build
   docker compose -f docker-compose.api.yml --profile hosted up -d     # hosted runner + schedules
   docker compose -f docker-compose.api.yml ps                          # migrate exited (0), the rest running
   curl https://api.qa.mlitech.com/health                               # {"ok":true,...}
   ```

## Step 3: The dashboard on Cloudflare Pages

1. Cloudflare → Workers & Pages → Create → Pages → Connect to Git → pick `tmhdigital/qa-agent`.
2. Build settings:

   | Setting | Value |
   |---|---|
   | Framework preset | None |
   | Root directory | `/` (the repository root: the dashboard needs `packages/shared`) |
   | Build command | `npm ci && npm run build -w @qa/dashboard` |
   | Build output directory | `apps/dashboard/dist` |

3. Environment variables (Production):

   | Variable | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `VITE_API_URL` | `https://api.qa.mlitech.com` |
   | `VITE_OPERATOR_NAME` | `MLITech` (shown on the terms and privacy pages) |
   | `VITE_CONTACT_EMAIL` | your support address |
   | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `1` (the build doesn't need browsers) |

   `VITE_*` values are baked in at build time: after changing one, redeploy.
4. Save and deploy. Then Custom domains → add `qa.mlitech.com` (Cloudflare creates the DNS record).
5. The build writes `_headers` into the output: security headers, and a Content-Security-Policy
   that allows API calls only to `VITE_API_URL`. Cloudflare Pages serves `index.html` for app
   routes like `/o/...` by itself.

## Step 4: First login and checks

1. Open `https://qa.mlitech.com` → Sign up → this first account owns the platform (invite-only after it).
2. The **Getting started** checklist on the overview walks through: project → staging environment →
   verify the domain → test accounts → API key / schedule → first run → alerts → invite the team.
3. If the dashboard shows network errors: open the browser console.
   - "CORS" errors: `DASHBOARD_URL` on the server must equal the address in the browser bar
     (scheme + host, no trailing slash). Fix `.env`, then `docker compose -f docker-compose.api.yml up -d api`.
   - "Content Security Policy" errors: `VITE_API_URL` on Pages is wrong; fix it and redeploy.

## Step 5: Connect MLITech (GitHub Actions)

Follow `integrations/mlitech/README.md`. With this split, **`QA_PLATFORM_URL` is the API address**
(`https://api.qa.mlitech.com`): CI talks to the API. Links in PR comments still open the dashboard.

## Updating

- Dashboard: push to GitHub; Pages rebuilds on its own.
- API: on the server `git pull && docker compose -f docker-compose.api.yml up -d --build`
  (migrations run first; take a backup before, see `deploy/README.md` → Backups).

## Vercel instead of Cloudflare Pages

New project → import `tmhdigital/qa-agent` → Root Directory `apps/dashboard` (it has a `vercel.json`
for app routes and headers) → Build command `npm run build` → Output `dist` → same environment
variables as above. Remember: Hobby is non-commercial only; use Pro for company or paid use.
