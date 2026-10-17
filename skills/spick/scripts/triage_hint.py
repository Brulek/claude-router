#!/usr/bin/env python3
"""spick triage hint (stdlib only): the keywords of a prompt and the default route they imply, as one line.

The program states what it found; the model judges. A hint is advice the model may overrule with a
one-line reason, never a verdict. It exists because the main session is the smallest model and the
one that profits from keeping a task: a deterministic pass over the prompt names the default route
before that model reads the checklist, the same job claude-agent-tools' ruleDecide does in code.

Usage:
  triage_hint.py --stdin-json     read the UserPromptSubmit hook input ({"prompt": ...}) from stdin
  triage_hint.py --text TEXT      classify TEXT
Prints the Hint line, or nothing when no keyword matched. Exit 0 always; a broken input prints nothing.

The keyword table and the phrases are in assets/rules.json ("hints", "phrases"); render_rules.py copies them into
mod/spick-dashboard/hooks/hint.ts. Kinds are in priority order; an ASCII entry matches on word boundaries,
case-insensitively; any other entry as a substring; a web address counts as a web sign.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RULES_PATH = os.path.join(os.path.dirname(HERE), "assets", "rules.json")
MAX_SHOWN = 3
URL_RE = re.compile(r"https?://\S+", re.I)
WEB_ADDRESS = "a web address"

HEAD = "   Hint (keywords in this prompt, not a verdict): "
TAIL = ". Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`."


def load_rules(path=RULES_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_table(path=RULES_PATH):
    """{kind: [keywords]} in priority order."""
    return load_rules(path)["hints"]


# what each kind's keywords imply; {t} is the matched words
PHRASES = load_rules()["phrases"]


def _matches(text, low, word):
    if word.isascii():
        pat = r"(?<![a-z0-9])" + r"\s+".join(re.escape(p) for p in word.lower().split()) + r"(?![a-z0-9])"
        return re.search(pat, low) is not None
    return word in text


def find_hints(text, table=None):
    """[(kind, [matched words])] in the table's order; words a longer match already covers are left out."""
    table = table or load_table()
    text = text or ""
    low = text.lower()
    out = []
    for kind, words in table.items():
        found = []
        if kind == "web" and URL_RE.search(text):
            found.append(WEB_ADDRESS)
        for w in words:
            if _matches(text, low, w) and not any(w in f for f in found):
                found.append(w)
        if found:
            out.append((kind, found))
    return out


def hint_line(text, table=None):
    hints = find_hints(text, table)
    if not hints:
        return None
    parts = [PHRASES[k].format(t=", ".join(ws[:MAX_SHOWN])) for k, ws in hints]
    return HEAD + "; ".join(parts) + TAIL


def main(argv):
    text = None
    if "--text" in argv:
        i = argv.index("--text")
        text = argv[i + 1] if i + 1 < len(argv) else ""
    elif "--stdin-json" in argv:
        try:
            d = json.loads(sys.stdin.read() or "{}")
            text = d.get("prompt") if isinstance(d, dict) else None
        except Exception:
            text = None
    else:
        sys.stderr.write(__doc__)
        return 2
    try:
        line = hint_line(text or "")
    except Exception:
        line = None
    if line:
        sys.stdout.write(line + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
