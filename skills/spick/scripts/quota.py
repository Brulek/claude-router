#!/usr/bin/env python3
"""spick quota collector (stdlib only).

The program only COLLECTS raw facts and PRESENTS them. It makes no judgement: no thresholds, no
"use X when Y". The model reading the checklist weighs the facts itself.

Per subscribed provider (spick.json "subscriptions") it records:
  provider, plan, price, source, sampled_at, age_s, status, windows[{name, used_pct, resets_at, reset}]
  status is only a fact about the sample's age: fresh (< 30 min), stale (older), unknown (no data).
  A window whose resets_at has passed is reported with used_pct null and reset true, never as 0.

Sources (probed 2026-10-13, see scripts/testdata/):
  claude  ~/.claude.json  cachedUsageUtilization  (limits[] if present, else utilization.*)
  codex   `codex -s read-only -a never app-server`, JSON-RPC account/rateLimits/read;
          fallback: newest ~/.codex/sessions/**/rollout-*.jsonl payload.rate_limits
  gemini  `agy -p /usage --output-format json`
  grok    `grok agent stdio`, initialize, authenticate(cached_token), then `_x.ai/billing`.
          That call returns the billing period only (no used percent), so grok stays unknown.

Usage:
  quota.py [--json]            show the cache (no cache yet: refresh once, synchronously)
  quota.py --refresh [--json]  collect now, write the cache, show it
  quota.py --line              the one checklist line from the cache; never waits for a refresh
  quota.py --touch             start a background refresh if the cache is older than 10 minutes
  quota.py --bg                (internal) the detached refresh
  quota.py --relane            rebuild only the "lanes" part of the existing cache from spick.json (no
                               collectors, no network, no subprocess); no cache file: does nothing
Cache: $CLAUDE_CONFIG_DIR/spick-quota.json (default ~/.claude), written atomically.
"""
import concurrent.futures
import datetime
import glob
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

import invoke as invoke_mod   # the one key resolver (read_key) and the no-redirect handler
import lanes as lanes_mod

FRESH_S = 30 * 60          # status word boundary: "fresh" below this age (a label, not a routing rule)
CACHE_TTL_S = 10 * 60      # refresh in the background when the cache is older than this
LOCK_STALE_S = 5 * 60      # a lock dir older than this was left by a dead process
CODEX_TIMEOUT = 20
AGY_TIMEOUT = 90
GROK_TIMEOUT = 20
HEALTH_TIMEOUT = 3
METER_TIMEOUT = 10
METER_ERR_CHARS = 80
PROVIDERS = ("claude", "codex", "gemini", "grok")


# ---------- paths and small helpers ----------

def config_dir():
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def cache_path():
    return os.path.join(config_dir(), "spick-quota.json")


def lock_path():
    return os.path.join(config_dir(), "spick-quota.lock")


def iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    """ISO-8601 (Z or +00:00, optional fraction) -> epoch seconds, or None."""
    if not isinstance(s, str):
        return None
    try:
        s = s.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        d = datetime.datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=datetime.timezone.utc)
        return d.timestamp()
    except Exception:
        return None


