import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import paths  # noqa: E402
import render_rules as rr  # noqa: E402
import triage_hint as th  # noqa: E402

SCRIPT = os.path.join(HERE, "triage_hint.py")
HOOK = os.path.join(HERE, "triage-hook.sh")
with open(os.path.join(HERE, "testdata", "triage_hints.json"), encoding="utf-8") as f:
    FIXTURE = json.load(f)

PROMPT_1 = FIXTURE[0]["prompt"]   # the comparison that was kept by the main session on 2026-10-14
RULES = rr.load()
with open(os.path.join(HERE, "..", "assets", "VERSION")) as f:
    VERSION = f.read().strip()


class Fixture(unittest.TestCase):
    def test_every_case_prints_the_recorded_line(self):
        for c in FIXTURE:
            self.assertEqual(th.hint_line(c["prompt"]), c["line"], c["prompt"])

    def test_the_fixture_covers_each_kind_and_a_silent_case(self):
        kinds = set()
        for c in FIXTURE:
            kinds.update(k for k, _ in th.find_hints(c["prompt"]))
        self.assertEqual(kinds, set(th.load_table()))
        self.assertTrue(any(c["line"] is None and c["prompt"] for c in FIXTURE))


class Table(unittest.TestCase):
    def test_kinds_in_priority_order(self):
        self.assertEqual(list(th.load_table()), ["judgement", "review", "design", "code", "web", "x"])
        self.assertEqual(set(th.PHRASES), set(th.load_table()))

    def test_matching_rules(self):
        t = th.load_table()
        self.assertEqual(th.find_hints("COMPARE A vs B", t), [("judgement", ["compare", "vs"])])
        self.assertEqual(th.find_hints("preview the vscode page", t), [])
        self.assertEqual(th.find_hints("which   is\tbetter?", t), [("judgement", ["which is better"])])
        self.assertEqual(th.find_hints("see https://example.com/x", t), [("web", ["a web address"])])
        self.assertEqual(th.find_hints("这个怎么设计", t), [("design", ["怎么设计"])])
        line = th.hint_line("对比、比较、评估、评价这四种说法", t)
        self.assertIn("judgement words (对比, 比较, 评估) -> start from Agent(deep); pick the effort by the table", line)
        self.assertNotIn("评价", line)
        self.assertIsNone(th.hint_line("", t))
        self.assertIsNone(th.hint_line(None, t))


class Cli(unittest.TestCase):
    def run_script(self, args, stdin=None):
        return subprocess.run([sys.executable, SCRIPT] + args, input=stdin, capture_output=True, text=True, timeout=30)

    def test_stdin_json_prints_the_line(self):
        r = self.run_script(["--stdin-json"], json.dumps({"prompt": PROMPT_1, "hook_event_name": "UserPromptSubmit"}))
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, FIXTURE[0]["line"] + "\n")

    def test_text_argument(self):
        r = self.run_script(["--text", "现在几点了?"])
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        r = self.run_script(["--text", "为什么会这样"])
        self.assertIn("judgement words (为什么)", r.stdout)

    def test_broken_or_empty_input_prints_nothing_and_exits_0(self):
        for bad in ["", "not json", "[1,2]", json.dumps({"no_prompt": 1})]:
            r = self.run_script(["--stdin-json"], bad)
            self.assertEqual((r.returncode, r.stdout), (0, ""), bad)

    def test_no_arguments_is_usage(self):
        self.assertEqual(self.run_script([]).returncode, 2)


