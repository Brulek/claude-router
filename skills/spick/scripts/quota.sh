#!/usr/bin/env bash
# spick quota. Collects raw facts about the subscriptions listed in $CLAUDE_CONFIG_DIR/spick.json (default ~/.claude) and shows them;
# it judges nothing. All work is in quota.py (stdlib python).
# Usage: quota.sh [--json] [--refresh]
#   (none)     show $CLAUDE_CONFIG_DIR/spick-quota.json; first run (no cache) refreshes once; a cache older than
#              10 minutes is refreshed in the background and still shown at once
#   --refresh  collect now (synchronous; codex/grok ~20 s, agy up to 90 s), write the cache, show it
#   --json     the same facts as JSON
# Exit code is always 0; a provider that cannot be read says "unknown (reason)".
PY=$(command -v python3 || command -v python || true)
if [ -z "$PY" ]; then echo "unknown (python not found)"; exit 0; fi
exec "$PY" "$(dirname "${BASH_SOURCE[0]}")/quota.py" "$@"