def num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def window_name(minutes):
    m = int(minutes)
    if m % 1440 == 0:
        return "%dd" % (m // 1440)
    if m % 60 == 0:
        return "%dh" % (m // 60)
    return "%dm" % m


def win(name, used_pct, resets_ts):
    return {"name": name, "used_pct": None if used_pct is None else round(used_pct, 1),
            "resets_at": iso(resets_ts) if resets_ts is not None else None, "reset": False}


def entry(provider, source=None, sampled_ts=None, windows=None, reason=None):
    e = {"provider": provider, "plan": None, "price": None, "source": source,
         "sampled_at": iso(sampled_ts) if sampled_ts is not None else None,
         "age_s": None, "windows": windows or [], "status": "unknown"}
    if reason:
        e["reason"] = reason
    return e


def finalize(e, now):
    """Recompute the facts that depend on the clock: age, status word, windows past their reset."""
    s = parse_iso(e.get("sampled_at"))
    e["age_s"] = None if s is None else max(0, int(now - s))
    e["status"] = "unknown" if s is None else ("fresh" if now - s < FRESH_S else "stale")
    for w in e.get("windows", []):
        r = parse_iso(w.get("resets_at"))
        if r is not None and r <= now:
            w["used_pct"] = None
            w["reset"] = True
        else:
            w.setdefault("reset", False)
    return e


# ---------- parsers (pure; fixtures in scripts/testdata/) ----------

def parse_claude(d, now):
    """~/.claude.json content (dict). limits[] if present, else utilization.five_hour / seven_day."""
    c = (d or {}).get("cachedUsageUtilization")
    if not isinstance(c, dict) or not isinstance(c.get("utilization"), dict):
        return entry("claude", "~/.claude.json", reason="no cachedUsageUtilization")
    u = c["utilization"]
    fetched = num(c.get("fetchedAtMs"))
    sampled = fetched / 1000 if fetched else None
    ws = []
    limits = u.get("limits")
    if isinstance(limits, list) and limits:
        for L in limits:
            if not isinstance(L, dict) or num(L.get("percent")) is None:
                continue
            kind = L.get("kind") or "limit"
            name = {"session": "5h", "weekly_all": "7d"}.get(kind, kind)
            if kind == "weekly_scoped":
                model = ((L.get("scope") or {}).get("model") or {}).get("display_name")
                name = "7d " + model if model else "7d scoped"
            ws.append(win(name, num(L["percent"]), parse_iso(L.get("resets_at"))))
    else:
        for key, name in (("five_hour", "5h"), ("seven_day", "7d")):
            w = u.get(key)
            if isinstance(w, dict) and num(w.get("utilization")) is not None:
                ws.append(win(name, num(w["utilization"]), parse_iso(w.get("resets_at"))))
    if not ws:
        return entry("claude", "~/.claude.json", reason="no usage windows in cache")
    return entry("claude", "~/.claude.json", sampled, ws)


def parse_codex_limits(rl, sampled, source):
    """rateLimits (RPC, camelCase) or payload.rate_limits (session log, snake_case)."""
    ws = []
    for key in ("primary", "secondary"):
        w = (rl or {}).get(key)
        if not isinstance(w, dict):
            continue
        pct = num(w.get("usedPercent", w.get("used_percent")))
        mins = num(w.get("windowDurationMins", w.get("window_minutes")))
        rs = num(w.get("resetsAt", w.get("resets_at")))
        if pct is None:
            continue
        ws.append(win(window_name(mins) if mins else key, pct, rs))
    if not ws:
        return entry("codex", source, reason="no usable rate-limit windows")
    return entry("codex", source, sampled, ws)


def parse_codex_rpc(resp, now):
    """Response to account/rateLimits/read: {"result": {"rateLimits": {...}}}."""
    rl = ((resp or {}).get("result") or {}).get("rateLimits")
    if not isinstance(rl, dict):
        return entry("codex", "codex app-server", reason="rateLimits missing in response")
    return parse_codex_limits(rl, now, "codex app-server")


def parse_codex_log_line(line, mtime):
    """One rollout jsonl line -> entry, or None when it has no complete rate_limits."""
    try:
        o = json.loads(line)
    except Exception:
        return None
    p = o.get("payload") if isinstance(o, dict) else None
    rl = p.get("rate_limits") if isinstance(p, dict) else None
    if not isinstance(rl, dict):
        return None
    ts = parse_iso(o.get("timestamp")) or mtime
    e = parse_codex_limits(rl, ts, "codex session log")
    return e if e["windows"] else None


def parse_agy(o, now):
    """`agy -p /usage --output-format json`: command.data.groups[].buckets[].
    Real keys are snake_case (remaining_fraction, reset_time); camelCase is accepted too."""
    data = ((o or {}).get("command") or {}).get("data")
    groups = data.get("groups") if isinstance(data, dict) else None
    if not isinstance(groups, list):
        return entry("gemini", "agy /usage", reason="unexpected /usage output")
    ws = []
    for g in groups:
        gname = str((g or {}).get("name") or "group")
        if gname.endswith(" models") or gname.endswith(" Models"):
            gname = gname[:-7]
        for b in (g or {}).get("buckets") or []:
            rem = num(b.get("remaining_fraction", b.get("remainingFraction")))
            if rem is None:
                continue
            wname = b.get("window") or b.get("name") or b.get("displayName") or "window"
            wname = "7d" if wname == "weekly" else wname
            reset = b.get("reset_time", b.get("resetTime"))
            ws.append(win(gname + " " + wname, 100.0 - 100.0 * rem, parse_iso(reset)))
    if not ws:
        return entry("gemini", "agy /usage", reason="no buckets in /usage output")
    return entry("gemini", "agy /usage", now, ws)


def parse_grok_billing(resp):
    """`_x.ai/billing` result: the billing period only. No used percent is exposed."""
    cfg = ((resp or {}).get("result") or {}).get("config")
    cp = cfg.get("currentPeriod") if isinstance(cfg, dict) else None
    end = parse_iso(cp.get("end")) if isinstance(cp, dict) else None
    ws = [win("7d" if str(cp.get("type", "")).endswith("WEEKLY") else "period", None, end)] if end else []
    return entry("grok", "grok agent stdio", None, ws, "usage not exposed")


# ---------- JSON-RPC over a subprocess ----------

class Rpc:
    """Line-delimited JSON-RPC to a child process. send(), then wait(id, deadline). close() kills it."""

    def __init__(self, cmd):
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  start_new_session=True)
        self.buf = b""

    def send(self, obj):
        self.p.stdin.write((json.dumps(obj) + "\n").encode())
        self.p.stdin.flush()

    def wait(self, rid, deadline):
        fd = self.p.stdout.fileno()
        while True:
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if isinstance(o, dict) and o.get("id") == rid and ("result" in o or "error" in o):
                    return o
            left = deadline - time.time()
            if left <= 0:
                raise TimeoutError("rpc timeout")
            r, _, _ = select.select([fd], [], [], min(left, 1.0))
            if r:
                chunk = os.read(fd, 65536)
                if not chunk:
                    raise EOFError("rpc closed")
                self.buf += chunk

    def close(self):
        try:
            self.p.kill()
        except Exception:
            pass
        for f in (self.p.stdin, self.p.stdout):
            try:
                f.close()
            except Exception:
                pass
        try:
            self.p.wait(timeout=5)
        except Exception:
            pass


# ---------- collectors (do the I/O, call the parsers) ----------

def collect_claude(now):
    try:
        with open(os.path.expanduser("~/.claude.json")) as f:
            return parse_claude(json.load(f), now)
    except Exception as ex:
        return entry("claude", "~/.claude.json", reason="cannot read ~/.claude.json (%s)" % type(ex).__name__)


def codex_from_log(now):
    root = os.path.join(os.path.expanduser(os.environ.get("CODEX_HOME", "~/.codex")), "sessions")
    files = glob.glob(os.path.join(root, "**", "rollout-*.jsonl"), recursive=True)
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for path in files[:20]:
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(max(0, size - 1_000_000))
                lines = f.read().decode("utf-8", "ignore").splitlines()
            mtime = os.path.getmtime(path)
        except Exception:
            continue
        for line in reversed(lines):
            if '"rate_limits"' in line:
                e = parse_codex_log_line(line, mtime)
                if e:
                    return e
    return None


def collect_codex(now):
    reason = None
    if shutil.which("codex"):
        rpc = None
        try:
            deadline = time.time() + CODEX_TIMEOUT
            rpc = Rpc(["codex", "-s", "read-only", "-a", "never", "app-server"])
            rpc.send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                      "params": {"clientInfo": {"name": "spick", "title": "spick", "version": "0.4.1"}}})
            rpc.wait(1, deadline)
            rpc.send({"jsonrpc": "2.0", "method": "initialized"})
            rpc.send({"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read"})
            e = parse_codex_rpc(rpc.wait(2, deadline), now)
            if e["windows"]:
                return e
            reason = e.get("reason")
        except Exception as ex:
            reason = "app-server failed (%s)" % type(ex).__name__
        finally:
            if rpc:
                rpc.close()
    else:
        reason = "codex not installed"
    try:
        e = codex_from_log(now)
    except Exception:
        e = None
    if e:
        return e
    return entry("codex", "codex app-server", reason=reason or "no data")