class Hook(unittest.TestCase):
    """triage-hook.sh end to end: a temp HOME (no mod marker) and config dir, the prompt on stdin as Claude Code sends it."""

    def run_hook(self, cfg=None, prompt=PROMPT_1, stdin=True):
        with tempfile.TemporaryDirectory() as tmp:
            if cfg is not None:
                with open(os.path.join(tmp, "spick.json"), "w", encoding="utf-8") as f:
                    json.dump(dict(cfg, installed_version=VERSION), f, indent=2)   # no version nudge here
            env = dict(os.environ, HOME=tmp, CLAUDE_CONFIG_DIR=tmp, SPICK_NO_BG="1")
            data = json.dumps({"prompt": prompt, "hook_event_name": "UserPromptSubmit"}) if stdin else None
            r = subprocess.run(["bash", HOOK], input=data, stdin=None if stdin else subprocess.DEVNULL,
                               capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.split("\n")

    def checklist_lines(self, lines):
        return [line for line in lines if line and not line.startswith(("Quota", "Lanes ("))]

    def test_the_hook_prints_checklist_txt_for_each_variant(self):
        # the builtin text, then a registry with an enabled lane, then a registry with every lane off
        reg = {"glm": {"kind": "api-key", "tags": ["cheap"], "data": "text"}}
        off = {k: {"enabled": False} for k in ("gemini", "grok", "codex")}
        hint = th.hint_line(PROMPT_1)
        for cfg, variant in ((None, "builtin"), ({"lane_registry": reg}, "registry"), ({"lane_registry": off}, "none")):
            got = self.checklist_lines(self.run_hook(cfg=cfg))
            self.assertEqual(got, rr.checklist_variant(RULES, variant, hint), variant)
        lines = self.run_hook(cfg={"lane_registry": reg})
        self.assertTrue(any(line.startswith("Lanes (user-declared") for line in lines))
        none = "\n".join(self.run_hook(cfg={"lane_registry": off}))
        self.assertIn("no outside lane is enabled: do not call Gemini, Grok or Codex", none)
        self.assertIn("| Review: skipped]", none)
        self.assertNotIn("Lanes (", none)

    def test_item_2_then_the_hint_then_item_3(self):
        lines = self.run_hook()
        tail = next(i for i, line in enumerate(lines) if line.startswith("   A prompt that mixes kinds"))
        self.assertEqual(lines[tail + 1], FIXTURE[0]["line"])
        self.assertTrue(lines[tail + 2].startswith("3. Goal-shaped?"))
        self.assertTrue(lines[tail - 1].rstrip().endswith("`Kept:` line."), "the main session is the last bucket")

    def test_a_silent_prompt_and_no_stdin_print_no_hint(self):
        for lines in (self.run_hook(prompt="现在几点了?"), self.run_hook(stdin=False)):
            self.assertIn(RULES["checklist"]["lane_head"], lines)
            self.assertFalse(any(line.startswith("   Hint") for line in lines))
            self.assertTrue(any(line.startswith("3. Goal-shaped?") for line in lines))

    def run_with(self, cfg_dir, stdin, home=None):
        env = dict(os.environ, HOME=home or cfg_dir, CLAUDE_CONFIG_DIR=cfg_dir)
        return subprocess.run(["bash", HOOK], input=stdin, capture_output=True, text=True, env=env, timeout=60)

    def test_only_this_sessions_fresh_marker_silences_the_checklist(self):
        # the mod keeps <state>/mod-active/<sessionId> fresh; another session (no mod) still gets the checklist
        with tempfile.TemporaryDirectory() as d:
            marks = os.path.join(d, "spick", "mod-active")
            os.makedirs(marks)
            open(os.path.join(marks, "s-1"), "w").close()
            r = self.run_with(d, json.dumps({"session_id": "s-1", "prompt": "x"}))
            self.assertEqual((r.returncode, r.stdout), (0, ""))
            r = self.run_with(d, json.dumps({"session_id": "s-2", "prompt": "x"}))
            self.assertTrue(r.stdout.startswith("[spick triage"))
            # no session id (a terminal run): never silent
            self.assertTrue(self.run_with(d, '{"prompt":"x"}').stdout.startswith("[spick triage"))

    def test_a_marker_older_than_a_day_is_ignored_and_deleted(self):
        with tempfile.TemporaryDirectory() as d:
            marks = os.path.join(d, "spick", "mod-active")
            os.makedirs(marks)
            old = os.path.join(marks, "s-1")
            open(old, "w").close()
            t = time.time() - 25 * 3600
            os.utime(old, (t, t))
            r = self.run_with(d, json.dumps({"session_id": "s-1", "prompt": "x"}))
            self.assertTrue(r.stdout.startswith("[spick triage"))
            self.assertFalse(os.path.exists(old))

    def test_the_session_id_is_made_safe_like_paths_ts(self):
        with tempfile.TemporaryDirectory() as d:
            marks = os.path.join(d, "spick", "mod-active")
            os.makedirs(marks)
            name = paths.marker_name("../a b/..c")
            self.assertEqual(name, "__a_b_..c")
            open(os.path.join(marks, name), "w").close()
            r = self.run_with(d, json.dumps({"session_id": "../a b/..c"}))
            self.assertEqual(r.stdout, "")

    def test_the_old_single_marker_no_longer_silences(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, ".spick-mod-active"), "w").close()
            r = self.run_with(d, json.dumps({"session_id": "s-1", "prompt": "x"}))
            self.assertTrue(r.stdout.startswith("[spick triage"))

    def test_version_nudge_when_the_installed_version_differs(self):
        with open(os.path.join(HERE, "..", "assets", "VERSION")) as f:
            version = f.read().strip()
        with tempfile.TemporaryDirectory() as d:
            cfg = os.path.join(d, "spick.json")
            for installed, want in ((version, None), ("0.9.0", "spick: skill %s installed 0.9.0, run spick setup" % version),
                                    (None, "spick: skill %s installed none, run spick setup" % version)):
                with open(cfg, "w") as f:
                    json.dump({"version": 1} if installed is None else {"version": 1, "installed_version": installed}, f, indent=2)
                first = self.run_with(d, '{"prompt":"x"}').stdout.split("\n")[0]
                if want is None:
                    self.assertTrue(first.startswith("[spick triage"), first)
                else:
                    self.assertEqual(first, want)
            os.unlink(cfg)
            # no spick.json at all: not installed, onboarding says so; no nudge
            self.assertTrue(self.run_with(d, '{"prompt":"x"}').stdout.startswith("[spick triage"))

if __name__ == "__main__":
    unittest.main()
