#!/bin/sh
# Nightly Postgres backup: pg_dump -Fc of the woolrus database into $BACKUP_DIR, keeping the newest $BACKUP_KEEP.
# Dumps are written under a temp name and renamed on success, so a failure never leaves a partial dump and
# never touches earlier ones. Connection settings come from the standard PG* variables.
set -eu
# Dumps hold customer data and encrypted secrets: owner-only.
umask 077

dir=${BACKUP_DIR:-/backups}
keep=${BACKUP_KEEP:-14}
db=${BACKUP_DB:-woolrus}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$dir/woolrus-$stamp.dump"
tmp="$dir/.woolrus-$stamp.dump.tmp"

trap 'rm -f "$tmp"' EXIT

echo "backup: dumping $db to $final"
if ! pg_dump -Fc -f "$tmp" "$db"; then
  echo "backup: pg_dump failed; earlier dumps left in place" >&2
  exit 1
fi
mv "$tmp" "$final"
echo "backup: wrote $final ($(wc -c < "$final") bytes)"

# Newest first (timestamps sort lexically); everything past $keep goes.
ls -1 "$dir"/woolrus-*.dump | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
  echo "backup: removing $old"
  rm -f "$old"
done
