import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lanes  # noqa: E402
import quota  # noqa: E402

KEY = "sk-TESTKEY123456789"
SEEN = []  # (path, authorization header) of every request the stub saw


class Stub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, headers=None):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        auth = self.headers.get("Authorization")
        SEEN.append((self.path, auth))
        p = self.path
        if p == "/balance":
            return self._send(200, {"balance_infos": [{"currency": "CNY", "total_balance": "12.4"}]})
        if p == "/credits":
            return self._send(200, {"data": {"total_credits": 10, "total_usage": 3.2}})
        if p == "/key":
            return self._send(200, {"data": {"usage": 3.2, "limit": None}})
        if p == "/e401":
            return self._send(401, b"")
        if p == "/e401body":  # an error body that echoes the credentials back
            return self._send(401, ("bad %s and %s %s" % (auth, KEY, "x" * 200)).encode())
        if p == "/empty":
            return self._send(200, {"other": 1})
        if p == "/text":
            return self._send(200, b"not json")
        if p == "/redirect":
            return self._send(302, b"", {"Location": "/balance"})
        self._send(404, b"")


class MeterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Stub)
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_port
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        SEEN.clear()
        os.environ["SPICK_TEST_KEY"] = KEY
        self.addCleanup(os.environ.pop, "SPICK_TEST_KEY", None)

    def lane(self, path, **meter):
        m = {"type": "balance-endpoint", "url": self.base + path, "value_path": "balance_infos.0.total_balance"}
        m.update(meter)
        return {"id": "t", "kind": "api-key", "key_ref": "env:SPICK_TEST_KEY", "meter": m}

    def test_balance(self):
        f = quota.meter_http(self.lane("/balance", currency_path="balance_infos.0.currency"))
        self.assertEqual(f, "balance 12.40 CNY")
        self.assertEqual(SEEN, [("/balance", "Bearer " + KEY)])

    def test_used_total_two_decimals(self):
        m = {"type": "usage-endpoint", "url": self.base + "/credits", "value_path": "data.total_usage",
             "total_path": "data.total_credits", "kind": "used-total", "currency": "USD"}
        self.assertEqual(quota.meter_http({"id": "t", "key_ref": "env:SPICK_TEST_KEY", "meter": m}), "used 3.20 of 10.00 USD")

    def test_used_total_null_limit_is_no_cap(self):
        m = {"type": "usage-endpoint", "url": self.base + "/key", "value_path": "data.usage",
             "total_path": "data.limit", "kind": "used-total", "currency": "USD"}
        self.assertEqual(quota.meter_http({"id": "t", "key_ref": "env:SPICK_TEST_KEY", "meter": m}), "used 3.20 USD (no cap)")

    def test_401(self):
        self.assertEqual(quota.meter_http(self.lane("/e401")), "unknown (HTTP 401)")

    def test_error_body_never_reaches_line(self):
        self.assertEqual(quota.meter_http(self.lane("/e401body")), "unknown (HTTP 401)")

    def test_missing_value_path(self):
        self.assertEqual(quota.meter_http(self.lane("/empty")), "unknown (unexpected response)")

    def test_not_json(self):
        self.assertEqual(quota.meter_http(self.lane("/text")), "unknown (unexpected response)")

    def test_non_numeric_value(self):
        self.assertEqual(quota.meter_http(self.lane("/balance", value_path="balance_infos.0.currency")), "unknown (unexpected response)")

    def test_key_from_env(self):
        os.environ["SPICK_TEST_OTHER"] = "sk-OTHER0000000000"
        self.addCleanup(os.environ.pop, "SPICK_TEST_OTHER", None)
        lane = self.lane("/balance")
        lane["key_ref"] = "env:SPICK_TEST_OTHER"
        quota.meter_http(lane)
        self.assertEqual(SEEN[-1][1], "Bearer sk-OTHER0000000000")

    def test_missing_env_key_names_only_the_variable(self):
        lane = self.lane("/balance")
        lane["key_ref"] = "env:SPICK_TEST_NOT_SET"
        self.assertEqual(quota.meter_http(lane), "unknown (key not found: env SPICK_TEST_NOT_SET)")
        self.assertEqual(SEEN, [])

    def test_missing_keychain_key(self):
        lane = self.lane("/balance")
        lane["key_ref"] = "keychain:spick-test-no-such-item-0001"
        self.assertEqual(quota.meter_http(lane), "unknown (key not found: keychain spick-test-no-such-item-0001)")

    def test_no_key_ref(self):
        lane = self.lane("/balance")
        del lane["key_ref"]
        self.assertEqual(quota.meter_http(lane), "unknown (key not found: lane has no key_ref)")

    def test_redirect_not_followed(self):
        self.assertEqual(quota.meter_http(self.lane("/redirect")), "unknown (HTTP 302)")
        self.assertEqual([p for p, _ in SEEN], ["/redirect"])

    def test_unreachable(self):
        lane = self.lane("/balance")
        lane["meter"]["url"] = "http://127.0.0.1:1/x"
        self.assertTrue(quota.meter_http(lane).startswith("unknown (unreachable"))

    def test_preset_without_collector_and_unknown_preset(self):
        lane = {"id": "t", "key_ref": "env:SPICK_TEST_KEY", "meter": {"type": "balance-endpoint", "preset": "new-api"}}
        self.assertEqual(quota.meter_http(lane), "unknown (preset has no collector)")
        lane["meter"]["preset"] = "nope"
        self.assertEqual(quota.meter_http(lane), "unknown (unknown preset nope)")

    def test_preset_verification_flags(self):
        presets = lanes.meter_presets()
        self.assertEqual(sorted(presets), ["deepseek", "new-api", "one-api", "openrouter"])
        for name in ("deepseek", "openrouter"):
            self.assertEqual(presets[name]["verified"], "docs", name)
            self.assertIs(presets[name]["live"], False, name)
        for name in ("new-api", "one-api"):
            self.assertIs(presets[name]["verified"], False, name)
            self.assertNotIn("url", presets[name])
        self.assertEqual(presets["openrouter"]["url"], "https://openrouter.ai/api/v1/key")

    def test_local_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "bal.json")
            with open(path, "w") as f:
                json.dump({"wallet": {"left": 7.5, "cap": 20, "cur": "EUR"}}, f)
            m = {"type": "local-file", "path": path, "value_path": "wallet.left", "currency_path": "wallet.cur"}
            self.assertEqual(quota.meter_local_file({"id": "t", "meter": m}), "balance 7.50 EUR")
            m2 = dict(m, kind="used-total", total_path="wallet.cap")
            self.assertEqual(quota.meter_local_file({"id": "t", "meter": m2}), "used 7.50 of 20.00 EUR")
            self.assertEqual(quota.meter_local_file({"id": "t", "meter": dict(m, path=os.path.join(d, "missing.json"))}),
                             "unknown (file not found)")

    def test_validate(self):
        def errs(meter):
            return lanes.validate({"lane_registry": {"a": {"kind": "api-key", "meter": meter}}})
        self.assertEqual(errs({"type": "balance-endpoint", "preset": "deepseek"}), [])
        self.assertEqual(errs({"type": "usage-endpoint", "url": "https://x.example/u"}), [])
        self.assertEqual(errs({"type": "local-file", "path": "~/b.json"}), [])
        self.assertEqual(len(errs({"type": "balance-endpoint"})), 1)
        self.assertEqual(len(errs({"type": "usage-endpoint"})), 1)
        self.assertEqual(len(errs({"type": "local-file"})), 1)
        self.assertEqual(errs({"type": "none"}), [])


