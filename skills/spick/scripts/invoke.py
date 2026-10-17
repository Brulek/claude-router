#!/usr/bin/env python3
"""spick lane caller (stdlib only): send one prompt to a registered lane and print the answer.

Usage:
  invoke.py --lane ID --prompt-file PATH [--system-file PATH] [--model M]
            [--max-tokens N] [--timeout S] [--contains public|text|code] [--override-data REASON]
  invoke.py --lane ID --list-models [--timeout S]     (openai-chat lanes: print model ids, one per line)

stdout: the answer text only.  stderr: fact lines.
Exit codes: 0 ok; 2 usage error or unknown lane; 3 web-only lane, missing key, or auth 401/403;
            4 quota or rate 402/429; 5 any other error (timeout, 5xx, bad JSON, failed command);
            6 data level refused (nothing was sent); 7 answer cut off at the token limit (the partial
            answer is on stdout, INCOMPLETE on stderr).

Data level (fail-closed). A lane's `data` (public < text < code) is the most the user allows it to receive; `--contains`
declares what this prompt holds. It is a declared constraint, not sensitive-data detection. Without --contains the
prompt is taken as `code`, the strictest, so a `text` or `public` lane needs an explicit --contains at or below its
level. Under such a declaration the prompt file and the --system-file are still scanned for code-looking content
(a fenced block, or three or more code-looking lines) and the call is refused when it is found. A lane without
`data` takes anything. `--override-data "<reason>"` sends anyway and prints the reason as a fact line; it is for the
user's explicit say-so only.

Audit. Every prompt call appends one JSON line to <state>/invoke.jsonl (<config>/spick/, paths.py): the lane, the model,
the lane's declared data level, the level the call holds (--contains, or code by default or by the heuristic),
the override reason (null when none), the exit code, the tokens and the seconds. Never the key or the prompt.
scripts/audit.py lists the period's overrides.

The program refuses only what cannot work or what the user's declared limits forbid. It never judges the service.
Keys are read at call time and never reach argv, stdout, stderr or any file. No retries, no streaming.
"""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lanes  # noqa: E402
import paths  # noqa: E402

BEARER_RE = re.compile(r"Bearer\s+\S+", re.I)
MAX_ERR = 200
DEFAULT_MAX_TOKENS = 4096
APIS = ("openai-chat", "anthropic-messages")
# a line that looks like code: a definition or import keyword at its start, or indented with code punctuation
CODE_START_RE = re.compile(r"^\s*(def|class|function|import|from \S+ import|return|const|let|var|fn|func|package|#include)\b")
CODE_PUNCT_RE = re.compile(r"(=>|[{};]\s*$|^\s*[}\]]|\b\w+\(.*\)\s*[:{]?\s*$)")
FENCE_RE = re.compile(r"^\s*(```|~~~)", re.M)
CODE_LINES = 3


class Fail(Exception):
    def __init__(self, code, msg):
        Exception.__init__(self, msg)
        self.code = code
        self.msg = msg


def scrub(text, key=None):
    """Remove the key and any Bearer token, then cut to MAX_ERR characters."""
    text = BEARER_RE.sub("Bearer [redacted]", str(text))
    if key:
        text = text.replace(key, "[redacted]")
    text = " ".join(text.split())
    return text[:MAX_ERR]


