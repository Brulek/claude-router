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
case-insensitively; any other entry as a substring; a web address counts as a web sign. Code blocks, URLs and paths
are blanked first, and a keyword right after a negation (rules.json "negations") does not fire.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RULES_PATH = os.path.join(os.path.dirname(HERE), "assets", "rules.json")
MAX_SHOWN = 3
WEB_ADDRESS = "a web address"
# Hint v2: what is blanked before matching (mod/spick-dashboard/hooks/hint.ts does the same, in the same order).
# A fenced code block (``` or ~~~, unterminated runs to the end), then a URL (ASCII only, so a Chinese sentence glued
# to it survives; it still counts as a web sign), then a path-like token: a run of path characters holding a / or
# starting with ~ (src/review.py, ~/Downloads, ./x, ../y). Each becomes one space.
FENCE_RE = re.compile(r"(```|~~~)[\s\S]*?(?:\1|$)")
URL_RE = re.compile(r"https?://[!-~]+", re.I)
TOKEN_RE = re.compile(r"[A-Za-z0-9_.~/-]+")
# a keyword preceded by a negation that ends at most this many characters before it does not fire (不要修改, don't fix)
NEG_WINDOW = 6
_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")

HEAD = "   Hint (keywords in this prompt, not a verdict): "
TAIL = ". Keeping a hinted task yourself needs a one-line reason in the reply, on a line starting with `Kept:`."


def load_rules(path=RULES_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_table(path=RULES_PATH):
    """{kind: [keywords]} in priority order."""
    return load_rules(path)["hints"]


_RULES = load_rules()
# what each kind's keywords imply; {t} is the matched words
PHRASES = _RULES["phrases"]
NEGATIONS = _RULES["negations"]


def blank(text):
    """(the text with code blocks, URLs and path-like tokens blanked, whether it held a URL)."""
    t = FENCE_RE.sub(" ", text)
    had_url = URL_RE.search(t) is not None
    t = URL_RE.sub(" ", t)
    t = TOKEN_RE.sub(lambda m: " " if "/" in m.group() or m.group().startswith("~") else m.group(), t)
    return t, had_url


def spans(low, word):
    """Where `word` occurs in `low` (the text with only A-Z lowered, so positions match the text): an ASCII entry on
    word boundaries with any whitespace inside, any other entry as a substring."""
    if word.isascii():
        pat = r"(?<![a-z0-9])" + r"\s+".join(re.escape(p) for p in word.lower().split()) + r"(?![a-z0-9])"
        return [(m.start(), m.end()) for m in re.finditer(pat, low)]
    out, i = [], low.find(word)
    while i >= 0:
        out.append((i, i + len(word)))
        i = low.find(word, i + 1)
    return out


def find_hints(text, table=None, negations=None):
    """[(kind, [matched words])] in the table's order; words a longer match already covers are left out. A word fires
    when one of its occurrences has no negation ending within NEG_WINDOW characters before it; a negation inside a
    keyword (不要 in 要不要) is not one."""
    table = table or load_table()
    negations = NEGATIONS if negations is None else negations
    blanked, had_url = blank(text or "")
    low = blanked.translate(_LOWER)
    hits = {kind: [(w, spans(low, w)) for w in words] for kind, words in table.items()}
    inside = [sp for ws in hits.values() for _, sps in ws for sp in sps]
    neg_ends = [e for n in negations for s, e in spans(low, n)
                if not any(a <= s and e <= b and (a, b) != (s, e) for a, b in inside)]

    def fires(sps):
        return any(not any(start - NEG_WINDOW <= e <= start for e in neg_ends) for start, _ in sps)
    out = []
    for kind, ws in hits.items():
        found = [WEB_ADDRESS] if kind == "web" and had_url else []
        for w, sps in ws:
            if fires(sps) and not any(w in f for f in found):
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