def collect_gemini(now):
    if not shutil.which("agy"):
        return entry("gemini", "agy /usage", reason="agy not installed")
    try:
        r = subprocess.run(["agy", "-p", "/usage", "--output-format", "json"], stdin=subprocess.DEVNULL,
                           capture_output=True, timeout=AGY_TIMEOUT)
        o = json.loads(r.stdout.decode("utf-8", "ignore"))
    except subprocess.TimeoutExpired:
        return entry("gemini", "agy /usage", reason="agy /usage timed out")
    except Exception as ex:
        return entry("gemini", "agy /usage", reason="agy /usage failed (%s)" % type(ex).__name__)
    return parse_agy(o, now)


def collect_grok(now):
    if not shutil.which("grok"):
        return entry("grok", "grok agent stdio", reason="grok not installed")
    rpc = None
    try:
        deadline = time.time() + GROK_TIMEOUT
        rpc = Rpc(["grok", "agent", "stdio"])
        rpc.send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": {"protocolVersion": "1", "clientInfo": {"name": "spick", "version": "0.4.1"}}})
        if "error" in rpc.wait(1, deadline):
            return entry("grok", "grok agent stdio", reason="login needed")
        rpc.send({"jsonrpc": "2.0", "id": 2, "method": "authenticate", "params": {"methodId": "cached_token"}})
        if "error" in rpc.wait(2, deadline):
            return entry("grok", "grok agent stdio", reason="login needed")
        rpc.send({"jsonrpc": "2.0", "id": 3, "method": "_x.ai/billing", "params": {}})
        resp = rpc.wait(3, deadline)
        if "error" in resp:
            return entry("grok", "grok agent stdio", reason="login needed")
        return parse_grok_billing(resp)
    except Exception as ex:
        return entry("grok", "grok agent stdio", reason="grok rpc failed (%s)" % type(ex).__name__)
    finally:
        if rpc:
            rpc.close()


