# QA Platform: live karne ki mukammal guide (beginner ke liye)

Ye guide shuru se aakhir tak ek hi raasta batati hai. Har step mein: **kahan jana hai, kya click karna hai, kaunsa command chalana hai, aur kaise check karna hai ke kaam ho gaya**. Steps isi tarteeb se karein, beech mein na choorein.

---

## Part 0: Pehle samajh lein ke kya kahan chalega

```
                          ┌──────────────────────────────┐
  Browser  ─────────────► │ Cloudflare Pages             │  qa.mlitech.com
  (aap / team)            │ Dashboard (sirf HTML/JS)     │
                          └──────────────┬───────────────┘
                                         │ API calls
                                         ▼
                          ┌──────────────────────────────┐
  GitHub Actions ───────► │ Oracle Cloud VM (Ubuntu)     │  api.qa.mlitech.com
  (MLITech ke QA runs)    │ Docker: Caddy + API + Runner │
                          └──────────────┬───────────────┘
                                         │ database
                                         ▼
                          ┌──────────────────────────────┐
                          │ Supabase                     │
                          │ PostgreSQL database          │
                          └──────────────────────────────┘
          Emails (password reset, alerts) ──► Brevo (SMTP)
```

| Hissa | Kahan | Kyun yahan |
|---|---|---|
| Dashboard | Cloudflare Pages | Sirf static files hain; Cloudflare free aur tez hai |
| API + hosted runner | Oracle Cloud VM | API 24 ghante background kaam karti hai (scheduler, alerts), runner Chromium chalata hai; is ke liye asli server chahiye |
| Database | Supabase | Managed PostgreSQL; aap ko database server sambhalna nahi padega |
| Domain / DNS | Cloudflare | `qa.` aur `api.qa.` subdomains |
| Email | Brevo | Password reset, email confirm, email alerts |
| Code | GitHub | Cloudflare yahin se dashboard build karta hai, server yahin se code leta hai |

**Kharcha:** sab free plans par chal jata hai (sirf domain ka kharcha, jo MLITech ka pehle se hai).

**Supabase free plan ki 3 baatein yaad rakhein:**
1. Database 500 MB tak. Shuru ke liye kaafi hai.
2. Agar 7 din tak database se koi baat na kare to project pause ho jata hai. Hamari API har kuch second database se baat karti hai, is liye jab tak server chal raha hai, pause nahi hoga.
3. Free plan mein automatic backup nahi. Is liye Part 12 mein backup ka script hai: zaroor lagayein.

---

## Part 1: Apne computer (Windows) par kya install karna hai

Sirf do cheezen:

| Software | Kahan se | Kis kaam ka |
|---|---|---|
| **Git for Windows** | https://git-scm.com/download/win → download → Next, Next, Install (default settings theek hain) | Code GitHub par bhejna |
| **PowerShell / Windows Terminal** | Windows mein pehle se hai (Start → "Terminal") | Commands chalana; `ssh` aur `scp` is mein pehle se hote hain |

Check karein (Terminal kholein):

```powershell
git --version     # git version 2.x... aana chahiye
ssh -V            # OpenSSH_... aana chahiye
```

Node.js ya Docker apne computer par install karne ki zaroorat **nahi**: sab kuch server aur Cloudflare par banega.

---

## Part 2: Accounts banayein (checklist)

| # | Account | Link | Note |
|---|---|---|---|
| 1 | GitHub | https://github.com | Shayad pehle se hai (tmhdigital org) |
| 2 | Supabase | https://supabase.com → Start your project | GitHub se login kar sakte hain |
| 3 | Oracle Cloud | https://www.oracle.com/cloud/free/ | Card verification maangega (free tier par charge nahi hota). **Home region** soch kar chunein (maslan Mumbai): free VM sirf isi region mein milta hai, baad mein badal nahi sakte |
| 4 | Cloudflare | https://dash.cloudflare.com/sign-up | Free plan |
| 5 | Brevo | https://www.brevo.com | Email bhejne ke liye (free plan) |

**Domain Cloudflare par:** agar `mlitech.com` (ya jo bhi domain hai) pehle se Cloudflare par hai to aage barhein. Agar nahi: Cloudflare → **Add a domain** → domain likhein → Free plan → Cloudflare 2 nameservers dega → apne domain registrar (jahan se domain khareeda) ki website par nameservers in se badal dein. Active hone mein kuch minute se kuch ghante lag sakte hain.

