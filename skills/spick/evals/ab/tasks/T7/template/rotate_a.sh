#!/usr/bin/env bash
# Archive LOGFILE into ARCHIVE_DIR and prune archives older than KEEP_DAYS.
set -euo pipefail

log=${1:?usage: rotate_a.sh LOGFILE ARCHIVE_DIR KEEP_DAYS}
dir=${2:?missing ARCHIVE_DIR}
keep=${3:?missing KEEP_DAYS}

[[ -f $log ]] || { echo "no such log: $log" >&2; exit 2; }
mkdir -p "$dir"

tmp=$(mktemp "$dir/.rotate.XXXXXX")
trap 'rm -f "$tmp"' EXIT

gzip -c "$log" > "$tmp"
mv "$tmp" "$dir/$(basename "$log").$(date +%Y%m%d%H%M%S).gz"
: > "$log"

removed=0
for old in $(find "$dir" -name '*.gz' -mtime +"$keep"); do
  rm -f "$old"
  ((removed++))
done
echo "rotated $log, removed $removed old archive(s)"