def read_key(ref):
    if ref.startswith("keychain:"):
        name = ref[len("keychain:"):]
        try:
            r = subprocess.run(["security", "find-generic-password", "-s", name, "-a", "spick", "-w"],
                               capture_output=True, text=True, timeout=30)
            key = r.stdout.strip() if r.returncode == 0 else ""
        except FileNotFoundError:
            raise Fail(3, "key not found: keychain is macOS only on this platform; use env:<VAR>")
        except Exception:
            key = ""
        if not key:
            raise Fail(3, "key not found: keychain %s" % name)
        return key
    if ref.startswith("env:"):
        name = ref[len("env:"):]
        key = os.environ.get(name, "").strip()
        if not key:
            raise Fail(3, "key not found: env %s" % name)
        return key
    raise Fail(3, "key not found: unsupported key_ref")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def post_json(url, headers, body, timeout, key):
    """POST body as JSON; with body None, GET instead."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = {"Content-Type": "application/json"} if body is not None else {}
    h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST" if body is not None else "GET")
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        try:
            snippet = scrub(e.read().decode("utf-8", "replace"), key)
        except Exception:
            snippet = ""
        code = e.code
        detail = "HTTP %d%s" % (code, (": " + snippet) if snippet else "")
        if code in (401, 403):
            raise Fail(3, "auth failed, " + detail)
        if code in (402, 429):
            raise Fail(4, "quota or rate limit, " + detail)
        raise Fail(5, detail)
    except urllib.error.URLError as e:
        raise Fail(5, "request failed: " + scrub(e.reason, key))
    except (TimeoutError, OSError) as e:
        raise Fail(5, "request failed: " + scrub(e, key))
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        raise Fail(5, "bad JSON in response")


def _text_of(content):
    """The answer text: a string, or every text block of a list in order (a thinking or tool block is skipped)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part["text"] for part in content
                       if isinstance(part, dict) and isinstance(part.get("text"), str) and part.get("type", "text") == "text")
    return ""


def looks_like_code(text):
    """A fenced block, or CODE_LINES or more lines that look like code. A heuristic for the declared-level check:
    it catches pasted source under a text declaration, it does not find secrets."""
    if FENCE_RE.search(text or ""):
        return True
    n = 0
    for line in (text or "").splitlines():
        if not line.strip():
            continue
        indented = line[:1] in (" ", "\t")
        if CODE_START_RE.match(line) or (indented and CODE_PUNCT_RE.search(line)):
            n += 1
            if n >= CODE_LINES:
                return True
    return False


def sent_level(contains, texts):
    """What the call holds: --contains, code without it, code when a lower declaration meets code-looking content.
    The second value says why the heuristic raised it ("" when it did not)."""
    levels = lanes.DATA_LEVELS
    declared = contains or "code"
    if levels.index(declared) < levels.index("code") and any(looks_like_code(t) for t in texts if t):
        return "code", " (the prompt or system file looks like code)"
    return declared, ""


def check_data(lane_id, data, contains, texts, override):
    """Refuse (Fail 6) when what this call sends is above the lane's declared data level. Returns fact lines."""
    levels = lanes.DATA_LEVELS
    if data not in levels:
        return []   # a lane without a declared level takes anything
    sent, seen = sent_level(contains, texts)
    if levels.index(sent) <= levels.index(data):
        return []
    fact = "lane %s takes data:%s; this call sends %s%s%s" % (
        lane_id, data, sent, seen, "" if contains else " (no --contains: taken as code)")
    if not override:
        raise Fail(6, "refused, nothing sent: %s. Pass --contains at or below %s if that is true, pick another lane, "
                      "or --override-data \"<reason>\"" % (fact, data))
    return ["data override: %s; reason: %s" % (fact, override)]


def call_openai(base, key, model, system, prompt, max_tokens, timeout):
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    headers = {"Authorization": "Bearer " + key} if key else {}
    d = post_json(base.rstrip("/") + "/chat/completions", headers,
                  {"model": model, "messages": messages, "max_tokens": max_tokens}, timeout, key)
    try:
        text = _text_of(d["choices"][0]["message"]["content"])
    except Exception:
        raise Fail(5, "no answer in response")
    cut = d["choices"][0].get("finish_reason") == "length"
    u = d.get("usage") if isinstance(d.get("usage"), dict) else {}
    return text, u.get("prompt_tokens"), u.get("completion_tokens"), cut


