#!/usr/bin/env bash
# Archive LOGFILE into ARCHIVE_DIR and prune archives older than KEEP_DAYS.

if [ $# -ne 3 ]; then
  echo "usage: rotate_b.sh LOGFILE ARCHIVE_DIR KEEP_DAYS" >&2
  exit 64
fi
log=$1
dir=$2
keep=$3

case $keep in
  '' | *[!0-9]*) echo "KEEP_DAYS must be a number: $keep" >&2; exit 64 ;;
esac
if [ ! -f "$log" ]; then
  echo "no such log: $log" >&2
  exit 66
fi
mkdir -p "$dir" || { echo "cannot create $dir" >&2; exit 73; }

out="$dir/$(basename "$log").$(date +%Y%m%d%H%M%S).gz"
if ! gzip -c "$log" > "$out"; then
  echo "gzip failed, log left untouched" >&2
  rm -f "$out"
  exit 74
fi
: > "$log"

removed=0
while IFS= read -r old; do
  if rm -f -- "$old"; then
    removed=$((removed + 1))
  else
    echo "could not remove $old" >&2
  fi
done < <(find "$dir" -name '*.gz' -mtime +"$keep")
echo "rotated $log, removed $removed old archive(s)"