COLLECTORS = {"claude": collect_claude, "codex": collect_codex, "gemini": collect_gemini, "grok": collect_grok}


# ---------- subscriptions, cache, lock ----------

def read_subscriptions():
    """spick.json "subscriptions": {provider: {plan, price}}. A missing key means not subscribed."""
    try:
        with open(os.path.join(config_dir(), "spick.json")) as f:
            subs = json.load(f).get("subscriptions")
    except Exception:
        return {}
    out = {}
    if isinstance(subs, dict):
        for k, v in subs.items():
            if k in PROVIDERS and v is not None and v is not False:
                out[k] = v if isinstance(v, dict) else {}
    return out


def health_fact(url):
    """One GET, no headers, no body: the status code is the fact."""
    if not (isinstance(url, str) and url.startswith(("http://", "https://"))):
        return "health: url not http(s)"
    try:
        with urllib.request.urlopen(url, timeout=HEALTH_TIMEOUT) as r:
            return "health: ok (HTTP %d)" % r.status
    except urllib.error.HTTPError as ex:
        return "health: HTTP %d" % ex.code
    except Exception as ex:
        return "health: unreachable (%s)" % type(ex).__name__


# ---------- generic meters (balance-endpoint, usage-endpoint, local-file) ----------

class _Unknown(Exception):
    """A meter that could not produce a fact; str() is the reason shown as "unknown (<reason>)"."""


def _clean(text, key=None):
    """Response text for an error: whitespace collapsed, Bearer tokens and the key replaced by ***, 80 chars."""
    text = invoke_mod.BEARER_RE.sub("***", str(text))
    if key:
        text = text.replace(key, "***")
    return " ".join(text.split())[:METER_ERR_CHARS]


def dig(obj, path):
    """Value at a dotted path; a number segment indexes a list. Raises _Unknown when it is not there."""
    cur = obj
    for seg in str(path).split("."):
        if isinstance(cur, dict) and seg in cur:
            cur = cur[seg]
        elif isinstance(cur, list) and seg.isdigit() and int(seg) < len(cur):
            cur = cur[int(seg)]
        else:
            raise _Unknown("unexpected response")
    return cur


