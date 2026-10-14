import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lanes  # noqa: E402
import quota  # noqa: E402

DATA = os.path.join(HERE, "testdata")


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


NOW = quota.parse_iso("2026-10-13T15:40:00Z")


def names(e):
    return [(w["name"], w["used_pct"], w["reset"]) for w in e["windows"]]


class Claude(unittest.TestCase):
    def test_limits_present(self):
        e = quota.finalize(quota.parse_claude(load("claude_cache_with_limits.json"), NOW), NOW)
        self.assertEqual(e["provider"], "claude")
        # session window reset at 10:19Z (before NOW): null and reset true, not 0
        self.assertEqual(names(e)[0], ("5h", None, True))
        self.assertEqual(names(e)[1], ("7d", 9.0, False))
        self.assertEqual(names(e)[2], ("7d Fable", 12.0, False))
        self.assertEqual(e["windows"][1]["resets_at"], "2026-10-20T00:59:59Z")
        self.assertEqual(e["status"], "stale")  # fetched about 6h before NOW

    def test_limits_absent_falls_back_to_utilization(self):
        e = quota.finalize(quota.parse_claude(load("claude_cache_no_limits.json"), NOW), NOW)
        self.assertEqual(names(e), [("5h", None, True), ("7d", 9.0, False)])

    def test_missing_cache_is_unknown(self):
        e = quota.finalize(quota.parse_claude({}, NOW), NOW)
        self.assertEqual(e["status"], "unknown")
        self.assertEqual(e["windows"], [])

    def test_fresh_when_young(self):
        d = load("claude_cache_no_limits.json")
        d["cachedUsageUtilization"]["fetchedAtMs"] = int((NOW - 60) * 1000)
        e = quota.finalize(quota.parse_claude(d, NOW), NOW)
        self.assertEqual((e["status"], e["age_s"]), ("fresh", 60))


class Codex(unittest.TestCase):
    def test_rpc(self):
        e = quota.finalize(quota.parse_codex_rpc(load("codex_rpc_ratelimits.json"), NOW), NOW)
        self.assertEqual(names(e), [("7d", 53.0, False)])  # secondary is null: one window only
        self.assertEqual((e["status"], e["source"]), ("fresh", "codex app-server"))

    def test_rpc_error_is_unknown(self):
        e = quota.parse_codex_rpc({"error": {"code": -1}}, NOW)
        self.assertEqual(e["windows"], [])

    def test_jsonl_secondary_null(self):
        with open(os.path.join(DATA, "codex_rollout_line.jsonl")) as f:
            line = f.readline()
        e = quota.finalize(quota.parse_codex_log_line(line, 0), NOW)
        self.assertEqual(names(e), [("7d", 23.0, False)])
        self.assertEqual(e["sampled_at"], "2026-10-13T06:54:34Z")
        self.assertEqual(e["status"], "stale")

    def test_jsonl_without_rate_limits(self):
        self.assertIsNone(quota.parse_codex_log_line('{"payload":{"type":"token_count","info":null}}', 0))
        self.assertIsNone(quota.parse_codex_log_line('{"payload":{"rate_limits":{"primary":', 0))  # cut-off tail

    def test_expired_reset_after_the_window(self):
        e = quota.finalize(quota.parse_codex_rpc(load("codex_rpc_ratelimits.json"), NOW), NOW)
        later = quota.parse_iso("2026-10-21T00:00:00Z")
        quota.finalize(e, later)
        self.assertEqual(names(e), [("7d", None, True)])


class Agy(unittest.TestCase):
    def test_usage(self):
        e = quota.finalize(quota.parse_agy(load("agy_usage.json"), NOW), NOW)
        self.assertEqual(len(e["windows"]), 4)
        w = e["windows"][0]
        self.assertEqual(w["name"], "Gemini 7d")
        self.assertEqual(w["used_pct"], 0.6)  # 100 - 100 * 0.99417...
        self.assertEqual(w["resets_at"], "2026-10-15T01:43:55Z")
        self.assertEqual(e["windows"][3]["name"], "Claude and GPT 5h")
        self.assertEqual(e["status"], "fresh")

    def test_camel_case_keys_accepted(self):
        o = {"command": {"data": {"groups": [{"name": "G", "buckets": [
            {"displayName": "Weekly Limit", "remainingFraction": 0.25, "resetTime": "2026-10-20T00:00:00Z"}]}]}}}
        e = quota.parse_agy(o, NOW)
        self.assertEqual((e["windows"][0]["used_pct"], e["windows"][0]["name"]), (75.0, "G Weekly Limit"))

    def test_bad_shape(self):
        self.assertEqual(quota.parse_agy({"status": "ERROR"}, NOW)["windows"], [])


