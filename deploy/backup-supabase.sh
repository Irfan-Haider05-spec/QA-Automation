#!/bin/sh
# Backup of the Supabase database (the free plan has no automatic backups).
#   cd ~/qa-agent/deploy && ./backup-supabase.sh          → backups/qa-YYYY-MM-DD.dump
# Restore into an empty database:  pg_restore --no-owner -d "<url>" backups/qa-YYYY-MM-DD.dump
set -e
cd "$(dirname "$0")"
URL="$(grep '^MIGRATION_DATABASE_URL=' .env | cut -d= -f2-)"
[ -n "$URL" ] || { echo "MIGRATION_DATABASE_URL missing in .env"; exit 1; }
mkdir -p backups
FILE="backups/qa-$(date +%F).dump"
docker run --rm -v "$PWD/certs:/certs:ro" postgres:17-alpine pg_dump "$URL" -Fc --no-owner > "$FILE.part"
mv "$FILE.part" "$FILE"
find backups -name 'qa-*.dump' -mtime +30 -delete
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
