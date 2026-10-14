#!/usr/bin/env python3
"""spick lane registry (stdlib only).

The program states facts; the model judges. Nothing here ranks, scores or refuses a lane.

Effective lanes, in this order:
  1. built-in lanes (assets/builtin-lanes.json) that spick.json "lanes" does not switch off
  2. spick.json "subscriptions".<id> plan and price folded in
  3. spick.json "lane_registry".<id> overrides built-in fields one field at a time
  4. registry ids that are not built-in are appended

Usage:
  lanes.py --validate   problems, one per line (exit 1 if any), else "ok"
  lanes.py --line       the Lanes line for the checklist
  lanes.py --json       the effective enabled lanes as JSON
  (--config PATH reads that spick.json instead of $CLAUDE_CONFIG_DIR/spick.json)
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BUILTIN_PATH = os.path.join(HERE, "..", "assets", "builtin-lanes.json")

KINDS = ("cli-subscription", "api-key", "local", "relay", "web-only")
DATA_LEVELS = ("public", "text", "code")
METER_TYPES = ("none", "builtin", "local-file", "balance-endpoint", "usage-endpoint")
THIRD_PARTY_KINDS = ("api-key", "relay")
ID_RE = re.compile(r"^[a-z0-9-]+$")
KEY_REF_RE = re.compile(r"^(keychain:[A-Za-z0-9._-]+|env:[A-Za-z_][A-Za-z0-9_]*)$")
B64_RE = re.compile(r"^[A-Za-z0-9+/]{32,}={0,2}$")
PRESETS_PATH = os.path.join(HERE, "..", "assets", "meter-presets.json")


def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def config_path():
    return os.path.join(config_dir(), "spick.json")


def read_config(path=None):
    try:
        with open(path or config_path()) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def builtins():
    with open(BUILTIN_PATH) as f:
        return json.load(f)


def meter_presets():
    """assets/meter-presets.json without its _comment keys; {} when unreadable."""
    try:
        with open(PRESETS_PATH) as f:
            d = json.load(f)
        return {k: v for k, v in d.items() if isinstance(v, dict) and not k.startswith("_")}
    except Exception:
        return {}


def has_registry(cfg):
    return isinstance(cfg, dict) and "lane_registry" in cfg


def _registry(cfg):
    r = (cfg or {}).get("lane_registry")
    return r if isinstance(r, dict) else {}


def _merge(base, over):
    out = dict(base or {})
    if isinstance(over, dict):
        out.update(over)
    return out


def load_effective(cfg, include_disabled=False):
    """Ordered list of lane records (dicts with an "id"), enabled ones only unless asked otherwise."""
    cfg = cfg if isinstance(cfg, dict) else {}
    switches = cfg.get("lanes") if isinstance(cfg.get("lanes"), dict) else {}
    subs = cfg.get("subscriptions") if isinstance(cfg.get("subscriptions"), dict) else {}
    reg = _registry(cfg)
    built = builtins()
    lanes = []
    for lid, rec in built.items():
        r = dict(rec)
        if isinstance(switches.get(lid), bool):
            r["enabled"] = switches[lid]
        lanes.append((lid, r))
    known = {lid for lid, _ in lanes}
    for lid, rec in reg.items():
        if lid not in known:
            lanes.append((lid, {"enabled": True}))
    out = []
    for lid, r in lanes:
        sub = subs.get(lid)
        if isinstance(sub, dict):
            if sub.get("plan") is not None:
                r["plan"] = sub["plan"]
            if sub.get("price") is not None:
                r["price"] = _merge(r.get("price"), {"amount": sub["price"]})
        r = _merge(r, reg.get(lid))
        r["id"] = lid
        if include_disabled or r.get("enabled", True):
            out.append(r)
    return out


def _walk_strings(v, path):
    if isinstance(v, str):
        yield path, v
    elif isinstance(v, dict):
        for k, x in v.items():
            yield from _walk_strings(x, "%s.%s" % (path, k) if path else str(k))
    elif isinstance(v, list):
        for i, x in enumerate(v):
            yield from _walk_strings(x, "%s[%d]" % (path, i))


def looks_like_secret(s):
    s = s.strip()
    return s.startswith("sk-") or bool(B64_RE.match(s))


def _nonempty(v):
    return isinstance(v, str) and bool(v.strip())


def validate(cfg):
    """List of problems (strings). Secret values are never echoed."""
    errs = []
    if not has_registry(cfg):
        return errs
    raw = cfg["lane_registry"]
    if not isinstance(raw, dict):
        return ["lane_registry must be an object keyed by lane id"]
    built = builtins()
    for lid, rec in raw.items():
        if not isinstance(lid, str) or not ID_RE.match(lid):
            errs.append("lane %s: id must be lowercase letters, digits and hyphens" % lid)
        if not isinstance(rec, dict):
            errs.append("lane %s: record must be an object" % lid)
            continue
        for path, s in _walk_strings(rec, ""):
            if path != "key_ref" and looks_like_secret(s):
                errs.append("lane %s: field %s looks like a secret" % (lid, path))
        m = _merge(built.get(lid), rec)
        kind = m.get("kind")
        if kind not in KINDS:
            errs.append("lane %s: kind must be one of %s" % (lid, ", ".join(KINDS)))
        data = m.get("data")
        if data is not None and data not in DATA_LEVELS:
            errs.append("lane %s: data must be one of %s" % (lid, ", ".join(DATA_LEVELS)))
        meter = m.get("meter")
        if meter is not None:
            mt = meter.get("type") if isinstance(meter, dict) else None
            if mt not in METER_TYPES:
                errs.append("lane %s: meter.type must be one of %s" % (lid, ", ".join(METER_TYPES)))
            elif mt in ("balance-endpoint", "usage-endpoint"):
                if not (_nonempty(meter.get("preset")) or _nonempty(meter.get("url"))):
                    errs.append("lane %s: meter.type %s needs meter.preset or meter.url" % (lid, mt))
            elif mt == "local-file":
                if not _nonempty(meter.get("path")):
                    errs.append("lane %s: meter.type local-file needs meter.path" % lid)
        if "key_ref" in rec:
            kr = rec["key_ref"]
            if not (isinstance(kr, str) and KEY_REF_RE.match(kr)):
                errs.append("lane %s: key_ref must be keychain:<name> or env:<VAR>" % lid)
        v = m.get("tags")
        if v is not None and not (isinstance(v, list) and all(isinstance(x, str) for x in v)):
            errs.append("lane %s: tags must be a list of strings" % lid)
    return errs


def is_third_party(lane):
    return lane.get("kind") in THIRD_PARTY_KINDS


def cache_view(lanes):
    """The fields the quota cache carries per lane: no notes, urls or key_ref."""
    return [{"id": l["id"], "kind": l.get("kind"), "tags": list(l.get("tags") or []),
             "data": l.get("data")} for l in lanes]


def build_line(lanes):
    """The Lanes line from lane dicts (effective records or cache_view entries). "" when none."""
    if not lanes:
        return ""
    segs = []
    for l in lanes:
        parts = [l["id"]]
        if l.get("tags"):
            parts.append(",".join(l["tags"]))
        parts.append("data:" + l["data"] if l.get("data") else "data:unset")
        segs.append(" ".join(parts))
    segs += ["%s is a third-party service: sending content to it carries a data-leak risk." % l["id"] for l in lanes if is_third_party(l)]
    return "Lanes (user-declared; data = most that may be sent): " + " · ".join(segs)


def main(argv):
    path = None
    if "--config" in argv:
        i = argv.index("--config")
        path = argv[i + 1] if i + 1 < len(argv) else None
    cfg = read_config(path)
    if "--validate" in argv:
        errs = validate(cfg)
        print("\n".join(errs) if errs else "ok")
        return 1 if errs else 0
    lanes = load_effective(cfg)
    if "--json" in argv:
        print(json.dumps(lanes, indent=1, ensure_ascii=False))
    else:
        line = build_line(lanes)
        if line:
            print(line)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        sys.exit(0)
