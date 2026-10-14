#!/usr/bin/env python3
"""spick add_lane (stdlib only): register one outside lane in spick.json without hand-writing JSON.

Usage:
  add_lane.py --id ID --name DISPLAY --kind api-key|relay|local --base-url URL
              --api openai-chat|anthropic-messages --model MODEL
              [--key-name NAME] [--data public|text|code] [--tags a,b]
              [--meter-preset PRESET] [--health-url URL] [--max-tokens 400]
              [--notes TEXT] [--dry-run]

Reads $CLAUDE_CONFIG_DIR/spick.json (default ~/.claude/spick.json); refuses if it is missing
(run spick setup first). Copies it to spick.json.bak (overwriting the previous .bak), then adds or
replaces lane_registry[ID] (creating lane_registry if the file has none), keeping every other key and lane.
After a write it rebuilds the cache's lanes list and starts a detached quota refresh. Validates with lanes.validate and
refuses to write if the result is invalid. --dry-run prints the record and writes nothing.
It never reads the keychain and never prints or stores a key: key_ref is only a name.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lanes  # noqa: E402

KIND_CHOICES = ("api-key", "relay", "local")
APIS = ("openai-chat", "anthropic-messages")


def die(msg):
    sys.stderr.write("add_lane: %s\n" % msg)
    sys.exit(1)


def split_list(s):
    return [x.strip() for x in s.split(",") if x.strip()] if s else []


def meter_for(preset):
    if not preset:
        return {"type": "none"}
    p = lanes.meter_presets().get(preset)
    if p is None:
        die("unknown meter preset: %s" % preset)
    t = "usage-endpoint" if p.get("kind") == "used-total" else "balance-endpoint"
    return {"type": t, "preset": preset}


def build_record(a):
    rec = {"kind": a.kind, "name": a.name, "enabled": True,
           "tags": split_list(a.tags)}
    if a.data:
        rec["data"] = a.data
    if a.kind != "local":
        rec["key_ref"] = "keychain:%s" % (a.key_name or "spick-%s" % a.id)
    elif a.key_name:
        rec["key_ref"] = "keychain:%s" % a.key_name
    rec["invoke"] = {"api": a.api, "base_url": a.base_url, "model": a.model, "max_tokens": a.max_tokens}
    rec["meter"] = meter_for(a.meter_preset)
    if a.kind == "local" and a.health_url:
        rec["meter"]["health_url"] = a.health_url
    if a.notes:
        rec["notes"] = a.notes
    return rec


def main(argv):
    p = argparse.ArgumentParser(description="register one outside lane in spick.json")
    p.add_argument("--id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--kind", required=True, choices=KIND_CHOICES)
    p.add_argument("--base-url", required=True)
    p.add_argument("--api", required=True, choices=APIS)
    p.add_argument("--model", required=True)
    p.add_argument("--key-name")
    p.add_argument("--data", choices=lanes.DATA_LEVELS)
    p.add_argument("--tags")
    p.add_argument("--meter-preset")
    p.add_argument("--health-url")
    p.add_argument("--max-tokens", type=int, default=400)
    p.add_argument("--notes")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)

    if not lanes.ID_RE.match(a.id):
        die("id must be lowercase letters, digits and hyphens")
    if a.max_tokens <= 0:
        die("--max-tokens must be positive")

    path = lanes.config_path()
    if not os.path.isfile(path):
        die("%s not found; run spick setup first" % path)
    try:
        with open(path) as f:
            cfg = json.load(f)
    except Exception as e:
        die("cannot read %s: %s" % (path, e.__class__.__name__))
    if not isinstance(cfg, dict):
        die("%s is not a JSON object" % path)
    reg = cfg.get("lane_registry")
    if reg is None:
        reg = {}
    elif not isinstance(reg, dict):
        die("lane_registry must be an object")

    rec = build_record(a)
    new = dict(cfg)
    new["lane_registry"] = dict(reg)
    new["lane_registry"][a.id] = rec
    errs = lanes.validate(new)
    if errs:
        die("invalid result, nothing written:\n  " + "\n  ".join(errs))

    if a.dry_run:
        print(json.dumps({a.id: rec}, indent=2, ensure_ascii=False))
        return 0

    try:
        lanes.write_config(path, new)
    except ValueError as e:
        die(str(e))
    print("registered %s; backup at spick.json.bak" % a.id)
    lanes.after_write()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