> Is guide mein misaal ke liye ye naam hain, apne hisaab se badal lein:
> - Dashboard: `qa.mlitech.com`
> - API: `api.qa.mlitech.com`

---

## Part 3: Code GitHub par daalna

1. GitHub website → **New repository** → Owner: `tmhdigital` → Name: `qa-agent` → **Private** → Create (README wagaira add na karein).
2. Apne computer par Terminal mein:

```powershell
cd F:\mlitech-qa-agent-v2\qa-agent
git init
git add .
git commit -m "QA platform"
git branch -M main
git remote add origin https://github.com/tmhdigital/qa-agent.git
git push -u origin main
git tag v1
git push --tags
```

Pehli dafa push par browser khulega GitHub login ke liye: login kar dein.

Check: GitHub par repo kholein: `apps`, `deploy`, `src` folders nazar aane chahiye. `.env` naam ki koi file **nahi** honi chahiye (`.gitignore` usay rokta hai).

---

## Part 4: Supabase (database)

### 4.1 Project banayein
1. Supabase dashboard → **New project**.
2. Name: `qa-platform`. **Database password**: strong password banayein aur kahin save kar lein (ye `postgres` user ka hai; abhi seedha use nahi hoga).
3. Region: wahi area jahan Oracle ka home region hai (maslan dono Mumbai). Qareeb hone se API tez chalegi.
4. **Create new project** → 1–2 minute intezar.

### 4.2 Database users banayein
Hamari API do alag users use karti hai (security ke liye):
- `qa_owner`: tables banata/badalta hai (sirf migration ke waqt).
- `qa_app`: API isi se chalti hai; sirf data parh/likh sakta hai, aur har company ka data alag rehta hai.

1. Do passwords banayein. **Sirf letters aur numbers**, 24+ characters (special characters `@ : / ? & #` connection string tod dete hain). Misaal ke liye kisi password generator se ya:
   ```powershell
   -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | % {[char]$_})
   ```
   (ye PowerShell command 32 characters ka password deta hai; do dafa chalayein.)
2. Supabase → left menu **SQL Editor** → **New query**.
3. Repo ki file `deploy/supabase-roles.sql` kholein, uska text copy karke yahan paste karein, dono `CHANGE_ME_...` ki jagah apne passwords likhein → **Run**.
4. Neeche 2 rows (`qa_owner`, `qa_app`) nazar aani chahiye. Ye passwords save kar lein.

### 4.3 SSL certificate download karein
Supabase → **Project Settings** → **Database** → **SSL Configuration** → **Download certificate**. Ek `.crt` file download hogi: usay `supabase-ca.crt` naam se save kar lein (Part 8 mein server par bhejenge). Is se API pakka karti hai ke wo asli Supabase se hi baat kar rahi hai.

### 4.4 Connection details note karein
Supabase → upar **Connect** button → **Session pooler** wala connection string copy karein. Kuch aisa hoga:

```
postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

Is mein se do cheezen note karein:
- **PROJECTREF** = `postgres.` ke baad wala hissa → `abcdefghijkl`
- **POOLER_HOST** = `@` ke baad aur `:5432` se pehle → `aws-0-ap-south-1.pooler.supabase.com`

Ab do URLs banayein (Part 8 mein `.env` mein jayengi):

```
MIGRATION_DATABASE_URL=postgresql://qa_owner.PROJECTREF:OWNER_PASSWORD@POOLER_HOST:5432/postgres?sslmode=verify-full&sslrootcert=/certs/supabase-ca.crt
DATABASE_URL=postgresql://qa_app.PROJECTREF:APP_PASSWORD@POOLER_HOST:5432/postgres?sslmode=verify-full&sslrootcert=/certs/supabase-ca.crt
```

> **Session pooler hi kyun?** Supabase ka "Direct connection" sirf IPv6 par chalta hai; Oracle VM IPv4 use karta hai. Session pooler IPv4 par chalta hai. Custom user ka naam pooler par `user.PROJECTREF` likha jata hai (sirf `qa_app` likhenge to "Tenant or user not found" error aayega).

---

## Part 5: Brevo (email)

1. Brevo account → **Senders, Domains & Dedicated IPs** mein apna sender email (maslan `qa@mlitech.com`) add aur verify karein. Behtar delivery ke liye **domain authenticate** karein: Brevo kuch DNS records dega, unhein Cloudflare → DNS mein add kar dein.
2. Brevo → **SMTP & API** → **SMTP** tab → yahan **SMTP server**, **Login** aur **Generate a new SMTP key** milega.
3. `SMTP_URL` banayein:
   ```
   smtp://LOGIN:SMTP_KEY@smtp-relay.brevo.com:587
   ```
   **Zaroori:** Login mein `@` ho (aksar hota hai, maslan `8a1b2c001@smtp-brevo.com`) to URL mein `@` ki jagah `%40` likhein:
   ```
   smtp://8a1b2c001%40smtp-brevo.com:xsmtpsib-abc123...@smtp-relay.brevo.com:587
   ```

---

## Part 6: Oracle Cloud server (VM)

### 6.1 SSH key banayein (apne computer par)
```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\qa_oracle
```
Password poochega: Enter dabakar khali chhod sakte hain. Do files banengi: `qa_oracle` (private: kisi ko na dein) aur `qa_oracle.pub` (public: Oracle ko denge).

### 6.2 VM banayein
1. Oracle console → menu → **Compute** → **Instances** → **Create instance**.
2. **Name:** `qa-api`.
3. **Image and shape** → Edit:
   - Image: **Canonical Ubuntu 24.04**.
   - Shape: **Ampere** → `VM.Standard.A1.Flex` → **2 OCPU, 12 GB memory** ("Always Free-eligible" likha hona chahiye).
4. **Networking:** default VCN aur public subnet rehne dein; **Assign a public IPv4 address** on ho.
5. **Add SSH keys** → **Upload public key files** → `C:\Users\<aap ka naam>\.ssh\qa_oracle.pub`.
6. **Create**. 1–2 minute baad status **Running**. **Public IP address** copy kar lein.

> "Out of capacity" error aaye to: thodi der baad dobara try karein, ya doosra "availability domain" chunein, ya 1 OCPU / 6 GB se shuru karein.

### 6.3 Ports 80 aur 443 kholein (Oracle ki taraf)
Instance page → **Subnet** link → **Security Lists** → **Default Security List** → **Add Ingress Rules**:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

### 6.4 Server mein login
```powershell
ssh -i $HOME\.ssh\qa_oracle ubuntu@SERVER_IP
```
Pehli dafa "Are you sure you want to continue connecting" → `yes`. Ab aap server ke andar hain (prompt `ubuntu@qa-api:~$` jaisa hoga). Agle saare commands **server par** chalenge jab tak alag na likha ho.

### 6.5 Server ka apna firewall kholein
Oracle ki Ubuntu image mein andar bhi firewall rules hote hain:
```bash
sudo iptables -I INPUT 6 -p tcp --dport 80 -m state --state NEW -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 443 -m state --state NEW -j ACCEPT
sudo netfilter-persistent save
```

### 6.6 Packages install karein (Git, Docker)
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
```
`exit` se bahar aa jayein aur **dobara login** karein (Part 6.4 wala command) taake Docker bina `sudo` ke chale. Phir check:
```bash
docker run --rm hello-world      # "Hello from Docker!" aana chahiye
docker compose version           # Docker Compose version v2.x
git --version
```

---

## Part 7: DNS record (Cloudflare)

Cloudflare → apna domain → **DNS** → **Records** → **Add record**:

| Type | Name | IPv4 address | Proxy status |
|---|---|---|---|
| A | `api.qa` | SERVER_IP | **DNS only** (grey cloud) |

Grey cloud zaroori hai taake server khud HTTPS certificate le sake.

Check (apne computer par):
```powershell
nslookup api.qa.mlitech.com      # SERVER_IP nazar aana chahiye (kabhi 5–10 minute lagte hain)
```

---

## Part 8: Server par code aur settings

### 8.1 Code download
GitHub repo private hai, is liye token chahiye: GitHub → Settings → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → Generate → Repository access: sirf `tmhdigital/qa-agent` → Permissions: **Contents: Read-only** → Generate → token copy karein.

Server par:
```bash
git clone https://github.com/tmhdigital/qa-agent.git
# Username: aap ka GitHub username
# Password: abhi wala token (GitHub password nahi)
cd qa-agent/deploy
```

### 8.2 Supabase certificate server par bhejein
**Apne computer** par naya Terminal kholein (server wala band na karein):
```powershell
scp -i $HOME\.ssh\qa_oracle C:\Users\<aap ka naam>\Downloads\supabase-ca.crt ubuntu@SERVER_IP:~/qa-agent/deploy/certs/supabase-ca.crt
```
Server par check: `ls ~/qa-agent/deploy/certs` → `supabase-ca.crt` nazar aaye.

