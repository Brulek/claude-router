import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lanes  # noqa: E402
import quota  # noqa: E402
import set_lane  # noqa: E402

SECRET = "sk-" + "a1B2c3" * 6
REGISTERED = {"kind": "api-key", "name": "DeepSeek", "enabled": True, "tags": ["cheap"], "data": "text",
              "key_ref": "keychain:spick-deepseek",
              "invoke": {"api": "openai-chat", "base_url": "https://api.deepseek.com", "model": "m", "max_tokens": 400},
              "meter": {"type": "none"}}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.path = os.path.join(self.dir, "spick.json")
        env = mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": self.dir, "SPICK_NO_BG": "1"})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(self.tmp.cleanup)

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
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = set_lane.main(list(args))
            except SystemExit as e:
                rc = e.code
        return rc, out.getvalue(), err.getvalue()

    def set(self, lid, field, value, *extra):
        return self.run_it("--id", lid, "--field", field, "--value", value, *extra)

    def base(self):
        self.write({"version": 1, "lanes": {"codex": True}, "other": {"x": 1},
                    "lane_registry": {"deepseek": json.loads(json.dumps(REGISTERED)), "kimi": {"kind": "api-key"}}})


class Tags(Base):
    def test_spaces_case_and_duplicates(self):
        self.base()
        rc, out, _ = self.set("deepseek", "tags", " Chinese , CHEAP,chinese ,, long-context ")
        self.assertEqual(rc, 0)
        self.assertEqual(out.splitlines()[0], "set deepseek.tags; backup at spick.json.bak")
        self.assertEqual(self.read()["lane_registry"]["deepseek"]["tags"], ["chinese", "cheap", "long-context"])

    def test_dash_clears(self):
        self.base()
        self.assertEqual(self.set("deepseek", "tags", "-")[0], 0)
        self.assertEqual(self.read()["lane_registry"]["deepseek"]["tags"], [])

    def test_builtin_tags_cleared_by_an_explicit_empty_list(self):
        self.base()
        self.assertEqual(self.set("gemini", "tags", "-")[0], 0)
        ln = {x["id"]: x for x in lanes.load_effective(self.read())}
        self.assertEqual(ln["gemini"]["tags"], [])

    def test_more_than_eight_refused(self):
        self.base()
        before = self.text()
        rc, _, err = self.set("deepseek", "tags", ",".join("t%d" % i for i in range(9)))
        self.assertEqual(rc, 2)
        self.assertEqual(len(err.strip().splitlines()), 1)
        self.assertEqual(self.text(), before)
        self.assertEqual(self.set("deepseek", "tags", ",".join("t%d" % i for i in range(8)))[0], 0)

    def test_nine_with_a_duplicate_is_eight_and_fine(self):
        self.base()
        self.assertEqual(self.set("deepseek", "tags", ",".join(["a"] + ["t%d" % i for i in range(7)] + ["A"]))[0], 0)

    def test_tag_length_limit(self):
        self.base()
        self.assertEqual(self.set("deepseek", "tags", "a" * 25)[0], 2)
        self.assertEqual(self.set("deepseek", "tags", "a" * 24)[0], 0)

    def test_invalid_characters_refused(self):
        self.base()
        for bad in ("two words", "under_score", "-lead", "dot.ted", "ünï", ",,"):
            self.assertEqual(self.set("deepseek", "tags", bad)[0], 2, bad)


