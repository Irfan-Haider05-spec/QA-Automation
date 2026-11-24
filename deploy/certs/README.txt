Files for deploy/certs (never committed; .gitignore excludes *.crt, *.pem and *.key here):
- supabase-ca.crt: only for the Supabase setup (Supabase → Project Settings → Database → SSL Configuration → Download certificate).
- cloudflare-origin.pem and cloudflare-origin.key: only when Cloudflare's proxy (orange cloud) is on, see DIGITALOCEAN.md step 9.
