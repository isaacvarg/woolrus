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
[ ! -e "$work/out/woolrus-20200102T000000Z.dump" ] || fail "second oldest should be gone"
# 15 old + the new dump = 16; the two oldest go, so 03..15 and the new one survive.
i=3
while [ $i -le 15 ]; do
  [ -e "$work/out/woolrus-2020010$(printf '%02d' $i)T000000Z.dump" ] || fail "dump $i should survive"
  i=$((i + 1))
done
[ "$(ls "$work/out"/woolrus-2020*.dump | wc -l)" -eq 13 ] || fail "wrong survivors"
newest=$(ls "$work/out"/woolrus-*.dump | sort -r | head -1)
[ "$(stat -c %a "$newest")" = 600 ] || fail "dump should be mode 600"

# Fewer than 14 dumps and files that aren't dumps: nothing is removed.
echo keep > "$work/out/notes.txt"
sh "$here/backup.sh" >/dev/null
[ -e "$work/out/notes.txt" ] || fail "unrelated file removed"
[ "$(ls "$work/out"/woolrus-*.dump | wc -l)" -eq 14 ] || fail "still 14 after another run"

# A temp file left by a killed run doesn't break the next one.
touch "$work/out/.woolrus-leftover.dump.tmp"
sh "$here/backup.sh" >/dev/null || fail "leftover tmp broke the run"

# Failing pg_dump: non-zero exit, no partial/temp file, dumps untouched.
before=$(ls -A "$work/out" | sort)
if FAKE_FAIL=1 sh "$here/backup.sh" >/dev/null 2>&1; then fail "should exit non-zero"; fi
after=$(ls -A "$work/out" | sort)
[ "$before" = "$after" ] || fail "directory changed after failed dump"

echo "ok"