class Values(Base):
    def test_data_values(self):
        self.base()
        for v in ("public", "text", "code"):
            self.assertEqual(self.set("deepseek", "data", v)[0], 0)
            self.assertEqual(self.read()["lane_registry"]["deepseek"]["data"], v)
        self.assertEqual(self.set("deepseek", "data", "unset")[0], 0)
        self.assertNotIn("data", self.read()["lane_registry"]["deepseek"])
        self.assertEqual(self.set("deepseek", "data", "secret")[0], 2)

    def test_builtin_data_unset_writes_null_and_reads_back_unset(self):
        self.base()
        self.assertEqual(self.set("codex", "data", "unset")[0], 0)
        self.assertEqual(self.read()["lane_registry"]["codex"], {"data": None})
        ln = {x["id"]: x for x in lanes.load_effective(self.read())}
        self.assertIn("codex code,review,image data:unset", lanes.build_line(list(ln.values())))

    def test_enabled_values(self):
        self.base()
        self.assertEqual(self.set("deepseek", "enabled", "maybe")[0], 2)
        self.assertEqual(self.set("deepseek", "enabled", "true")[0], 2)

    def test_notes_limits(self):
        self.base()
        self.assertEqual(self.set("deepseek", "notes", ("ab " * 70)[:199] + "z")[0], 0)
        self.assertEqual(self.set("deepseek", "notes", ("ab " * 70)[:200] + "z")[0], 2)
        self.assertEqual(self.set("deepseek", "notes", "x" * 40)[0], 2)   # one long unbroken word looks like a secret
        self.assertEqual(self.set("deepseek", "notes", "two\nlines")[0], 2)
        self.assertEqual(self.set("deepseek", "notes", "   ")[0], 2)
        self.assertEqual(self.set("deepseek", "notes", "-")[0], 0)
        self.assertNotIn("notes", self.read()["lane_registry"]["deepseek"])

    def test_key_ref_forms(self):
        self.base()
        self.assertEqual(self.set("deepseek", "key_ref", "keychain:spick-ds")[0], 0)
        self.assertEqual(self.read()["lane_registry"]["deepseek"]["key_ref"], "keychain:spick-ds")
        self.assertEqual(self.set("deepseek", "key_ref", "env:DEEPSEEK_KEY")[0], 0)
        self.assertEqual(self.read()["lane_registry"]["deepseek"]["key_ref"], "env:DEEPSEEK_KEY")
        before = self.text()
        rc, out, err = self.set("deepseek", "key_ref", SECRET)
        self.assertEqual(rc, 2)
        self.assertNotIn(SECRET, out + err)
        self.assertEqual(self.set("deepseek", "key_ref", "mykey")[0], 2)
        self.assertEqual(self.text(), before)

    def test_secret_looking_base_url_refused_and_not_echoed(self):
        self.base()
        before = self.text()
        for bad in (SECRET, "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIz"):
            rc, out, err = self.set("deepseek", "base_url", bad)
            self.assertEqual(rc, 2)
            self.assertNotIn(bad, out + err)
        self.assertEqual(self.text(), before)

    def test_invoke_and_meter_fields(self):
        self.base()
        for field, value in (("base_url", "https://x.example/v1"), ("api", "anthropic-messages"), ("model", "big-1"),
                             ("max_tokens", "1200"), ("name", "DS"), ("kind", "relay"),
                             ("meter_preset", "deepseek"), ("meter_type", "balance-endpoint"),
                             ("health_url", "http://127.0.0.1:1/h")):
            rc, _, err = self.set("deepseek", field, value)
            self.assertEqual(rc, 0, "%s: %s" % (field, err))
        rec = self.read()["lane_registry"]["deepseek"]
        self.assertEqual(rec["invoke"], {"api": "anthropic-messages", "base_url": "https://x.example/v1",
                                         "model": "big-1", "max_tokens": 1200})
        self.assertEqual(rec["meter"], {"type": "balance-endpoint", "preset": "deepseek", "health_url": "http://127.0.0.1:1/h"})
        self.assertEqual((rec["name"], rec["kind"]), ("DS", "relay"))
        self.assertEqual(self.set("deepseek", "health_url", "-")[0], 0)
        self.assertNotIn("health_url", self.read()["lane_registry"]["deepseek"]["meter"])

    def test_bad_invoke_and_meter_values(self):
        self.base()
        for field, value in (("base_url", "ftp://x"), ("base_url", "not a url"), ("api", "grpc"), ("model", "two words"),
                             ("max_tokens", "0"), ("max_tokens", "200001"), ("max_tokens", "abc"), ("kind", "teapot"),
                             ("meter_type", "psychic"), ("meter_preset", "nope"), ("name", ""), ("health_url", "x")):
            self.assertEqual(self.set("deepseek", field, value)[0], 2, "%s=%s" % (field, value))

    def test_meter_type_needing_a_preset_is_refused_by_validate(self):
        self.base()
        before = self.text()
        rc, _, err = self.set("deepseek", "meter_type", "balance-endpoint")
        self.assertEqual(rc, 2)
        self.assertIn("meter.preset", err)
        self.assertEqual(self.text(), before)


