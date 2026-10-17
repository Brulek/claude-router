#!/usr/bin/env python3
"""spick paths (stdlib only): the one rule for where spick's files live.

  config dir   $CLAUDE_CONFIG_DIR when set and not empty, else ~/.claude (Claude Code's own rule)
  spick.json   <config>/spick.json (stays beside settings.json)
  state dir    <config>/spick/: quota.json, quota.lock, turns/<sessionId>.jsonl (one file per session, so two
               sessions never write one file), mod-active/<sessionId>, backup/, plus spick-spend/ and
               spick-gate.jsonl, the round-1 records moved here by --migrate under their own names (spend.py reads
               the old per-session spend files from there)

The mod's hooks/paths.ts follows the same rule; triage-hook.sh computes it inline (bash, so the
checklist prints without python). Every Python script asks this module instead of joining paths itself.

Usage:
  paths.py <name>     print one path: config, spick.json, state, quota.json, quota.lock, turns,
                      mod-active, backup, spend, gate
  paths.py --migrate  move the round-1 state files (spick-quota.json, spick-spend/, spick-gate.jsonl,
                      spick-backup/) into the state dir, once; prints one line per move. Exit 0, or 1
                      when a move failed (the line says which).
"""
import os
import re
import shutil
import sys

STATE = "spick"
# name -> file or directory inside the state dir
IN_STATE = {
    "quota.json": "quota.json",
    "quota.lock": "quota.lock",
    "turns": "turns",
    "mod-active": "mod-active",
    "backup": "backup",
    "spend": "spick-spend",
    "gate": "spick-gate.jsonl",
    # invoke.py's call log: one JSON line per lane call (data levels and overrides; never a key)
    "invoke": "invoke.jsonl",
}
# round-1 names in the config dir -> their name in the state dir
LEGACY = (
    ("spick-quota.json", "quota.json"),
    ("spick-spend", "spend"),
    ("spick-gate.jsonl", "gate"),
    ("spick-backup", "backup"),
)
# round-1 single marker files, replaced by mod-active/<session>; removed by --migrate
LEGACY_MARKER = ".spick-mod-active"
MARKER_MAX_AGE_S = 24 * 3600


def config_dir():
    d = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return d.rstrip("/") or "/"


def state_dir():
    return os.path.join(config_dir(), STATE)


def path(name):
    if name == "config":
        return config_dir()
    if name == "spick.json":
        return os.path.join(config_dir(), "spick.json")
    if name == "state":
        return state_dir()
    if name in IN_STATE:
        return os.path.join(state_dir(), IN_STATE[name])
    raise KeyError(name)


def turns_dir():
    return path("turns")


def turn_file(session_id):
    """The turn record of one session: <state>/turns/<sessionId>.jsonl (the id made safe as for markers)."""
    return os.path.join(turns_dir(), marker_name(session_id) + ".jsonl")


def marker_name(session_id):
    """A session id as a file name, as paths.ts safeName: anything but letters, digits, dot, dash and underscore
    becomes _, and leading dots become one _, so the id cannot leave mod-active/."""
    return re.sub(r"^\.+", "_", re.sub(r"[^A-Za-z0-9._-]", "_", session_id))


def _merge_move(src, dst):
    """Move src to dst. A file onto an existing file: a .jsonl log is appended, anything else (a cache) gives way
    to the newer copy already in place. A directory onto a directory: each entry moves unless the name is taken."""
    if not os.path.lexists(dst):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        return
    if os.path.isdir(src) and os.path.isdir(dst):
        for entry in sorted(os.listdir(src)):
            s, d = os.path.join(src, entry), os.path.join(dst, entry)
            if not os.path.lexists(d):
                shutil.move(s, d)
        if os.listdir(src):
            raise OSError("%s: some entries already exist in %s; left in place" % (src, dst))
        os.rmdir(src)
        return
    if dst.endswith(".jsonl") and os.path.isfile(src) and os.path.isfile(dst):
        # the old log is older: it goes first
        with open(src) as f:
            old = f.read()
        with open(dst) as f:
            new = f.read()
        if old and not old.endswith("\n"):
            old += "\n"
        tmp = dst + ".spick-tmp"
        with open(tmp, "w") as f:
            f.write(old + new)
        os.replace(tmp, dst)
        os.unlink(src)
        return
    if os.path.isfile(src) and os.path.isfile(dst):
        os.unlink(src)
        return
    raise OSError("%s and %s are not the same kind of entry; left in place" % (src, dst))


def migrate():
    """Move the round-1 state files into the state dir. Looks in the config dir and, when CLAUDE_CONFIG_DIR points
    elsewhere, in ~/.claude too (the round-1 mod wrote there whatever the config dir). Returns (moved, failed):
    lists of human-readable lines."""
    moved, failed = [], []
    roots = [config_dir()]
    home = os.path.join(os.path.expanduser("~"), ".claude")
    if os.path.realpath(home) != os.path.realpath(roots[0]):
        roots.append(home)
    for root in roots:
        for old, new in LEGACY:
            src = os.path.join(root, old)
            if not os.path.lexists(src):
                continue
            dst = path(new)
            try:
                _merge_move(src, dst)
                moved.append("moved  %s -> %s" % (src, dst))
            except OSError as e:
                failed.append("failed %s (%s)" % (src, e))
        m = os.path.join(root, LEGACY_MARKER)
        if os.path.lexists(m):
            try:
                os.unlink(m)
                moved.append("removed %s (replaced by %s/<session>)" % (m, path("mod-active")))
            except OSError as e:
                failed.append("failed %s (%s)" % (m, e))
    return moved, failed


def main(argv):
    if argv == ["--migrate"]:
        moved, failed = migrate()
        for line in moved + failed:
            print("  " + line)
        return 1 if failed else 0
    if len(argv) == 1:
        try:
            print(path(argv[0]))
            return 0
        except KeyError:
            pass
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
