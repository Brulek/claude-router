#!/usr/bin/env python3
"""spick lane caller (stdlib only): send one prompt to a registered lane and print the answer.

Usage:
  invoke.py --lane ID --prompt-file PATH [--system-file PATH] [--model M]
            [--max-tokens N] [--timeout S] [--contains public|text|code]
  invoke.py --lane ID --list-models [--timeout S]     (openai-chat lanes: print model ids, one per line)

stdout: the answer text only.  stderr: one fact line.
Exit codes: 0 ok; 2 usage error or unknown lane; 3 web-only lane, missing key, or auth 401/403;
            4 quota or rate 402/429; 5 any other error (timeout, 5xx, bad JSON, failed command).

The program refuses only what cannot work: a web-only lane, or an api lane whose key is missing.
It never judges the content or the service. Keys are read at call time and never reach argv,
stdout, stderr or any file. No retries, no streaming.
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

BEARER_RE = re.compile(r"Bearer\s+\S+", re.I)
MAX_ERR = 200
DEFAULT_MAX_TOKENS = 4096
APIS = ("openai-chat", "anthropic-messages")


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
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str) and part.get("type", "text") == "text":
                return part["text"]
    return ""


def call_openai(base, key, model, system, prompt, max_tokens, timeout):
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    headers = {"Authorization": "Bearer " + key} if key else {}
    d = post_json(base.rstrip("/") + "/chat/completions", headers,
                  {"model": model, "messages": messages, "max_tokens": max_tokens}, timeout, key)
    try:
        text = _text_of(d["choices"][0]["message"]["content"])
    except Exception:
        raise Fail(5, "no answer in response")
    u = d.get("usage") if isinstance(d.get("usage"), dict) else {}
    return text, u.get("prompt_tokens"), u.get("completion_tokens")


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
    u = d.get("usage") if isinstance(d.get("usage"), dict) else {}
    return text, u.get("input_tokens"), u.get("output_tokens")


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
    lane = next((l for l in lanes.load_effective(cfg) if l["id"] == a.lane), None)
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


def run(a):
    if a.list_models:
        return list_models(a)
    if not a.prompt_file:
        raise Fail(2, "--prompt-file is required")
    if a.contains is not None and a.contains not in lanes.DATA_LEVELS:
        raise Fail(2, "--contains must be one of %s" % ", ".join(lanes.DATA_LEVELS))
    lane = find_lane(a)
    inv = lane.get("invoke") if isinstance(lane.get("invoke"), dict) else {}
    api, cli = inv.get("api"), inv.get("cli")
    if api not in APIS and not isinstance(cli, str):
        raise Fail(2, "lane %s has no invoke.api (%s) or invoke.cli" % (a.lane, " or ".join(APIS)))
    # self-report only: warn, never refuse
    data = lane.get("data")
    if a.contains and data in lanes.DATA_LEVELS and lanes.DATA_LEVELS.index(data) < lanes.DATA_LEVELS.index(a.contains):
        sys.stderr.write("spick-invoke: warning: lane %s declares data:%s but the prompt is marked %s\n" % (a.lane, data, a.contains))
    prompt = read_text(a.prompt_file, "prompt")
    system = read_text(a.system_file, "system") if a.system_file else None

    t0 = time.time()
    key = None
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
        elif lane.get("kind") != "local":
            raise Fail(3, "key not found: lane %s has no key_ref" % a.lane)
        max_tokens = a.max_tokens or inv.get("max_tokens") or DEFAULT_MAX_TOKENS
        fn = call_openai if api == "openai-chat" else call_anthropic
        try:
            text, tin, tout = fn(base, key, model, system, prompt, int(max_tokens), a.timeout)
        except Fail as f:
            raise Fail(f.code, scrub(f.msg, key))
        if not text.strip():
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
    p.add_argument("--contains", help="self-report of the most the prompt holds: public, text or code")
    a = p.parse_args(argv)
    try:
        return run(a)
    except Fail as f:
        sys.stderr.write("spick-invoke: %s\n" % scrub(f.msg))
        return f.code
    except Exception as e:
        sys.stderr.write("spick-invoke: error: %s\n" % scrub(type(e).__name__))
        return 5


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