class CacheTest(unittest.TestCase):
    """End to end: refresh() with a registry lane, and the cache file never holds the key."""

    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Stub)
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_port
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def run_refresh(self, reg):
        with tempfile.TemporaryDirectory() as d:
            old = os.environ.get("CLAUDE_CONFIG_DIR")
            os.environ["CLAUDE_CONFIG_DIR"] = d
            os.environ["SPICK_TEST_KEY"] = KEY
            try:
                with open(os.path.join(d, "spick.json"), "w") as f:
                    json.dump({"lanes": {"gemini": False, "grok": False, "codex": False}, "lane_registry": reg}, f)
                quota.refresh()
                with open(os.path.join(d, "spick-quota.json")) as f:
                    text = f.read()
                return text, quota.build_line(json.loads(text), quota.time.time())
            finally:
                os.environ.pop("SPICK_TEST_KEY", None)
                if old is None:
                    os.environ.pop("CLAUDE_CONFIG_DIR", None)
                else:
                    os.environ["CLAUDE_CONFIG_DIR"] = old

    def test_cache_facts_and_no_key(self):
        reg = {
            "bal": {"kind": "api-key", "plan": "per-token", "key_ref": "env:SPICK_TEST_KEY",
                    "meter": {"type": "balance-endpoint", "url": self.base + "/balance",
                              "value_path": "balance_infos.0.total_balance", "currency_path": "balance_infos.0.currency"}},
            "use": {"kind": "relay", "key_ref": "env:SPICK_TEST_KEY",
                    "meter": {"type": "usage-endpoint", "url": self.base + "/credits", "value_path": "data.total_usage",
                              "total_path": "data.total_credits", "kind": "used-total", "currency": "USD"}},
            "bad": {"kind": "api-key", "key_ref": "env:SPICK_TEST_KEY",
                    "meter": {"type": "balance-endpoint", "url": self.base + "/e401body", "value_path": "x"}},
            "none": {"kind": "api-key", "meter": {"type": "none"}},
        }
        text, line = self.run_refresh(reg)
        facts = {e["provider"]: e["facts"] for e in json.loads(text)["providers"]}
        self.assertEqual(facts["bal"], ["balance 12.40 CNY"])
        self.assertEqual(facts["use"], ["used 3.20 of 10.00 USD"])
        self.assertTrue(facts["bad"][0].startswith("unknown (HTTP 401"))
        self.assertEqual(facts["none"], ["no meter (declared plan only)"])
        self.assertIn("bal per-token: balance 12.40 CNY", line)
        self.assertIn("use: used 3.20 of 10.00 USD", line)
        for blob in (text, line):
            self.assertNotIn(KEY, blob)
            self.assertNotIn("TESTKEY", blob)


if __name__ == "__main__":
    unittest.main()
