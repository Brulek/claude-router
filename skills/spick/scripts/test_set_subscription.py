import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import quota  # noqa: E402
import set_subscription as ss  # noqa: E402

SECRET = "sk-" + "a1B2c3" * 6


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.path = os.path.join(self.dir, "spick.json")
        env = mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": self.dir, "SPICK_NO_BG": "1"})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(self.tmp.cleanup)
        self.write({"version": 1, "other": {"x": 1}, "subscriptions": {"codex": {"plan": "Pro Lite"}}})

    def write(self, obj):
        with open(self.path, "w") as f:
            json.dump(obj, f)

    def read(self):
        with open(self.path) as f:
            return json.load(f)

    def text(self, path=None):
        with open(path or self.path) as f:
            return f.read()

    def run_it(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = ss.main(list(args))
            except SystemExit as e:
                rc = e.code
        return rc, out.getvalue(), err.getvalue()


class Set(Base):
    def test_list_prints_the_object(self):
        rc, out, _ = self.run_it("--list")
        self.assertEqual((rc, json.loads(out)), (0, {"codex": {"plan": "Pro Lite"}}))

    def test_set_adds_a_provider_keeps_other_keys_and_backs_up(self):
        before = self.text()
        rc, out, err = self.run_it("--provider", "claude", "--plan", "Max 20x", "--price", "$200/mo")
        self.assertEqual(rc, 0, err)
        self.assertIn("set claude", out)
        d = self.read()
        self.assertEqual(d["subscriptions"], {"codex": {"plan": "Pro Lite"}, "claude": {"plan": "Max 20x", "price": "$200/mo"}})
        self.assertEqual(d["other"], {"x": 1})
        self.assertEqual(self.text(self.path + ".bak"), before)

    def test_a_price_not_given_is_kept_and_dash_clears_it(self):
        self.run_it("--provider", "claude", "--plan", "Max 5x", "--price", "$100/mo")
        self.run_it("--provider", "claude", "--plan", "Max 20x")
        self.assertEqual(self.read()["subscriptions"]["claude"], {"plan": "Max 20x", "price": "$100/mo"})
        self.run_it("--provider", "claude", "--plan", "Max 20x", "--price", "-")
        self.assertEqual(self.read()["subscriptions"]["claude"], {"plan": "Max 20x"})

    def test_remove_drops_the_provider(self):
        rc, out, _ = self.run_it("--provider", "codex", "--remove")
        self.assertEqual(rc, 0)
        self.assertEqual(self.read()["subscriptions"], {})
        rc, _, err = self.run_it("--provider", "codex", "--remove")
        self.assertEqual(rc, 2)
        self.assertIn("not listed", err)

    def test_dry_run_prints_and_writes_nothing(self):
        before = self.text()
        rc, out, _ = self.run_it("--provider", "gemini", "--plan", "AI Pro", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["gemini"], {"plan": "AI Pro"})
        self.assertEqual(self.text(), before)
        self.assertFalse(os.path.exists(self.path + ".bak"))

    def test_quota_reads_what_was_written(self):
        self.run_it("--provider", "grok", "--plan", "SuperGrok")
        self.assertEqual(quota.read_subscriptions(), {"codex": {"plan": "Pro Lite"}, "grok": {"plan": "SuperGrok"}})
        self.assertEqual(ss.PROVIDERS, quota.PROVIDERS)


class Refusals(Base):
    def refused(self, *args):
        before = self.text()
        rc, _, err = self.run_it(*args)
        self.assertEqual(rc, 2, err)
        self.assertEqual(self.text(), before)
        return err

    def test_bad_input_is_refused_with_one_line_and_nothing_written(self):
        self.assertIn("provider must be one of", self.refused("--provider", "openai", "--plan", "Plus"))
        self.assertIn("need --plan", self.refused("--provider", "claude"))
        self.assertIn("one non-empty line", self.refused("--provider", "claude", "--plan", "  "))
        self.assertIn("one non-empty line", self.refused("--provider", "claude", "--plan", "a\nb"))
        self.assertIn("longer than 80", self.refused("--provider", "claude", "--plan", "Max plan " * 10))
        self.assertIn("longer than 40", self.refused("--provider", "claude", "--plan", "Max", "--price", "$20 a month " * 4))
        self.assertIn("no --plan", self.refused("--provider", "codex", "--remove", "--plan", "x"))
        self.assertIn("need --list", self.refused())

    def test_a_secret_is_refused_and_never_echoed(self):
        for args in (("--plan", SECRET), ("--plan", "Max", "--price", SECRET)):
            err = self.refused("--provider", "claude", *args)
            self.assertIn("looks like a secret", err)
            self.assertNotIn(SECRET, err)

    def test_missing_or_broken_config(self):
        self.write({"subscriptions": ["codex"]})
        self.assertIn("must be an object", self.refused("--provider", "claude", "--plan", "Max"))
        os.unlink(self.path)
        rc, _, err = self.run_it("--provider", "claude", "--plan", "Max")
        self.assertEqual(rc, 2)
        self.assertIn("run spick setup first", err)


if __name__ == "__main__":
    unittest.main()