def _number(v):
    """A JSON number, or a string holding one. Anything else is an unexpected response."""
    if isinstance(v, str):
        try:
            v = float(v.strip())
        except ValueError:
            raise _Unknown("unexpected response")
    n = num(v)
    if n is None or n != n or n in (float("inf"), float("-inf")):
        raise _Unknown("unexpected response")
    return n


def _currency(obj, m):
    cur = m.get("currency")
    if m.get("currency_path"):
        try:
            cur = dig(obj, m["currency_path"])
        except _Unknown:
            cur = None
    return cur.strip() if isinstance(cur, str) and re.fullmatch(r"[A-Za-z0-9._-]{1,12}", cur.strip()) else None


def meter_fact_from(obj, m):
    """The fact string for a parsed JSON document and a resolved meter. Pure."""
    kind = m.get("kind") or ("used-total" if m.get("type") == "usage-endpoint" else "balance")
    value = _number(dig(obj, m.get("value_path") or ""))
    cur = _currency(obj, m)
    tail = " " + cur if cur else ""
    if kind == "balance":
        return "balance %.2f%s" % (value, tail)
    if kind == "used-total":
        if not m.get("total_path"):
            raise _Unknown("meter has no total_path")
        total = dig(obj, m["total_path"])
        if total is None:  # the service reports no cap (OpenRouter: limit null)
            return "used %.2f%s (no cap)" % (value, tail)
        return "used %.2f of %.2f%s" % (value, _number(total), tail)
    raise _Unknown("unknown meter kind")


def resolve_meter(lane):
    """The lane's meter with its preset folded in; fields written on the meter win over the preset."""
    m = lane.get("meter") if isinstance(lane.get("meter"), dict) else {}
    name = m.get("preset")
    base = {}
    if name is not None:
        base = lanes_mod.meter_presets().get(name)
        if base is None:
            raise _Unknown("unknown preset %s" % _clean(name))
    out = dict(base)
    out.update({k: v for k, v in m.items() if k != "preset"})
    out["preset"] = name
    return out


def _fetch_json(url, key, method, auth):
    if method != "GET":
        raise _Unknown("unsupported method")
    if auth != "bearer":
        raise _Unknown("unsupported auth")
    if not (isinstance(url, str) and url.startswith(("http://", "https://"))):
        raise _Unknown("url not http(s)")
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key, "Accept": "application/json"}, method="GET")
    opener = urllib.request.build_opener(invoke_mod._NoRedirect)
    try:
        with opener.open(req, timeout=METER_TIMEOUT) as r:
            raw = r.read(1_000_000)
    except urllib.error.HTTPError as ex:
        code = ex.code
        ex.close()
        raise _Unknown("HTTP %d" % code)  # status only: response text never reaches the quota line
    except Exception as ex:
        reason = getattr(ex, "reason", ex)
        raise _Unknown("unreachable (%s)" % ("timeout" if isinstance(reason, TimeoutError) else type(reason).__name__))
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        raise _Unknown("unexpected response")


def meter_http(lane):
    """One GET with the lane's key; the fact string, or "unknown (<reason>)". The key never leaves this function."""
    try:
        m = resolve_meter(lane)
        if not m.get("url"):
            raise _Unknown("preset has no collector" if m.get("preset") else "meter has no url")
        ref = lane.get("key_ref")
        if not ref:
            raise _Unknown("key not found: lane has no key_ref")
        try:
            key = invoke_mod.read_key(ref)
        except invoke_mod.Fail as f:
            raise _Unknown(f.msg)
        return meter_fact_from(_fetch_json(m["url"], key, m.get("method", "GET"), m.get("auth", "bearer")), m)
    except _Unknown as ex:
        return "unknown (%s)" % ex
    except Exception as ex:
        return "unknown (%s)" % type(ex).__name__


