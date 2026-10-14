import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "add_lane.py")

BASE = ["--id", "deepseek", "--name", "DeepSeek", "--kind", "api-key",
        "--base-url", "https://api.deepseek.com", "--api", "openai-chat", "--model", "deepseek-v4-flash"]


class AddLane(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.path = os.path.join(self.dir, "spick.json")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, obj):
        with open(self.path, "w") as f:
            json.dump(obj, f)

    def read(self):
        with open(self.path) as f:
            return json.load(f)

    def text(self):
        with open(self.path) as f:
            return f.read()

    def run_it(self, *args):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.dir, SPICK_NO_BG="1")
        return subprocess.run([sys.executable, SCRIPT] + list(args), env=env, capture_output=True, text=True)

    def test_adds_lane_keeps_other_keys_and_writes_bak(self):
        orig = {"version": 1, "lanes": {"codex": True}, "other": {"x": 1}}
        self.write(orig)
        r = self.run_it(*BASE, "--meter-preset", "deepseek", "--data", "text", "--tags", "chat,cheap")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "registered deepseek; backup at spick.json.bak")
        d = self.read()
        self.assertEqual(d["lanes"], {"codex": True})
        self.assertEqual(d["other"], {"x": 1})
        rec = d["lane_registry"]["deepseek"]
        self.assertEqual(rec["key_ref"], "keychain:spick-deepseek")
        self.assertEqual(rec["invoke"], {"api": "openai-chat", "base_url": "https://api.deepseek.com",
                                         "model": "deepseek-v4-flash", "max_tokens": 400})
        self.assertEqual(rec["meter"], {"type": "balance-endpoint", "preset": "deepseek"})
        self.assertEqual(rec["data"], "text")
        self.assertEqual(rec["tags"], ["chat", "cheap"])
        self.assertTrue(rec["enabled"])
        self.assertNotIn("notes", rec)
        with open(self.path + ".bak") as f:
            self.assertEqual(json.load(f), orig)

    def test_data_and_meter_omitted_when_not_given(self):
        self.write({"version": 1})
        self.assertEqual(self.run_it(*BASE).returncode, 0)
        rec = self.read()["lane_registry"]["deepseek"]
        self.assertNotIn("data", rec)
        self.assertEqual(rec["meter"], {"type": "none"})

    def test_usage_preset_and_key_name_and_local_health_url(self):
        self.write({"version": 1})
        r = self.run_it("--id", "or", "--name", "OR", "--kind", "relay", "--base-url", "https://openrouter.ai/api/v1",
                        "--api", "openai-chat", "--model", "m", "--key-name", "spick-openrouter",
                        "--meter-preset", "openrouter")
        self.assertEqual(r.returncode, 0, r.stderr)
        rec = self.read()["lane_registry"]["or"]
        self.assertEqual(rec["key_ref"], "keychain:spick-openrouter")
        self.assertEqual(rec["meter"]["type"], "usage-endpoint")
        r = self.run_it("--id", "ollama", "--name", "Ollama", "--kind", "local", "--base-url", "http://127.0.0.1:11434/v1",
                        "--api", "openai-chat", "--model", "m", "--health-url", "http://127.0.0.1:11434/api/tags")
        self.assertEqual(r.returncode, 0, r.stderr)
        rec = self.read()["lane_registry"]["ollama"]
        self.assertNotIn("key_ref", rec)
        self.assertEqual(rec["meter"], {"type": "none", "health_url": "http://127.0.0.1:11434/api/tags"})
        self.assertNotIn("health_url", rec)

    def test_prefer_flag_is_gone_and_no_prefer_is_written(self):
        self.write({"version": 1})
        r = self.run_it(*BASE, "--prefer", "a")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.run_it(*BASE).returncode, 0)
        self.assertNotIn("prefer", self.read()["lane_registry"]["deepseek"])

    def test_first_add_creates_lane_registry_and_a_replaced_record_may_carry_old_prefer(self):
        self.write({"version": 1, "lane_registry": {"deepseek": {"kind": "api-key", "prefer": ["x"]}}})
        self.assertEqual(self.run_it(*BASE).returncode, 0)

    def test_refuses_invalid_id(self):
        self.write({"version": 1})
        before = self.text()
        r = self.run_it(*(["--id", "Bad_ID"] + BASE[2:]))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.text(), before)
        self.assertFalse(os.path.exists(self.path + ".bak"))

    def test_refuses_missing_spick_json(self):
        r = self.run_it(*BASE)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("setup", r.stderr)
        self.assertFalse(os.path.exists(self.path))

    def test_refuses_unknown_preset(self):
        self.write({"version": 1})
        r = self.run_it(*BASE, "--meter-preset", "nope")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("lane_registry", self.read())

    def test_dry_run_writes_nothing(self):
        self.write({"version": 1})
        before = self.text()
        r = self.run_it(*BASE, "--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('"deepseek"', r.stdout)
        self.assertEqual(self.text(), before)
        self.assertFalse(os.path.exists(self.path + ".bak"))

    def test_replace_keeps_other_lanes(self):
        self.write({"version": 1, "lane_registry": {"kimi": {"kind": "api-key"}, "deepseek": {"kind": "api-key", "notes": "old"}}})
        r = self.run_it(*BASE, "--notes", "new")
        self.assertEqual(r.returncode, 0, r.stderr)
        reg = self.read()["lane_registry"]
        self.assertEqual(reg["kimi"], {"kind": "api-key"})
        self.assertEqual(reg["deepseek"]["notes"], "new")
        self.assertEqual(reg["deepseek"]["invoke"]["model"], "deepseek-v4-flash")

    def test_second_write_overwrites_bak(self):
        self.write({"version": 1})
        self.run_it(*BASE)
        self.run_it(*(["--id", "kimi"] + BASE[2:]))
        with open(self.path + ".bak") as f:
            self.assertIn("deepseek", json.load(f)["lane_registry"])
        self.assertIn("kimi", self.read()["lane_registry"])


if __name__ == "__main__":
    unittest.main()
