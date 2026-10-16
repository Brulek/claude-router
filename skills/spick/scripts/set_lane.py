#!/usr/bin/env python3
"""spick set_lane (stdlib only): change one field of one lane in spick.json, or list the lanes.

Usage:
  set_lane.py --list
  set_lane.py --id ID --field FIELD --value VALUE [--dry-run]

--list prints a JSON array: id, name, enabled, tags, data, notes, kind (no key_ref, no base_url).

Fields (any lane, built-in or registered; every field may be changed):
  name          display name, one line
  tags          comma list, lowercase, each ^[a-z0-9][a-z0-9-]{0,23}$, at most 8, duplicates dropped; "-" clears
  data          public | text | code | unset
  enabled       yes | no   (the one on/off switch, stored as lane_registry.<id>.enabled)
  notes         one line, at most 200 characters; "-" clears
  kind          cli-subscription | api-key | local | relay | web-only
  base_url, api (openai-chat | anthropic-messages), model, max_tokens (1..200000)   -> invoke.*
  key_ref       keychain:<name> or env:<VAR>; never the key itself
  meter_type, meter_preset, health_url                                              -> meter.*  ("-" clears the last two)

Writes $CLAUDE_CONFIG_DIR/spick.json (default ~/.claude): copies it to spick.json.bak, writes the change to a
tmp file, runs lanes.validate on it, and only then replaces the original. A built-in lane (gemini, grok,
codex) gets an override record in lane_registry holding only what was changed; lane_registry is created
by the first edit. Exit 2 with a one-line reason when refused. A value that looks like a secret is refused
and never echoed. A new lane id is not created here; use add_lane.py. --dry-run prints the resulting
record and writes nothing.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lanes  # noqa: E402

TAG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
MAX_TAGS = 8
MAX_NOTES = 200
MAX_NAME = 80
MAX_TOKENS_CAP = 200000
APIS = ("openai-chat", "anthropic-messages")
FIELDS = ("name", "tags", "data", "enabled", "notes", "kind", "base_url", "api", "model", "max_tokens",
          "key_ref", "meter_type", "meter_preset", "health_url")
PATHS = {"base_url": ("invoke", "base_url"), "api": ("invoke", "api"), "model": ("invoke", "model"),
         "max_tokens": ("invoke", "max_tokens"), "meter_type": ("meter", "type"),
         "meter_preset": ("meter", "preset"), "health_url": ("meter", "health_url")}
DELETE = object()


class Refuse(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        sys.stderr.write("set_lane: %s\n" % message.splitlines()[0])
        sys.exit(2)


def one_line(v, what, limit):
    if not v.strip() or "\n" in v or "\r" in v:
        raise Refuse("%s must be one non-empty line" % what)
    if len(v.strip()) > limit:
        raise Refuse("%s is longer than %d characters" % (what, limit))
    return v.strip()


def parse_tags(v):
    if v.strip() == "-":
        return []
    out = []
    for t in v.split(","):
        t = t.strip().lower()
        if not t:
            continue
        if not TAG_RE.match(t):
            raise Refuse("a tag must match ^[a-z0-9][a-z0-9-]{0,23}$ (lowercase letters, digits, hyphen, 24 characters at most)")
        if t not in out:
            out.append(t)
    if not out:
        raise Refuse("tags is empty; use - to clear")
    if len(out) > MAX_TAGS:
        raise Refuse("at most %d tags" % MAX_TAGS)
    return out


def http_url(v, what):
    v = v.strip()
    if not re.match(r"^https?://[^\s]+$", v):
        raise Refuse("%s must be an http(s) URL without spaces" % what)
    return v


def parse_value(field, v, lid):
    """The new value for field (DELETE to remove the key). Raises Refuse; messages never contain v."""
    if field != "key_ref" and lanes.looks_like_secret(v):
        raise Refuse("the value looks like a secret; not written")
    if field == "name":
        return one_line(v, "name", MAX_NAME)
    if field == "tags":
        return parse_tags(v)
    if field == "data":
        if v == "unset":
            return DELETE
        if v not in lanes.DATA_LEVELS:
            raise Refuse("data must be public, text, code or unset")
        return v
    if field == "enabled":
        if v not in ("yes", "no"):
            raise Refuse("enabled must be yes or no")
        return v == "yes"
    if field == "notes":
        return DELETE if v.strip() == "-" else one_line(v, "notes", MAX_NOTES)
    if field == "kind":
        if v not in lanes.KINDS:
            raise Refuse("kind must be one of %s" % ", ".join(lanes.KINDS))
        return v
    if field == "base_url":
        return http_url(v, "base_url")
    if field == "api":
        if v not in APIS:
            raise Refuse("api must be one of %s" % ", ".join(APIS))
        return v
    if field == "model":
        v = v.strip()
        if not v or re.search(r"\s", v) or len(v) > 120:
            raise Refuse("model must be one word of at most 120 characters")
        return v
    if field == "max_tokens":
        if not re.match(r"^[0-9]{1,7}$", v.strip()) or not 1 <= int(v) <= MAX_TOKENS_CAP:
            raise Refuse("max_tokens must be an integer from 1 to %d" % MAX_TOKENS_CAP)
        return int(v)
    if field == "key_ref":
        if not lanes.KEY_REF_RE.match(v.strip()):
            raise Refuse("key_ref must be keychain:<name> or env:<VAR>")
        return v.strip()
    if field == "meter_type":
        if v not in lanes.METER_TYPES:
            raise Refuse("meter_type must be one of %s" % ", ".join(lanes.METER_TYPES))
        return v
    if field == "meter_preset":
        if v.strip() == "-":
            return DELETE
        if v.strip() not in lanes.meter_presets():
            raise Refuse("unknown meter preset; known: %s" % ", ".join(sorted(lanes.meter_presets())))
        return v.strip()
    if field == "health_url":
        return DELETE if v.strip() == "-" else http_url(v, "health_url")
    raise Refuse("unknown field")


def apply(rec, built, field, value):
    """The new registry record: rec (the lane's current record or {}) with one field changed."""
    rec = json.loads(json.dumps(rec))
    if field in PATHS:
        parent, child = PATHS[field]
        base = rec.get(parent)
        if not isinstance(base, dict):
            base = built.get(parent) if isinstance(built.get(parent), dict) else {}
        sub = dict(base)
        if value is DELETE:
            sub.pop(child, None)
        else:
            sub[child] = value
        rec[parent] = sub
    elif value is DELETE:
        # an override record cannot "remove" a built-in value, so write an explicit null for data
        if field == "data" and built.get("data") is not None:
            rec["data"] = None
        else:
            rec.pop(field, None)
    else:
        rec[field] = value
    return rec


def list_lanes(cfg):
    out = []
    for ln in lanes.load_effective(cfg, include_disabled=True):
        out.append({"id": ln["id"], "name": ln.get("name") or ln["id"], "enabled": bool(ln.get("enabled", True)),
                    "tags": list(ln.get("tags") or []), "data": ln.get("data"), "notes": ln.get("notes") or None,
                    "kind": ln.get("kind")})
    return out


def safe_word(s, pattern):
    return s if re.match(pattern, s) else "(not shown)"


def run(a):
    path = lanes.config_path()
    if a.list:
        print(json.dumps(list_lanes(lanes.read_config(path)), indent=1, ensure_ascii=False))
        return 0
    if not (a.id and a.field is not None and a.value is not None):
        raise Refuse("need --list, or --id, --field and --value")
    if a.field not in FIELDS:
        raise Refuse("unknown field %s; fields: %s" % (safe_word(a.field, r"^[a-z_]{1,20}$"), ", ".join(FIELDS)))
    built = lanes.builtins()
    if not lanes.ID_RE.match(a.id) or lanes.looks_like_secret(a.id):
        raise Refuse("invalid lane id")
    if not os.path.isfile(path):
        raise Refuse("%s not found; run spick setup first" % path)
    try:
        with open(path) as f:
            cfg = json.load(f)
    except Exception as e:
        raise Refuse("cannot read %s: %s" % (path, e.__class__.__name__))
    if not isinstance(cfg, dict):
        raise Refuse("%s is not a JSON object" % path)
    reg = cfg.get("lane_registry")
    if reg is None:
        reg = {}
    elif not isinstance(reg, dict):
        raise Refuse("lane_registry must be an object")
    if a.id not in built and a.id not in reg:
        raise Refuse("unknown lane id %s; to add a new lane use add_lane.py" % a.id)
    value = parse_value(a.field, a.value, a.id)
    rec = apply(reg.get(a.id) if isinstance(reg.get(a.id), dict) else {}, built.get(a.id, {}), a.field, value)
    new = dict(cfg)
    new["lane_registry"] = dict(reg)
    new["lane_registry"][a.id] = rec
    errs = lanes.validate(new)
    if errs:
        raise Refuse("invalid result, nothing written: " + "; ".join(errs))
    if a.dry_run:
        print(json.dumps({a.id: rec}, indent=2, ensure_ascii=False))
        return 0
    try:
        lanes.write_config(path, new)
    except ValueError as e:
        raise Refuse(str(e).replace("\n  ", " ").replace("\n", " "))
    print("set %s.%s; backup at spick.json.bak" % (a.id, a.field))
    lanes.after_write()
    return 0


def main(argv):
    p = Parser(description="change one field of one lane in spick.json")
    p.add_argument("--list", action="store_true")
    p.add_argument("--id")
    p.add_argument("--field")
    p.add_argument("--value")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    try:
        return run(a)
    except Refuse as e:
        sys.stderr.write("set_lane: %s\n" % e)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