### 8.3 `.env` file banayein
Server par (`~/qa-agent/deploy` folder mein):
```bash
cp .env.supabase.example .env
```
Secrets generate karein (har command alag chalayein, output copy karein):
```bash
openssl rand -hex 32        # → JWT_SECRET
openssl rand -base64 32     # → VAULT_MASTER_KEY  (isay password manager mein bhi save karein!)
openssl rand -hex 32        # → RUNNER_TOKEN
```
File edit karein:
```bash
nano .env
```
Har line bharein:

| Line | Kya likhna hai |
|---|---|
| `API_DOMAIN` | `api.qa.mlitech.com` |
| `DASHBOARD_URL` | `https://qa.mlitech.com` (aakhir mein `/` nahi) |
| `MIGRATION_DATABASE_URL` | Part 4.4 wali qa_owner URL |
| `DATABASE_URL` | Part 4.4 wali qa_app URL |
| `JWT_SECRET`, `VAULT_MASTER_KEY`, `RUNNER_TOKEN` | upar generate kiye hue |
| `SIGNUP_MODE` | `invite` rehne dein |
| `SMTP_URL` | Part 5 wala |
| `MAIL_FROM` | `QA Platform <qa@mlitech.com>` (Brevo mein verified sender) |

Save: `Ctrl+O` → Enter → `Ctrl+X`.

> `VAULT_MASTER_KEY` kho gaya to platform mein save kiye test-account passwords kabhi nahi khulenge. Isay zaroor alag save karein.

---

## Part 9: Platform chalayein

```bash
cd ~/qa-agent/deploy
docker compose -f docker-compose.supabase.yml up -d --build
```
Pehli dafa build mein 5–10 minute lagte hain.

Check karein:
```bash
docker compose -f docker-compose.supabase.yml ps
#   migrate  → Exited (0)   (ek dafa chal kar band hota hai: theek hai)
#   api      → Up
#   caddy    → Up

docker compose -f docker-compose.supabase.yml logs migrate
#   "8 migration(s) applied" (pehli dafa)

docker compose -f docker-compose.supabase.yml logs api | tail -5
#   "[api] listening on :4100 (pg)"

curl https://api.qa.mlitech.com/health
#   {"ok":true,...}
```

Hosted runner (dashboard se "Run now" aur schedules ke liye):
```bash
docker compose -f docker-compose.supabase.yml --profile hosted up -d --build
docker compose -f docker-compose.supabase.yml logs runner | tail -3
#   "runner runner-1 polling http://api:4100"
```

---

## Part 10: Dashboard (Cloudflare Pages)

1. Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → GitHub connect karein → `tmhdigital/qa-agent` chunein.
2. **Build settings:**

   | Setting | Value |
   |---|---|
   | Production branch | `main` |
   | Framework preset | `None` |
   | Build command | `npm ci && npm run build -w @qa/dashboard` |
   | Build output directory | `apps/dashboard/dist` |
   | Root directory | khali (repo ka root) |

3. **Environment variables** (Add variable):

   | Name | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `VITE_API_URL` | `https://api.qa.mlitech.com` |
   | `VITE_OPERATOR_NAME` | `MLITech` |
   | `VITE_CONTACT_EMAIL` | aap ka support email |
   | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `1` |

4. **Save and Deploy** → build 2–4 minute. Ek `https://qa-agent-xxx.pages.dev` address milega.
5. Project → **Custom domains** → **Set up a custom domain** → `qa.mlitech.com` → Cloudflare DNS record khud bana dega.

> `VITE_*` values build ke waqt andar likhi jati hain. Inhein badlein to **Deployments → Retry deployment** karein.

---

## Part 11: Pehla login aur check

1. `https://qa.mlitech.com` kholein → **Sign up** → naam, email, password, organization `MLITech`. Ye pehla account platform ka owner hai; baqi sab ab sirf invite se aayenge.
2. Email aana chahiye ("Confirm your email address") → link kholein.
3. Overview par **Getting started** checklist: wahi steps follow karein (project → staging environment → domain verify → test accounts → API key → pehla run → alerts → team invite).
4. Password reset test: log out → **Forgot your password?** → email aaye → naya password.

**Agar dashboard kaam na kare:** browser mein `F12` → **Console**:

| Error | Matlab | Hal |
|---|---|---|
| `CORS` | Server ko dashboard ka address pata nahi | Server `.env` mein `DASHBOARD_URL` bilkul browser wala address ho → `docker compose -f docker-compose.supabase.yml up -d api` |
| `Content Security Policy` | Dashboard ghalat API address par ja raha hai | Cloudflare Pages mein `VITE_API_URL` theek karein → Retry deployment |
| `Failed to fetch` / timeout | API band hai ya DNS nahi | Part 9 ke checks dobara; `curl .../health` |

---

## Part 12: Backup (zaroor lagayein)

Supabase free plan mein automatic backup nahi. Server par:
```bash
cd ~/qa-agent/deploy
./backup-supabase.sh
#   backup written: backups/qa-2026-11-10.dump
```
Har raat khud chalne ke liye:
```bash
crontab -e      # pehli dafa editor poochega: 1 (nano)
```
Sab se neeche ye line add karein, save karein:
```
30 2 * * * cd /home/ubuntu/qa-agent/deploy && ./backup-supabase.sh >> backups/backup.log 2>&1
```
30 din se purane backups khud delete hote hain. Hafte mein ek dafa koi backup apne computer par bhi le aayein:
```powershell
scp -i $HOME\.ssh\qa_oracle ubuntu@SERVER_IP:~/qa-agent/deploy/backups/qa-2026-11-10.dump .
```

---

## Part 13: MLITech ko jodna

`integrations/mlitech/README.md` follow karein. Is setup mein:
- GitHub variable `QA_PLATFORM_URL` = **`https://api.qa.mlitech.com`** (API ka address; dashboard ka nahi).
- API key dashboard se banegi (Project → API keys).

---

## Rozana ke kaam (cheat sheet)

Server par, `~/qa-agent/deploy` folder mein:

| Kaam | Command |
|---|---|
| Sab kuch chal raha hai? | `docker compose -f docker-compose.supabase.yml ps` |
| API ke logs | `docker compose -f docker-compose.supabase.yml logs -f api` (band karne ke liye `Ctrl+C`) |
| API restart | `docker compose -f docker-compose.supabase.yml restart api` |
| `.env` badalne ke baad | `docker compose -f docker-compose.supabase.yml up -d` |
| Naya code laana (update) | `./backup-supabase.sh && git pull && docker compose -f docker-compose.supabase.yml --profile hosted up -d --build` |
| Purani images saaf | `docker image prune -f` |
| Disk kitni bachi | `df -h /` |

Dashboard ka update: bas GitHub par push karein; Cloudflare khud dobara build karega.

---

## Mushkilaat aur un ka hal

| Masla | Wajah | Hal |
|---|---|---|
| `migrate` Exited (1), log mein `Tenant or user not found` | Username mein `.PROJECTREF` nahi | URL mein `qa_owner.PROJECTREF` / `qa_app.PROJECTREF` likhein |
| `password authentication failed` | Password ghalat, ya special character | `supabase-roles.sql` dobara: `alter role qa_app password '...';` sirf letters/numbers |
| `unable to verify the first certificate` / `ENOENT ... supabase-ca.crt` | Certificate nahi mila ya ghalat file | Part 8.2 dobara; `ls certs` mein `supabase-ca.crt` |
| `[api] Invalid configuration: ...` | `.env` ki koi line khali/chhoti | Message mein naam likha hota hai; wo line theek karein |
| `curl https://api...` par certificate error | DNS abhi nahi pohancha, ya ports band | `nslookup`, Part 6.3 aur 6.5 dobara; `docker compose ... logs caddy` |
| Emails nahi aa rahe | SMTP ghalat | `logs api` mein `couldn't send` dekhein; `SMTP_URL` mein `@` → `%40` |
| Supabase project "Paused" | 7 din database se koi baat nahi hui (server band tha) | Supabase dashboard → **Restore project** |
| Hosted run "Waiting" mein ruka | Runner nahi chal raha | `--profile hosted up -d`; `RUNNER_TOKEN` `.env` mein |

---

## Files jo is setup mein kaam aati hain (repo ke `deploy/` folder mein)

| File | Kya hai |
|---|---|
| `SETUP-GUIDE.md` | Ye guide |
| `supabase-roles.sql` | Part 4.2: Supabase mein database users |
| `.env.supabase.example` | Part 8.3: server settings ka template |
| `docker-compose.supabase.yml` | Part 9: API, runner, Caddy chalane ki file |
| `Caddyfile.api` | `api.qa...` ke liye HTTPS |
| `certs/` | `supabase-ca.crt` yahan aati hai |
| `backup-supabase.sh` | Part 12: backup |
