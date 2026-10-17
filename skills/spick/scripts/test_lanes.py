import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lanes  # noqa: E402

BUILTIN_LINE = ("Lanes (user-declared; data = most that may be sent): "
                "gemini search,long-context,multimodal,image data:code · "
                "grok x-data data:code · "
                "codex code,review,image data:code")


def ids(cfg):
    return [ln["id"] for ln in lanes.load_effective(cfg)]


class Merge(unittest.TestCase):
    def test_builtins_come_first_in_file_order(self):
        self.assertEqual(ids({"lanes": {"gemini": True, "grok": True, "codex": True}}), ["gemini", "grok", "codex"])

    def test_builtins_off_when_disabled(self):
        self.assertEqual(ids({"lanes": {"gemini": True, "grok": False, "codex": True}}), ["gemini", "codex"])
        self.assertEqual(ids({"lanes": {"gemini": False, "grok": False, "codex": False}}), [])

    def test_registry_enabled_false_also_turns_a_builtin_off(self):
        self.assertEqual(ids({"lane_registry": {"codex": {"enabled": False}}}), ["gemini", "grok"])

    def test_override_one_field_keeps_the_rest(self):
        ln = {x["id"]: x for x in lanes.load_effective({"lane_registry": {"codex": {"data": "text", "tags": ["code"]}}})}
        self.assertEqual(ln["codex"]["data"], "text")
        self.assertEqual(ln["codex"]["tags"], ["code"])
        self.assertNotIn("prefer", ln["codex"])
        self.assertEqual(ln["codex"]["kind"], "cli-subscription")

    def test_new_ids_are_appended_in_registry_order(self):
        cfg = {"lane_registry": {"zed": {"kind": "local"}, "glm": {"kind": "api-key"}}}
        self.assertEqual(ids(cfg), ["gemini", "grok", "codex", "zed", "glm"])

    def test_subscription_plan_and_price_are_folded_in(self):
        cfg = {"subscriptions": {"codex": {"plan": "Pro", "price": "$100/mo"}, "glm": {"plan": "Lite"}},
               "lane_registry": {"glm": {"kind": "api-key"}}}
        ln = {x["id"]: x for x in lanes.load_effective(cfg)}
        self.assertEqual(ln["codex"]["plan"], "Pro")
        self.assertEqual(ln["codex"]["price"], {"model": "subscription", "amount": "$100/mo"})
        self.assertEqual(ln["glm"]["plan"], "Lite")


class Validate(unittest.TestCase):
    def test_no_registry_no_errors(self):
        self.assertEqual(lanes.validate({"lanes": {"codex": True}}), [])

    def test_data_is_optional_for_every_kind(self):
        reg = {k: {"kind": k} for k in ("api-key", "relay", "web-only", "local", "cli-subscription")}
        self.assertEqual(lanes.validate({"lane_registry": {("lane-" + k): v for k, v in reg.items()}}), [])

    def test_bad_values_are_reported(self):
        cfg = {"lane_registry": {
            "Bad_ID": {"kind": "local"},
            "a": {"kind": "teapot"},
            "b": {"kind": "local", "data": "secret"},
            "c": {"kind": "local", "meter": {"type": "psychic"}},
            "d": {"kind": "api-key", "key_ref": "plain-text"},
            "e": {"kind": "api-key", "key_ref": "keychain:glm-api", "meter": {"type": "none"}},
            "f": {"kind": "api-key", "key_ref": "env:GLM_KEY"},
        }}
        errs = "\n".join(lanes.validate(cfg))
        for needle in ("lane Bad_ID: id", "lane a: kind", "lane b: data", "lane c: meter.type", "lane d: key_ref"):
            self.assertIn(needle, errs)
        for ok in ("lane e:", "lane f:"):
            self.assertNotIn(ok, errs)

    def test_secret_sniff_names_the_field_and_never_echoes_the_value(self):
        secret1 = "sk-" + "a1B2c3" * 5
        secret2 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIz"
        cfg = {"lane_registry": {"glm": {"kind": "api-key", "notes": secret1, "invoke": {"headers": [secret2]}}}}
        errs = lanes.validate(cfg)
        self.assertIn("lane glm: field notes looks like a secret", errs)
        self.assertIn("lane glm: field invoke.headers[0] looks like a secret", errs)
        joined = "\n".join(errs)
        self.assertNotIn(secret1, joined)
        self.assertNotIn(secret2, joined)

    def test_ordinary_text_and_urls_are_not_secrets(self):
        cfg = {"lane_registry": {"qwen": {"kind": "local", "notes": "local model, fast and free, good for drafts",
                                          "meter": {"type": "none", "health_url": "http://127.0.0.1:11434/api/tags"},
                                          "invoke": {"model": "claude-sonnet-5-5-high-thinking-extended"}}}}
        self.assertEqual(lanes.validate(cfg), [])


class WriteConfig(unittest.TestCase):
    def test_backup_tmp_replace_and_validation(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "spick.json")
            with open(path, "w") as f:
                f.write('{"version": 1}')
            lanes.write_config(path, {"version": 2})
            with open(path) as f:
                self.assertEqual(json.load(f), {"version": 2})
            with open(path + ".bak") as f:
                self.assertEqual(f.read(), '{"version": 1}')
            self.assertFalse(os.path.exists(path + ".tmp"))
            with self.assertRaises(ValueError):
                lanes.write_config(path, {"lane_registry": {"x": {"kind": "teapot"}}})
            with open(path) as f:
                self.assertEqual(json.load(f), {"version": 2})
            self.assertFalse(os.path.exists(path + ".tmp"))

    def test_new_file_has_no_backup(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "spick.json")
            lanes.write_config(path, {"version": 1})
            self.assertFalse(os.path.exists(path + ".bak"))


