#!/bin/sh
# Tests for backup.sh using a fake pg_dump. Run: sh docker/backup/backup.test.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin" "$work/out"

cat > "$work/bin/pg_dump" <<'FAKE'
#!/bin/sh
# usage: pg_dump -Fc -f <file> <db>
[ "${FAKE_FAIL:-}" = 1 ] && { echo partial > "$3"; exit 1; }
echo dump > "$3"
FAKE
chmod +x "$work/bin/pg_dump"
export PATH="$work/bin:$PATH" BACKUP_DIR="$work/out"

fail() { echo "FAIL: $1" >&2; exit 1; }

# 15 existing dumps -> after a run, newest 14 remain (14 old + 1 new = 15, so prune to 14).
i=1
while [ $i -le 15 ]; do
  touch "$work/out/woolrus-2020010$(printf '%02d' $i)T000000Z.dump"
  i=$((i + 1))
done
sh "$here/backup.sh" >/dev/null
count=$(ls "$work/out"/woolrus-*.dump | wc -l)
[ "$count" -eq 14 ] || fail "expected 14 dumps, got $count"
[ ! -e "$work/out/woolrus-20200101T000000Z.dump" ] || fail "oldest dump should be gone"
ls "$work/out"/woolrus-2020*.dump | head -1 | grep -q 0000Z || fail "unexpected survivors"

# Failing pg_dump: non-zero exit, no partial/temp file, dumps untouched.
before=$(ls -A "$work/out" | sort)
if FAKE_FAIL=1 sh "$here/backup.sh" >/dev/null 2>&1; then fail "should exit non-zero"; fi
after=$(ls -A "$work/out" | sort)
[ "$before" = "$after" ] || fail "directory changed after failed dump"

echo "ok"