def meter_local_file(lane):
    """Reads a JSON file at meter.path; same value_path / total_path / kind rules as the endpoint meters."""
    try:
        m = resolve_meter(lane)
        try:
            with open(os.path.expanduser(str(m.get("path") or "")), "rb") as f:
                obj = json.loads(f.read(1_000_000).decode("utf-8"))
        except FileNotFoundError:
            raise _Unknown("file not found")
        except (OSError, ValueError):
            raise _Unknown("unexpected response")
        return meter_fact_from(obj, m)
    except _Unknown as ex:
        return "unknown (%s)" % ex
    except Exception as ex:
        return "unknown (%s)" % type(ex).__name__


def meter_entry(lane, now):
    """Facts for a lane whose meter is not a built-in collector. Declared fields only; nothing is judged."""
    m = lane.get("meter") if isinstance(lane.get("meter"), dict) else {}
    t = m.get("type", "none")
    measured = False
    if t == "none":
        facts = ["no meter (declared plan only)"]
    elif t == "builtin":
        facts = ["no built-in collector for %s" % lane["id"]]
    elif t in ("balance-endpoint", "usage-endpoint", "local-file"):
        facts = [(meter_local_file if t == "local-file" else meter_http)(lane)]
        measured = not facts[0].startswith("unknown (")
    else:
        facts = ["meter %s: no collector in this version" % t]
    probed = isinstance(m.get("health_url"), str)
    if probed:
        facts.append(health_fact(m["health_url"]))
    e = entry(lane["id"], "lane_registry", now if (probed or measured) else None)
    e["facts"] = facts
    return e


def collect_all(subs, now=None, registry_lanes=None):
    """registry_lanes None: the cache as before. A list (user declared lane_registry): entries also carry
    `facts`, custom lanes get entries, and the doc carries a `lanes` list."""
    now = time.time() if now is None else now
    by_id = {l["id"]: l for l in registry_lanes or []}

    def task(p):
        lane = by_id.get(p)
        if registry_lanes is not None and lane is not None and (lane.get("meter") or {}).get("type") != "builtin":
            return meter_entry(lane, now)
        return COLLECTORS[p](now)

    names = [p for p in PROVIDERS if p in subs]
    extra = [l["id"] for l in registry_lanes or [] if l["id"] not in PROVIDERS]
    out = []
    if names or extra:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(names) + len(extra)) as ex:
            futs = {p: ex.submit(task, p) for p in names + extra}
            for p in names + extra:
                try:
                    e = futs[p].result()
                except Exception as exn:
                    e = entry(p, reason="collector failed (%s)" % type(exn).__name__)
                if p in subs:
                    e["plan"] = subs[p].get("plan")
                    e["price"] = subs[p].get("price")
                else:
                    e["plan"] = by_id[p].get("plan")
                    e["price"] = (by_id[p].get("price") or {}).get("amount")
                if registry_lanes is not None:
                    e.setdefault("facts", [])
                out.append(finalize(e, now))
    doc = {"written_at": iso(now), "providers": out}
    if registry_lanes is not None:
        doc["lanes"] = lanes_mod.cache_view(registry_lanes)
    return doc


def write_cache(doc, path=None):
    path = path or cache_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    try:
        with open(tmp, "w") as f:
            json.dump(doc, f, indent=1, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_cache(path=None):
    try:
        with open(path or cache_path()) as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("providers"), list) and parse_iso(d.get("written_at")) is not None:
            return d
    except Exception:
        pass
    return None


def cache_age(doc, now):
    return None if doc is None else max(0, int(now - parse_iso(doc["written_at"])))


def acquire_lock(path=None, now=None):
    path = path or lock_path()
    now = time.time() if now is None else now
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for _ in range(2):
        try:
            os.mkdir(path)
            return True
        except FileExistsError:
            try:
                if now - os.path.getmtime(path) > LOCK_STALE_S:
                    os.rmdir(path)
                    continue
            except OSError:
                pass
            return False
        except OSError:
            return False
    return False


def release_lock(path=None):
    try:
        os.rmdir(path or lock_path())
    except OSError:
        pass


def _effective_lanes():
    """Effective lanes for the cache, or None when spick.json has no lane_registry."""
    cfg = lanes_mod.read_config(os.path.join(config_dir(), "spick.json"))
    return lanes_mod.load_effective(cfg) if lanes_mod.has_registry(cfg) else None