class Refusals(Base):
    def test_unknown_field(self):
        self.base()
        rc, _, err = self.set("deepseek", "prefer", "x")
        self.assertEqual(rc, 2)
        self.assertEqual(len(err.strip().splitlines()), 1)

    def test_unknown_id_points_to_add_lane(self):
        self.base()
        before = self.text()
        rc, _, err = self.set("nope", "notes", "x")
        self.assertEqual(rc, 2)
        self.assertIn("add_lane.py", err)
        self.assertEqual(self.text(), before)
        self.assertFalse(os.path.exists(self.path + ".bak"))

    def test_missing_spick_json(self):
        rc, _, err = self.set("codex", "notes", "x")
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(self.path))

    def test_missing_registry_with_a_non_builtin_id(self):
        self.write({"version": 1})
        rc, _, err = self.set("deepseek", "notes", "x")
        self.assertEqual(rc, 2)
        self.assertIn("add_lane.py", err)
        self.assertNotIn("lane_registry", self.read())

    def test_invalid_result_writes_nothing(self):
        self.write({"version": 1, "lane_registry": {"bad": {"kind": "teapot"}}})
        before = self.text()
        rc, _, err = self.set("bad", "notes", "hello")
        self.assertEqual(rc, 2)
        self.assertIn("kind", err)
        self.assertEqual(self.text(), before)

    def test_cli_exit_code_two_and_one_line(self):
        self.base()
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.dir)
        r = subprocess.run([sys.executable, os.path.join(HERE, "set_lane.py"), "--id", "deepseek", "--field", "zzz", "--value", "1"],
                           env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(len(r.stderr.strip().splitlines()), 1)
        r = subprocess.run([sys.executable, os.path.join(HERE, "set_lane.py"), "--bogus"], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)


class Writing(Base):
    def test_backup_equals_old_file_and_nothing_else_changes(self):
        self.base()
        old = self.text()
        before = self.read()
        rc, out, _ = self.set("deepseek", "notes", "hello")
        self.assertEqual(rc, 0)
        with open(self.path + ".bak") as f:
            self.assertEqual(f.read(), old)
        after = self.read()
        self.assertEqual(after["lanes"], before["lanes"])
        self.assertEqual(after["other"], before["other"])
        self.assertEqual(after["lane_registry"]["kimi"], before["lane_registry"]["kimi"])
        rec = dict(after["lane_registry"]["deepseek"])
        self.assertEqual(rec.pop("notes"), "hello")
        self.assertEqual(rec, before["lane_registry"]["deepseek"])
        self.assertFalse(os.path.exists(self.path + ".tmp"))

    def test_dry_run_prints_the_record_and_writes_nothing(self):
        self.base()
        before = self.text()
        rc, out, _ = self.set("deepseek", "notes", "hello", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["deepseek"]["notes"], "hello")
        self.assertEqual(self.text(), before)
        self.assertFalse(os.path.exists(self.path + ".bak"))

    def test_builtin_override_holds_only_the_changed_field(self):
        self.base()
        self.assertEqual(self.set("gemini", "data", "text")[0], 0)
        self.assertEqual(self.read()["lane_registry"]["gemini"], {"data": "text"})
        ln = {x["id"]: x for x in lanes.load_effective(self.read())}
        self.assertEqual(ln["gemini"]["data"], "text")
        self.assertEqual(ln["gemini"]["tags"], ["search", "long-context", "multimodal", "image"])

    def test_nested_field_on_a_builtin_keeps_the_rest_of_its_meter(self):
        self.base()
        self.assertEqual(self.set("gemini", "health_url", "http://127.0.0.1:1/h")[0], 0)
        self.assertEqual(self.read()["lane_registry"]["gemini"]["meter"],
                         {"type": "builtin", "collector": "gemini", "health_url": "http://127.0.0.1:1/h"})

    def test_enabled_toggling_persists_and_is_read_back(self):
        self.base()
        ids = lambda: [ln["id"] for ln in lanes.load_effective(self.read())]  # noqa: E731
        self.assertIn("codex", ids())
        self.assertEqual(self.set("codex", "enabled", "no")[0], 0)
        self.assertEqual(self.read()["lane_registry"]["codex"], {"enabled": False})
        self.assertEqual(self.read()["lanes"], {"codex": True})      # the old booleans are not touched
        self.assertNotIn("codex", ids())
        self.assertEqual(self.set("deepseek", "enabled", "no")[0], 0)
        self.assertNotIn("deepseek", ids())
        self.assertEqual(self.set("codex", "enabled", "yes")[0], 0)
        self.assertIn("codex", ids())

    def test_registry_enabled_beats_the_old_lanes_boolean(self):
        cfg = {"lanes": {"grok": False}, "lane_registry": {"grok": {"enabled": True}}}
        self.assertIn("grok", [ln["id"] for ln in lanes.load_effective(cfg)])
        cfg = {"lanes": {"grok": True}, "lane_registry": {"grok": {"enabled": False}}}
        self.assertNotIn("grok", [ln["id"] for ln in lanes.load_effective(cfg)])
        self.assertNotIn("grok", [ln["id"] for ln in lanes.load_effective({"lanes": {"grok": False}})])

    def test_missing_lane_registry_first_edit_to_a_builtin_creates_it(self):
        self.write({"version": 1, "lanes": {"codex": True}})
        rc, out, _ = self.set("codex", "notes", "my note")
        self.assertEqual(rc, 0)
        d = self.read()
        self.assertEqual(d["lane_registry"], {"codex": {"notes": "my note"}})
        self.assertEqual(d["lanes"], {"codex": True})

    def test_a_leftover_prefer_in_a_record_is_ignored(self):
        self.write({"version": 1, "lane_registry": {"old": {"kind": "local", "tags": ["a"], "prefer": ["a"]}}})
        self.assertEqual(lanes.validate(self.read()), [])
        self.assertEqual(self.set("old", "notes", "n")[0], 0)
        self.assertNotIn("prefer", lanes.build_line(lanes.load_effective(self.read())))


class List(Base):
    def test_list_has_no_key_ref_or_base_url(self):
        self.base()
        rc, out, _ = self.run_it("--list")
        self.assertEqual(rc, 0)
        arr = json.loads(out)
        self.assertEqual([x["id"] for x in arr], ["gemini", "grok", "codex", "deepseek", "kimi"])
        for x in arr:
            self.assertEqual(sorted(x), ["data", "enabled", "id", "kind", "name", "notes", "tags"])
        self.assertNotIn("keychain", out)
        self.assertNotIn("api.deepseek.com", out)
        self.assertEqual([x["name"] for x in arr][3:], ["DeepSeek", "kimi"])

    def test_list_includes_disabled_lanes(self):
        self.base()
        self.set("codex", "enabled", "no")
        arr = {x["id"]: x for x in json.loads(self.run_it("--list")[1])}
        self.assertFalse(arr["codex"]["enabled"])
        self.assertTrue(arr["gemini"]["enabled"])


class Relane(Base):
    def cache(self, extra=None):
        doc = {"written_at": "2026-10-14T01:00:00Z", "providers": [{"provider": "claude", "facts": []}],
               "lanes": [{"id": "old", "kind": "local", "tags": [], "data": None}]}
        doc.update(extra or {})
        with open(os.path.join(self.dir, "spick-quota.json"), "w") as f:
            json.dump(doc, f)
        return doc

    def read_cache(self):
        with open(os.path.join(self.dir, "spick-quota.json")) as f:
            return json.load(f)

    def test_relane_rebuilds_only_lanes_without_subprocess(self):
        self.base()
        old = self.cache()
        with mock.patch("subprocess.Popen", side_effect=AssertionError("no subprocess")), \
                mock.patch("subprocess.run", side_effect=AssertionError("no subprocess")):
            self.assertTrue(quota.relane())
        doc = self.read_cache()
        self.assertEqual(doc["written_at"], old["written_at"])
        self.assertEqual(doc["providers"], old["providers"])
        self.assertEqual([ln["id"] for ln in doc["lanes"]], ["gemini", "grok", "codex", "deepseek", "kimi"])
        self.assertNotIn("prefer", doc["lanes"][0])

    def test_relane_without_a_cache_does_nothing(self):
        self.base()
        self.assertFalse(quota.relane())
        self.assertFalse(os.path.exists(os.path.join(self.dir, "spick-quota.json")))

    def test_relane_drops_lanes_when_there_is_no_registry(self):
        self.write({"version": 1})
        self.cache()
        quota.relane()
        self.assertNotIn("lanes", self.read_cache())

    def test_a_write_refreshes_the_cache_lanes_and_asks_for_a_background_refresh(self):
        self.base()
        self.cache()
        with mock.patch.object(quota, "background_refresh_if_stale") as bg:
            self.assertEqual(self.set("deepseek", "enabled", "no")[0], 0)
        bg.assert_called_once_with(force=True)
        self.assertNotIn("deepseek", [ln["id"] for ln in self.read_cache()["lanes"]])

    def test_dry_run_and_refusal_do_not_touch_the_cache(self):
        self.base()
        self.cache()
        with mock.patch.object(quota, "background_refresh_if_stale") as bg:
            self.set("deepseek", "enabled", "no", "--dry-run")
            self.set("deepseek", "enabled", "bad")
        bg.assert_not_called()
        self.assertEqual([ln["id"] for ln in self.read_cache()["lanes"]], ["old"])


if __name__ == "__main__":
    unittest.main()