def call_anthropic(base, key, model, system, prompt, max_tokens, timeout):
    body = {"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}]}
    if system:
        body["system"] = system
    headers = {"anthropic-version": "2023-06-01"}
    if key:
        headers["x-api-key"] = key
    d = post_json(base.rstrip("/") + "/v1/messages", headers, body, timeout, key)
    try:
        text = _text_of(d["content"])
    except Exception:
        raise Fail(5, "no answer in response")
    cut = d.get("stop_reason") == "max_tokens"
    u = d.get("usage") if isinstance(d.get("usage"), dict) else {}
    return text, u.get("input_tokens"), u.get("output_tokens"), cut


def call_cli(template, prompt_file, prompt, timeout):
    try:
        argv = shlex.split(template)
    except ValueError:
        raise Fail(2, "invoke.cli is not a valid command template")
    if not argv or template.lstrip().lower().startswith("see "):
        raise Fail(2, "invoke.cli is not a command template; use the call in references/providers.md")
    uses_file = any("{prompt_file}" in a for a in argv)
    argv = [a.replace("{prompt_file}", prompt_file) for a in argv]
    try:
        extra = {"stdin": subprocess.DEVNULL} if uses_file else {"input": prompt}
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, **extra)
    except subprocess.TimeoutExpired:
        raise Fail(5, "command timed out after %ss" % timeout)
    except OSError as e:
        raise Fail(5, "command failed to start: " + scrub(e))
    if r.returncode != 0:
        raise Fail(5, "command exited %d: %s" % (r.returncode, scrub(r.stderr)))
    return r.stdout


def read_text(path, what):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        raise Fail(2, "cannot read %s file: %s" % (what, e.strerror or "error"))


def find_lane(a):
    cfg = lanes.read_config()
    lane = next((ln for ln in lanes.load_effective(cfg) if ln["id"] == a.lane), None)
    if lane is None:
        raise Fail(2, "unknown or disabled lane: %s" % a.lane)
    if lane.get("kind") == "web-only":
        raise Fail(3, "lane %s is web-only and cannot be called; paste the prompt into the site yourself" % a.lane)
    return lane


def list_models(a):
    """GET {base_url}/models for an openai-chat lane and print the ids. Read-only; the key is never printed."""
    lane = find_lane(a)
    inv = lane.get("invoke") if isinstance(lane.get("invoke"), dict) else {}
    base = inv.get("base_url")
    if inv.get("api") != "openai-chat" or not isinstance(base, str) or not base:
        raise Fail(2, "--list-models needs an openai-chat lane with invoke.base_url (lane %s)" % a.lane)
    key, ref = None, lane.get("key_ref")
    if ref:
        key = read_key(ref)
    elif lane.get("kind") != "local":
        raise Fail(3, "key not found: lane %s has no key_ref" % a.lane)
    try:
        d = post_json(base.rstrip("/") + "/models", {"Authorization": "Bearer " + key} if key else {}, None, a.timeout, key)
    except Fail as f:
        raise Fail(f.code, scrub(f.msg, key))
    items = d.get("data") if isinstance(d, dict) else None
    ids = [m["id"] for m in items if isinstance(m, dict) and isinstance(m.get("id"), str)] if isinstance(items, list) else []
    if not ids:
        raise Fail(5, "no model list in response")
    out = "\n".join(ids) + "\n"
    sys.stdout.write(out.replace(key, "[redacted]") if key else out)
    return 0


def log_call(rec, code, seconds, key):
    """Append the call's audit line to <state>/invoke.jsonl. Best effort: a failed write is one stderr line, never a
    changed exit code. The key is never a field; a reason that happens to hold it is redacted."""
    line = dict(rec, exit=code, seconds=round(seconds, 1))
    if key and isinstance(line.get("override"), str):
        line["override"] = line["override"].replace(key, "[redacted]")
    try:
        p = paths.path("invoke")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
    except OSError as e:
        sys.stderr.write("spick-invoke: the call was not logged: %s\n" % scrub(e.strerror or e))