def _lane_ids(lanes):
    return None if lanes is None else [l["id"] for l in lanes]


def _config_unreadable():
    """spick.json exists but is not a JSON object (caught mid-edit, or damaged). lanes.read_config answers {} for
    that, which reads as "no lane_registry"; a writer that believed it would drop every registry lane."""
    try:
        with open(os.path.join(config_dir(), "spick.json")) as f:
            return not isinstance(json.load(f), dict)
    except FileNotFoundError:
        return False
    except Exception:
        return True


def carry_forward(doc, prior):
    """Keep the facts of registry lanes a new cache would lose. A registry lane (an id that is not a built-in
    provider) still declared in doc["lanes"] but with no entry (its collector did not run) or an entry without
    facts or windows takes the prior cache's entry back, sampling time included, so its age stays true."""
    if not isinstance(prior, dict) or not isinstance(doc.get("lanes"), list):
        return doc
    declared = [l.get("id") for l in doc["lanes"] if isinstance(l, dict)]
    old = {e.get("provider"): e for e in prior.get("providers") or [] if isinstance(e, dict) and e.get("facts")}
    now = parse_iso(doc.get("written_at")) or time.time()
    by_id = {e["provider"]: i for i, e in enumerate(doc["providers"])}
    for pid in declared:
        o = old.get(pid)
        if o is None or pid in PROVIDERS:
            continue
        i = by_id.get(pid)
        if i is None:
            doc["providers"].append(finalize(json.loads(json.dumps(o)), now))
        elif not doc["providers"][i].get("facts") and not doc["providers"][i].get("windows"):
            kept = json.loads(json.dumps(o))
            kept["plan"], kept["price"] = doc["providers"][i].get("plan"), doc["providers"][i].get("price")
            doc["providers"][i] = finalize(kept, now)
    return doc


def relane(path=None):
    """Rebuild only the "lanes" part of the existing cache from spick.json; written_at and providers stay.
    No collectors, no network, no subprocess. No cache file, or spick.json unreadable: does nothing.
    Returns True if it wrote."""
    doc = read_cache(path)
    if doc is None or _config_unreadable():
        return False
    reg = _effective_lanes()
    if reg is None:
        doc.pop("lanes", None)
    else:
        doc["lanes"] = lanes_mod.cache_view(reg)
    write_cache(doc, path)
    return True


def refresh(wait_for_lock=False):
    """Collect and write the cache. Returns the cache doc, or None if another refresh holds the lock
    (background callers just stop; a synchronous caller waits and then reads that refresh's result)."""
    if not acquire_lock():
        if wait_for_lock:
            end = time.time() + AGY_TIMEOUT + 10
            while os.path.isdir(lock_path()) and time.time() < end:
                time.sleep(0.5)
            return read_cache()
        return None
    try:
        prior = read_cache()
        if _config_unreadable():
            return prior     # mid-edit or damaged: collecting now would read "no registry" and drop every registry lane
        reg = _effective_lanes()
        for attempt in range(2):
            doc = collect_all(read_subscriptions(), registry_lanes=reg)
            # Collecting is slow; spick.json may have been edited meanwhile. Re-read it before writing so
            # the cache never carries a stale lanes list (and collect once more if the lane set changed).
            fresh = _effective_lanes()
            if _lane_ids(fresh) == _lane_ids(reg) or attempt == 1:
                break
            reg = fresh
        if _config_unreadable():
            return prior
        if fresh is None:
            doc.pop("lanes", None)
        else:
            doc["lanes"] = lanes_mod.cache_view(fresh)
            carry_forward(doc, prior)
        write_cache(doc)
        return doc
    finally:
        release_lock()


def background_refresh_if_stale(now=None, force=False):
    """Spawn a detached refresh when the cache is missing or older than 10 minutes (force: whatever its
    age, used after spick.json was edited). Never waits. SPICK_NO_BG=1 turns it off (tests)."""
    if os.environ.get("SPICK_NO_BG"):
        return False
    now = time.time() if now is None else now
    age = cache_age(read_cache(), now)
    if not force and age is not None and age < CACHE_TTL_S:
        return False
    try:
        if os.path.isdir(lock_path()) and now - os.path.getmtime(lock_path()) <= LOCK_STALE_S:
            return False
        cmd = [sys.executable, os.path.abspath(__file__), "--bg"]
        if shutil.which("nohup"):
            cmd = ["nohup"] + cmd
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, close_fds=True)
        return True
    except Exception:
        return False