class EnabledMerge(unittest.TestCase):
    def test_registry_enabled_wins_over_the_lanes_boolean_both_ways(self):
        self.assertEqual(ids({"lanes": {"codex": False}, "lane_registry": {"codex": {"enabled": True}}}), ["gemini", "grok", "codex"])
        self.assertEqual(ids({"lanes": {"codex": True}, "lane_registry": {"codex": {"enabled": False}}}), ["gemini", "grok"])

    def test_lanes_boolean_alone_still_works_and_default_is_on(self):
        self.assertEqual(ids({"lanes": {"grok": False}}), ["gemini", "codex"])
        self.assertEqual(ids({}), ["gemini", "grok", "codex"])

    def test_enabled_must_be_a_boolean(self):
        errs = lanes.validate({"lane_registry": {"x": {"kind": "local", "enabled": "yes"}}})
        self.assertEqual(errs, ["lane x: enabled must be true or false"])


class Line(unittest.TestCase):
    def test_builtin_line_is_exact(self):
        self.assertEqual(lanes.build_line(lanes.load_effective({"lanes": {"gemini": True, "grok": True, "codex": True}})), BUILTIN_LINE)

    def test_data_unset_is_stated_and_a_leftover_prefer_is_ignored(self):
        cfg = {"lane_registry": {"qwen-local": {"kind": "local", "tags": ["cheap"], "data": "code"},
                                 "mine": {"kind": "local", "tags": ["cheap", "chinese"], "prefer": ["chinese"]}}}
        line = lanes.build_line(lanes.load_effective({**cfg, "lanes": {"gemini": False, "grok": False, "codex": False}}))
        self.assertEqual(line, "Lanes (user-declared; data = most that may be sent): qwen-local cheap data:code · mine cheap,chinese data:unset")
        self.assertEqual(lanes.validate(cfg), [])

    def test_relay_and_api_key_lanes_get_the_third_party_fact_once_each(self):
        cfg = {"lanes": {"gemini": False, "grok": False, "codex": False},
               "lane_registry": {"glm": {"kind": "api-key", "tags": ["cheap"], "data": "text"},
                                 "rl": {"kind": "relay", "tags": ["code"]},
                                 "q": {"kind": "local", "tags": ["cheap"], "data": "code"}}}
        line = lanes.build_line(lanes.load_effective(cfg))
        fact = "%s is a third-party service: sending content to it carries a data-leak risk."
        self.assertEqual(line.count(fact % "glm"), 1)
        self.assertEqual(line.count(fact % "rl"), 1)
        self.assertNotIn("q is a third-party", line)
        self.assertIn("rl code data:unset", line)

    def test_notes_urls_and_key_ref_are_never_printed(self):
        cfg = {"lane_registry": {"glm": {"kind": "api-key", "tags": ["cheap"], "data": "text", "notes": "SECRETNOTE",
                                         "key_ref": "env:GLM_KEY", "meter": {"type": "none", "health_url": "http://h.example/x"}}}}
        line = lanes.build_line(lanes.load_effective(cfg))
        for banned in ("SECRETNOTE", "GLM_KEY", "h.example"):
            self.assertNotIn(banned, line)

    def test_no_lanes_no_line(self):
        self.assertEqual(lanes.build_line([]), "")


class Cli(unittest.TestCase):
    def run_cli(self, cfg, *args):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "spick.json")
            with open(path, "w") as f:
                json.dump(cfg, f)
            return subprocess.run([sys.executable, os.path.join(HERE, "lanes.py"), "--config", path, *args],
                                  capture_output=True, text=True)

    def test_line(self):
        r = self.run_cli({"lanes": {"gemini": True, "grok": True, "codex": True}}, "--line")
        self.assertEqual(r.stdout.strip(), BUILTIN_LINE)

    def test_validate_exit_code_and_no_echo(self):
        secret = "sk-" + "z9Y8x7" * 5
        r = self.run_cli({"lane_registry": {"glm": {"kind": "api-key", "notes": secret}}}, "--validate")
        self.assertEqual(r.returncode, 1)
        self.assertIn("lane glm: field notes looks like a secret", r.stdout)
        self.assertNotIn(secret, r.stdout + r.stderr)
        self.assertEqual(self.run_cli({}, "--validate").stdout.strip(), "ok")

    def test_json(self):
        out = json.loads(self.run_cli({"lanes": {"gemini": True, "grok": False, "codex": False}}, "--json").stdout)
        self.assertEqual([ln["id"] for ln in out], ["gemini"])


class ModCopy(unittest.TestCase):
    """the dashboard mod cannot read the skill's files, so quotaline.ts carries the built-in lanes; they must agree"""

    TS = os.path.join(HERE, "..", "..", "..", "mod", "spick-dashboard", "hooks", "quotaline.ts")

    @unittest.skipUnless(os.path.exists(TS), "the skill installed without the repository's mod")
    def test_quotaline_builtins_match_builtin_lanes_json(self):
        import re
        ts = self.TS
        with open(ts) as f:
            block = f.read().split("// builtins:start")[1].split("// builtins:end")[0]
        rows = re.findall(r"\{ id: '([^']+)', kind: '([^']+)', tags: \[([^\]]*)\], data: '([^']+)' \}", block)
        got = [(i, k, re.findall(r"'([^']+)'", t), d) for i, k, t, d in rows]
        want = [(lid, r["kind"], r["tags"], r["data"]) for lid, r in lanes.builtins().items()]
        self.assertEqual(got, want)


if __name__ == "__main__":
    unittest.main()