class Grok(unittest.TestCase):
    def test_billing_has_period_only(self):
        e = quota.finalize(quota.parse_grok_billing(load("grok_billing.json")), NOW)
        self.assertEqual(e["status"], "unknown")
        self.assertEqual(names(e), [("7d", None, False)])
        self.assertEqual(e["windows"][0]["resets_at"], "2026-10-20T00:38:33Z")


class Rpc(unittest.TestCase):
    SERVER = ("import sys,json\n"
              "for l in sys.stdin:\n"
              " o=json.loads(l)\n"
              " if 'id' in o: print(json.dumps({'id':o['id'],'result':{'echo':o['method']}}),flush=True)\n")

    def test_roundtrip_and_notification_ignored(self):
        r = quota.Rpc([sys.executable, "-c", self.SERVER])
        try:
            import time
            d = time.time() + 5
            r.send({"id": 1, "method": "a"})
            r.send({"method": "initialized"})  # no id: no answer expected
            r.send({"id": 2, "method": "b"})
            self.assertEqual(r.wait(1, d)["result"]["echo"], "a")
            self.assertEqual(r.wait(2, d)["result"]["echo"], "b")
        finally:
            r.close()

    def test_timeout(self):
        import time
        r = quota.Rpc([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            with self.assertRaises(TimeoutError):
                r.wait(1, time.time() + 0.5)
        finally:
            r.close()


class Cache(unittest.TestCase):
    def test_atomic_write_and_read_back(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "sub", "spick-quota.json")
            doc = {"written_at": "2026-10-13T15:30:00Z", "providers": []}
            quota.write_cache(doc, p)
            self.assertEqual(quota.read_cache(p), doc)
            self.assertEqual(os.listdir(os.path.dirname(p)), ["spick-quota.json"])  # no tmp left behind
            quota.write_cache({"written_at": "2026-10-13T15:31:00Z", "providers": []}, p)  # replace in place
            self.assertEqual(quota.read_cache(p)["written_at"], "2026-10-13T15:31:00Z")

    def test_failed_write_leaves_old_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "c.json")
            quota.write_cache({"written_at": "2026-10-13T15:30:00Z", "providers": []}, p)
            with self.assertRaises(TypeError):
                quota.write_cache({"written_at": "x", "providers": [object()]}, p)
            self.assertEqual(quota.read_cache(p)["written_at"], "2026-10-13T15:30:00Z")
            self.assertEqual(os.listdir(d), ["c.json"])

    def test_read_missing_or_corrupt(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(quota.read_cache(os.path.join(d, "none.json")))
            p = os.path.join(d, "bad.json")
            with open(p, "w") as f:
                f.write("{not json")
            self.assertIsNone(quota.read_cache(p))

    def test_lock_excludes_second_taker_and_reclaims_stale(self):
        with tempfile.TemporaryDirectory() as d:
            lk = os.path.join(d, "l.lock")
            self.assertTrue(quota.acquire_lock(lk))
            self.assertFalse(quota.acquire_lock(lk))
            old = os.path.getmtime(lk)
            self.assertTrue(quota.acquire_lock(lk, now=old + quota.LOCK_STALE_S + 1))
            quota.release_lock(lk)
            self.assertFalse(os.path.exists(lk))

    def test_lock_under_threads_has_one_winner(self):
        with tempfile.TemporaryDirectory() as d:
            lk = os.path.join(d, "l.lock")
            got = []
            ts = [threading.Thread(target=lambda: got.append(quota.acquire_lock(lk))) for _ in range(8)]
            [t.start() for t in ts]
            [t.join() for t in ts]
            self.assertEqual(sum(got), 1)


class Subscriptions(unittest.TestCase):
    def test_missing_key_means_not_subscribed(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["CLAUDE_CONFIG_DIR"] = d
            try:
                self.assertEqual(quota.read_subscriptions(), {})
                with open(os.path.join(d, "spick.json"), "w") as f:
                    json.dump({"subscriptions": {"claude": {"plan": "Max 20x", "price": "$200/mo"}, "codex": {}, "grok": None, "x": {}}}, f)
                self.assertEqual(quota.read_subscriptions(), {"claude": {"plan": "Max 20x", "price": "$200/mo"}, "codex": {}})
            finally:
                del os.environ["CLAUDE_CONFIG_DIR"]

    def test_collect_all_only_subscribed_with_plan_and_price(self):
        orig = quota.COLLECTORS
        quota.COLLECTORS = {"claude": lambda now: quota.parse_claude(load("claude_cache_no_limits.json"), now)}
        try:
            doc = quota.collect_all({"claude": {"plan": "Max 20x", "price": "$200/mo"}}, NOW)
        finally:
            quota.COLLECTORS = orig
        self.assertEqual([e["provider"] for e in doc["providers"]], ["claude"])
        self.assertEqual((doc["providers"][0]["plan"], doc["providers"][0]["price"]), ("Max 20x", "$200/mo"))
        self.assertEqual(doc["written_at"], "2026-10-13T15:40:00Z")


class Line(unittest.TestCase):
    def test_missing_cache(self):
        self.assertEqual(quota.build_line(None, NOW), "Quota: unknown (no data yet)")

    def test_no_providers_gives_no_line(self):
        self.assertEqual(quota.build_line({"written_at": "2026-10-13T15:30:00Z", "providers": []}, NOW), "")

    def test_sample_matches_the_shared_expected_line(self):
        # the mod's TypeScript builder is tested against the same pair of files
        now = quota.parse_iso("2026-10-13T15:34:00Z")
        with open(os.path.join(DATA, "cache_sample.line.txt")) as f:
            expected = f.read().rstrip("\n")
        doc = load("cache_sample.json")
        self.assertEqual(lanes.build_line(doc["lanes"]) + "\n" + quota.build_line(doc, now), expected)

    def test_facts_replace_the_unknown_prefix(self):
        doc = {"written_at": "2026-10-13T15:30:00Z", "providers": [
            {"provider": "glm", "plan": None, "sampled_at": None, "windows": [], "facts": ["no meter (declared plan only)"]},
            {"provider": "grok", "plan": None, "sampled_at": None, "windows": [], "facts": [], "reason": "login needed"}]}
        line = quota.build_line(doc, quota.parse_iso("2026-10-13T15:34:00Z"))
        self.assertIn("glm: no meter (declared plan only)", line)
        self.assertIn("grok: unknown (login needed)", line)

    def test_collect_all_without_registry_adds_no_new_keys(self):
        doc = quota.collect_all({})
        self.assertEqual(sorted(doc), ["providers", "written_at"])

    def test_collect_all_with_registry_adds_facts_and_lanes(self):
        reg = lanes.load_effective({"lane_registry": {"glm": {"kind": "api-key", "data": "text", "meter": {"type": "none"}}}})
        doc = quota.collect_all({}, registry_lanes=reg)
        self.assertEqual([e["provider"] for e in doc["providers"]], ["glm"])
        self.assertEqual(doc["providers"][0]["facts"], ["no meter (declared plan only)"])
        self.assertEqual([l["id"] for l in doc["lanes"]], ["gemini", "grok", "codex", "glm"])
        self.assertNotIn("meter", doc["lanes"][0])

    def test_collect_all_lanes_carry_no_prefer(self):
        reg = lanes.load_effective({"lane_registry": {"glm": {"kind": "api-key", "prefer": ["x"]}}})
        for l in quota.collect_all({}, registry_lanes=reg)["lanes"]:
            self.assertNotIn("prefer", l)

    def test_refresh_rereads_the_config_before_writing_the_cache(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = os.path.join(d, "spick.json")
            with open(cfg, "w") as f:
                json.dump({"lane_registry": {"a": {"kind": "local", "meter": {"type": "none"}}}}, f)
            real = quota.collect_all

            def slow_collect(subs, now=None, registry_lanes=None):
                doc = real(subs, now, registry_lanes)
                if not getattr(slow_collect, "edited", False):
                    slow_collect.edited = True     # the user edits spick.json while collecting
                    with open(cfg, "w") as f:
                        json.dump({"lane_registry": {"a": {"kind": "local", "meter": {"type": "none"}},
                                                     "b": {"kind": "local", "tags": ["new"], "meter": {"type": "none"}}}}, f)
                return doc

            old = os.environ.get("CLAUDE_CONFIG_DIR")
            os.environ["CLAUDE_CONFIG_DIR"] = d
            try:
                with mock.patch.object(quota, "collect_all", slow_collect):
                    doc = quota.refresh()
            finally:
                if old is None:
                    del os.environ["CLAUDE_CONFIG_DIR"]
                else:
                    os.environ["CLAUDE_CONFIG_DIR"] = old
            self.assertEqual([l["id"] for l in doc["lanes"]], ["gemini", "grok", "codex", "a", "b"])
            self.assertEqual([e["provider"] for e in doc["providers"]], ["a", "b"])
            self.assertEqual(quota.read_cache(os.path.join(d, "spick-quota.json"))["lanes"], doc["lanes"])

    def test_background_refresh_can_be_switched_off_and_forced(self):
        with mock.patch.dict(os.environ, {"SPICK_NO_BG": "1"}):
            self.assertFalse(quota.background_refresh_if_stale(force=True))
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": d}), \
                mock.patch.object(quota.subprocess, "Popen") as popen:
            os.environ.pop("SPICK_NO_BG", None)
            quota.write_cache({"written_at": quota.iso(time.time()), "providers": []})
            self.assertFalse(quota.background_refresh_if_stale())      # fresh cache: nothing to do
            self.assertTrue(quota.background_refresh_if_stale(force=True))
            self.assertEqual(popen.call_count, 1)

    def test_stale_reset_and_unknown_are_stated_as_facts(self):
        line = quota.build_line(load("cache_sample.json"), quota.parse_iso("2026-10-13T15:34:00Z"))
        self.assertIn("claude Max 20x: 5h reset passed, 7d 9% (resets in 6d) [stale, 6h old]", line)
        self.assertIn("grok SuperGrok: unknown (login needed)", line)
        self.assertIn("cache 4m old", line)
        for banned in ("should", "must", "avoid", "prefer", "tight"):
            self.assertNotIn(banned, line)

    def test_window_past_its_reset_reads_as_reset_passed(self):
        doc = {"written_at": "2026-10-13T15:30:00Z", "providers": [{"provider": "codex", "plan": "Pro", "sampled_at": "2026-10-13T15:29:00Z",
               "windows": [{"name": "5h", "used_pct": 40.0, "resets_at": "2026-10-13T15:00:00Z", "reset": False}]}]}
        line = quota.build_line(doc, quota.parse_iso("2026-10-13T15:34:00Z"))
        self.assertIn("codex Pro: 5h reset passed.", line)

    def test_unknown_percent_and_missing_reset_time(self):
        doc = {"written_at": "2026-10-13T15:30:00Z", "providers": [{"provider": "codex", "plan": "Pro", "sampled_at": "2026-10-13T15:29:00Z",
               "windows": [{"name": "7d", "used_pct": None, "resets_at": "2026-10-15T15:34:00Z", "reset": False},
                           {"name": "5h", "used_pct": 12.0, "resets_at": None, "reset": False}]}]}
        line = quota.build_line(doc, quota.parse_iso("2026-10-13T15:34:00Z"))
        self.assertIn("codex Pro: 7d unknown (resets in 2d), 5h 12%.", line)

    def test_text_output(self):
        out = quota.text_output(load("cache_sample.json"), quota.parse_iso("2026-10-13T15:34:00Z"))
        self.assertIn("claude  5h=reset  7d=9%   age=6h   stale", out)
        self.assertIn("grok    unknown (login needed)   unknown", out)


if __name__ == "__main__":
    unittest.main()