# ---------- presentation ----------

def fmt_age(s):
    if s < 60:
        return "%ds" % s
    if s < 3600:
        return "%dm" % (s // 60)
    if s < 86400:
        return "%dh" % (s // 3600)
    return "%dd" % (s // 86400)


def pct(p):
    return "%d%%" % int(p + 0.5)


def view(doc, now):
    """The cache with the clock-dependent facts recomputed for `now`."""
    doc = json.loads(json.dumps(doc))
    for e in doc["providers"]:
        finalize(e, now)
    return doc


def window_phrase(w, now):
    if w.get("reset"):
        return "%s reset passed" % w["name"]
    r = parse_iso(w.get("resets_at"))
    rel = "" if r is None else " (resets in %s)" % fmt_age(max(0, int(r - now)))
    if w.get("used_pct") is None:
        return "%s unknown%s" % (w["name"], rel)
    return "%s %s%s" % (w["name"], pct(w["used_pct"]), rel)


def provider_phrase(e, now):
    head = " ".join(x for x in (e["provider"], e.get("plan")) if x)
    facts = [f for f in (e.get("facts") or []) if isinstance(f, str)]
    parts = [window_phrase(w, now) for w in e.get("windows", [])]
    # nothing to say (no window, no fact) reads as unknown, sampled or not: never a bare "name: "
    if not facts and (e["status"] == "unknown" or not parts):
        parts.insert(0, "unknown (%s)" % e.get("reason", "no data"))
    parts += facts
    body = ", ".join(parts)
    if e["status"] == "stale":
        body += " [stale, %s old]" % fmt_age(e["age_s"])
    return head + ": " + body


def build_line(doc, now):
    """The checklist line: plain facts with ages. No rules."""
    if doc is None:
        return "Quota: unknown (no data yet)"
    v = view(doc, now)
    if not v["providers"]:
        return ""
    return "Quota (cache %s old): %s." % (fmt_age(cache_age(v, now)), " · ".join(provider_phrase(e, now) for e in v["providers"]))


def text_output(doc, now):
    v = view(doc, now)
    if not v["providers"]:
        return "no subscriptions listed in spick.json (see references/providers.md)"
    rows = []
    for e in v["providers"]:
        cells = []
        for w in e["windows"]:
            val = "reset" if w.get("reset") else ("?" if w.get("used_pct") is None else pct(w["used_pct"]))
            cells.append("%s=%s" % (w["name"], val))
        facts = e.get("facts") or []
        if e["status"] == "unknown" and not facts:
            cells.append("unknown (%s)" % e.get("reason", "no data"))
        cells += facts
        age = "" if e["age_s"] is None else "   age=%s" % fmt_age(e["age_s"])
        rows.append("%-7s %s%s   %s" % (e["provider"], "  ".join(cells), age, e["status"]))
    return "\n".join(rows)


# ---------- main ----------

def main(argv):
    args = set(argv)
    if "--bg" in args:
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        refresh()
        return 0
    if "--relane" in args:
        relane()
        return 0
    if "--touch" in args:
        background_refresh_if_stale()
        return 0
    if "--line" in args:
        doc = read_cache()
        background_refresh_if_stale()
        line = build_line(doc, time.time())
        if line:
            print(line)
        return 0
    doc = refresh(wait_for_lock=True) if "--refresh" in args else (read_cache() or refresh(wait_for_lock=True))
    if "--json" in args:
        print(json.dumps(view(doc, time.time()) if doc else {"written_at": None, "providers": []}, indent=1))
    else:
        print(text_output(doc, time.time()) if doc else "unknown (no data)")
    if "--refresh" not in args:
        background_refresh_if_stale()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        sys.exit(0)  # a monitoring glitch must never block the user
