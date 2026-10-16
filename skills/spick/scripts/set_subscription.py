#!/usr/bin/env python3
"""spick set_subscription (stdlib only): record which plan the user is on for a built-in provider, or list them.

Usage:
  set_subscription.py --list
  set_subscription.py --provider claude|codex|gemini|grok --plan "<text>" [--price "<text>"] [--dry-run]
  set_subscription.py --provider P --remove [--dry-run]

The `subscriptions` object in spick.json decides which providers quota.py collects and the Quota line shows;
a provider not listed is not subscribed. --list prints it as JSON. --plan sets the plan (one line, at most 80
characters); --price sets the price (one line, at most 40; "-" clears it); a price not given is kept. --remove
drops the provider. A value that looks like a secret is refused and never echoed.

Writes $CLAUDE_CONFIG_DIR/spick.json (default ~/.claude): copies it to spick.json.bak, writes the change to a
tmp file, validates it and only then replaces the original. Exit 2 with a one-line reason when refused.
--dry-run prints the resulting subscriptions object and writes nothing.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lanes  # noqa: E402

PROVIDERS = ("claude", "codex", "gemini", "grok")   # quota.PROVIDERS; quota imports lanes, so it is not imported here
MAX_PLAN = 80
MAX_PRICE = 40


class Refuse(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        sys.stderr.write("set_subscription: %s\n" % message.splitlines()[0])
        sys.exit(2)


def one_line(v, what, limit):
    """v stripped; Refuse when empty, multi-line, too long or secret-shaped (the message never contains v)."""
    if lanes.looks_like_secret(v):
        raise Refuse("the %s looks like a secret; not written" % what)
    if not v.strip() or "\n" in v or "\r" in v:
        raise Refuse("%s must be one non-empty line" % what)
    if len(v.strip()) > limit:
        raise Refuse("%s is longer than %d characters" % (what, limit))
    return v.strip()


def read_cfg(path):
    if not os.path.isfile(path):
        raise Refuse("%s not found; run spick setup first" % path)
    try:
        with open(path) as f:
            cfg = json.load(f)
    except Exception as e:
        raise Refuse("cannot read %s: %s" % (path, e.__class__.__name__))
    if not isinstance(cfg, dict):
        raise Refuse("%s is not a JSON object" % path)
    subs = cfg.get("subscriptions")
    if subs is not None and not isinstance(subs, dict):
        raise Refuse("subscriptions must be an object")
    return cfg


def apply(subs, provider, plan, price, remove):
    """The new subscriptions object: subs with one provider set or removed."""
    out = json.loads(json.dumps(subs or {}))
    if remove:
        if provider not in out:
            raise Refuse("%s is not listed" % provider)
        del out[provider]
        return out
    rec = out.get(provider) if isinstance(out.get(provider), dict) else {}
    rec = dict(rec, plan=plan)
    if price == "-":
        rec.pop("price", None)
    elif price is not None:
        rec["price"] = price
    out[provider] = rec
    return out


def run(a):
    path = lanes.config_path()
    if a.list:
        print(json.dumps(read_cfg(path).get("subscriptions") or {}, indent=1, ensure_ascii=False))
        return 0
    if not a.provider:
        raise Refuse("need --list, or --provider with --plan or --remove")
    if a.provider not in PROVIDERS:
        raise Refuse("provider must be one of %s" % ", ".join(PROVIDERS))
    if a.remove and (a.plan is not None or a.price is not None):
        raise Refuse("--remove takes no --plan or --price")
    if not a.remove and a.plan is None:
        raise Refuse("need --plan (or --remove)")
    plan = None if a.remove else one_line(a.plan, "plan", MAX_PLAN)
    price = None
    if a.price is not None:
        price = "-" if a.price.strip() == "-" else one_line(a.price, "price", MAX_PRICE)
    cfg = read_cfg(path)
    subs = apply(cfg.get("subscriptions"), a.provider, plan, price, a.remove)
    if a.dry_run:
        print(json.dumps(subs, indent=2, ensure_ascii=False))
        return 0
    new = dict(cfg)
    new["subscriptions"] = subs
    try:
        lanes.write_config(path, new)
    except ValueError as e:
        raise Refuse(str(e).replace("\n  ", " ").replace("\n", " "))
    print("%s %s; backup at spick.json.bak" % ("removed" if a.remove else "set", a.provider))
    lanes.after_write()
    return 0


def main(argv):
    p = Parser(description="record the plan of a subscribed provider in spick.json")
    p.add_argument("--list", action="store_true")
    p.add_argument("--provider")
    p.add_argument("--plan")
    p.add_argument("--price")
    p.add_argument("--remove", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    try:
        return run(a)
    except Refuse as e:
        sys.stderr.write("set_subscription: %s\n" % e)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