def run(a, rec=None, secret=None):
    """`rec` collects the audit line's fields as they become known; `secret` gets the key, to keep it out of the log."""
    rec = {} if rec is None else rec
    secret = [] if secret is None else secret
    if a.list_models:
        return list_models(a)
    if not a.prompt_file:
        raise Fail(2, "--prompt-file is required")
    if a.contains is not None and a.contains not in lanes.DATA_LEVELS:
        raise Fail(2, "--contains must be one of %s" % ", ".join(lanes.DATA_LEVELS))
    lane = find_lane(a)
    rec["data"] = lane.get("data") if lane.get("data") in lanes.DATA_LEVELS else None
    inv = lane.get("invoke") if isinstance(lane.get("invoke"), dict) else {}
    api, cli = inv.get("api"), inv.get("cli")
    if api not in APIS and not isinstance(cli, str):
        raise Fail(2, "lane %s has no invoke.api (%s) or invoke.cli" % (a.lane, " or ".join(APIS)))
    prompt = read_text(a.prompt_file, "prompt")
    system = read_text(a.system_file, "system") if a.system_file else None
    if a.override_data is not None and not a.override_data.strip():
        raise Fail(2, "--override-data needs a reason")
    rec["sent"] = sent_level(a.contains, (prompt, system))[0]
    rec["model"] = a.model or inv.get("model") or ("cli" if api not in APIS else None)
    facts = check_data(a.lane, lane.get("data"), a.contains, (prompt, system), a.override_data)
    # the user's say-so as given, whether or not this call needed it (the stderr fact line says when it did)
    rec["override"] = scrub(a.override_data) if a.override_data else None
    for f in facts:
        sys.stderr.write("spick-invoke: %s\n" % scrub(f))

    t0 = time.time()
    key = None
    cut = False
    if api in APIS:
        base = inv.get("base_url")
        model = a.model or inv.get("model")
        if not isinstance(base, str) or not base:
            raise Fail(2, "lane %s has no invoke.base_url" % a.lane)
        if not model:
            raise Fail(2, "no model: pass --model or set invoke.model on lane %s" % a.lane)
        ref = lane.get("key_ref")
        if ref:
            key = read_key(ref)
            secret.append(key)
        elif lane.get("kind") != "local":
            raise Fail(3, "key not found: lane %s has no key_ref" % a.lane)
        max_tokens = a.max_tokens or inv.get("max_tokens") or DEFAULT_MAX_TOKENS
        fn = call_openai if api == "openai-chat" else call_anthropic
        try:
            text, tin, tout, cut = fn(base, key, model, system, prompt, int(max_tokens), a.timeout)
        except Fail as f:
            raise Fail(f.code, scrub(f.msg, key))
        rec["tokens"] = {"in": tin, "out": tout} if tin is not None or tout is not None else None
        if not text.strip() and not cut:
            raise Fail(5, "empty answer")
        tokens = "%s in / %s out tokens" % (tin, tout) if tin is not None and tout is not None else "tokens unknown"
    else:
        model = "cli"
        text = call_cli(cli, a.prompt_file, prompt, a.timeout)
        tokens = "tokens unknown"
    if key:
        text = text.replace(key, "[redacted]")
    sys.stdout.write(text if text.endswith("\n") else text + "\n")
    sys.stderr.write("spick-invoke: %s %s %s, %.1fs\n" % (a.lane, model, tokens, time.time() - t0))
    if cut:
        # a reasoning model can spend the whole budget before answering: say so, never pass a stub off as the answer
        sys.stderr.write("spick-invoke: INCOMPLETE: the answer stopped at the token limit (%s); raise --max-tokens\n" % max_tokens)
        return 7
    return 0


def main(argv):
    p = argparse.ArgumentParser(prog="invoke.py", description="Call one spick lane with a prompt file.")
    p.add_argument("--lane", required=True)
    p.add_argument("--prompt-file")
    p.add_argument("--system-file")
    p.add_argument("--model")
    p.add_argument("--max-tokens", type=int)
    p.add_argument("--timeout", type=float, default=300)
    p.add_argument("--list-models", action="store_true", help="print the lane's model ids (openai-chat only) and exit")
    p.add_argument("--contains", help="what the prompt holds at most: public, text or code (default: code)")
    p.add_argument("--override-data", metavar="REASON", help="send although the data level forbids it; the reason is printed")
    a = p.parse_args(argv)
    # the audit line of a prompt call (a model listing sends no prompt and is not logged)
    rec = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "lane": a.lane, "model": a.model, "data": None,
           "sent": None, "override": None, "tokens": None}
    secret = []
    t0 = time.time()
    code = 5
    try:
        code = run(a, rec, secret)
    except Fail as f:
        sys.stderr.write("spick-invoke: %s\n" % scrub(f.msg))
        code = f.code
    except Exception as e:
        sys.stderr.write("spick-invoke: error: %s\n" % scrub(type(e).__name__))
        code = 5
    if not a.list_models:
        log_call(rec, code, time.time() - t0, secret[0] if secret else None)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
