import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import triage_hint as th  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
HINT_TS = os.path.join(REPO, "mod", "spick-dashboard", "hooks", "hint.ts")
CHECKLIST_TS = os.path.join(REPO, "mod", "spick-dashboard", "hooks", "checklist.ts")
SCRIPT = os.path.join(HERE, "triage_hint.py")
HOOK = os.path.join(HERE, "triage-hook.sh")
with open(os.path.join(HERE, "testdata", "triage_hints.json"), encoding="utf-8") as f:
    FIXTURE = json.load(f)

PROMPT_1 = FIXTURE[0]["prompt"]   # the comparison that was kept by the main session on 2026-10-14
LANE_HEAD = "2. Lane? Route by the shape of the deliverable, top to bottom, first match wins; you are the last line, not the first:"
BULLET_BUILTIN = "   - web lookup -> Gemini (agy); X data -> Grok."
BULLET_REGISTRY = "   - a task an outside lane is tagged for -> pick from the Lanes line by its tags; never send anything above a lane's data: level."


def ts_constants(path):
    """The `export const NAME = '...'` string literals of a .ts file (single, double or backtick quotes, no ${}),
    plus the template of each `export const name = (...): string =>` arrow, unescaped."""
    with open(path, encoding="utf-8") as f:
        src = f.read()

    def unesc(t):
        return re.sub(r"\\(.)", r"\1", t)
    out = {}
    for m in re.finditer(r"^export const (\w+) = (?:'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"|`((?:[^`\\$]|\\.)*)`)$", src, re.M):
        out[m.group(1)] = unesc(next(g for g in m.groups()[1:] if g is not None))
    for m in re.finditer(r"^export const (\w+) = \([^)]*\): string =>\n\s*`((?:[^`\\]|\\.)*)`$", src, re.M):
        out[m.group(1)] = unesc(m.group(2))
    return out


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

    def test_the_mod_carries_the_same_table(self):
        # hint.ts embeds the table between two markers as a JSON object literal; the mod has no path to the asset
        with open(HINT_TS, encoding="utf-8") as f:
            src = f.read()
        m = re.search(r"// hints:start.*?\n(.*?)// hints:end", src, re.S)
        self.assertIsNotNone(m, "markers missing in hint.ts")
        body = m.group(1)
        literal = body[body.index("{"): body.rindex("}") + 1]
        self.assertEqual(json.loads(literal), th.load_table())

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
                    json.dump(cfg, f)
            env = dict(os.environ, HOME=tmp, CLAUDE_CONFIG_DIR=tmp)
            data = json.dumps({"prompt": prompt, "hook_event_name": "UserPromptSubmit"}) if stdin else None
            r = subprocess.run(["bash", HOOK], input=data, stdin=None if stdin else subprocess.DEVNULL,
                               capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.split("\n")

    def test_item_2_then_the_hint_then_item_3(self):
        lines = self.run_hook()
        i2 = lines.index(LANE_HEAD)
        self.assertEqual(lines[i2 + 4], BULLET_BUILTIN)
        self.assertTrue(lines[i2 + 5].endswith("-> you."))
        self.assertTrue(lines[i2 + 6].startswith("   A prompt that mixes kinds is split by kind"))
        self.assertEqual(lines[i2 + 7], FIXTURE[0]["line"])
        self.assertTrue(lines[i2 + 8].startswith("3. Goal-shaped?"))
        self.assertTrue(lines[i2 + 1].startswith("   - a verdict:"), "deep is the first bucket")

    def test_registry_swaps_the_lane_bullet_only(self):
        lines = self.run_hook(cfg={"lane_registry": {"glm": {"kind": "api-key", "tags": ["cheap"], "data": "text"}}})
        self.assertIn(BULLET_REGISTRY, lines)
        self.assertNotIn(BULLET_BUILTIN, lines)
        self.assertIn(FIXTURE[0]["line"], lines)

    def test_a_silent_prompt_and_no_stdin_print_no_hint(self):
        for lines in (self.run_hook(prompt="现在几点了?"), self.run_hook(stdin=False)):
            self.assertIn(LANE_HEAD, lines)
            self.assertFalse(any(line.startswith("   Hint") for line in lines))
            self.assertTrue(any(line.startswith("3. Goal-shaped?") for line in lines))

    def test_the_hook_prints_the_mods_default_checklist(self):
        # the mod cannot spawn bash, so the two texts are compared here: the default checklist rebuilt from
        # checklist.ts's constants against the hook's own output, minus the trailing Quota line
        k = ts_constants(CHECKLIST_TS)
        label = k["labelLineText"].replace("${main}", "Haiku 5.5").replace("${review}", k["REVIEW_CODEX"]).replace("${who}", k["WHO_WITH_REVIEWER"])
        want = [k["TITLE_LINE"], k["PLAN_LINE"], k["LANE_HEAD"], k["LANE_BULLET_DEEP"], k["LANE_BULLET_PLANNER"],
                k["LANE_BULLET_CODER"], k["LANE_BULLET_BUILTIN"], k["LANE_BULLET_YOU"], k["LANE_TAIL"], k["GOAL_LINE"], label]
        got = [line for line in self.run_hook(prompt="x") if line and not line.startswith("Quota")]
        self.assertEqual(got, want)

    def test_a_fresh_mod_marker_silences_the_checklist_in_either_dir(self):
        # the mod writes ~/.claude/.spick-mod-active (it sees only HOME); setup.sh and this hook use CLAUDE_CONFIG_DIR
        for where in ("config", "home"):
            with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as cfg:
                d = cfg if where == "config" else os.path.join(home, ".claude")
                os.makedirs(d, exist_ok=True)
                open(os.path.join(d, ".spick-mod-active"), "w").close()
                env = dict(os.environ, HOME=home, CLAUDE_CONFIG_DIR=cfg)
                r = subprocess.run(["bash", HOOK], input='{"prompt":"x"}', capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual((where, r.returncode, r.stdout), (where, 0, ""))


if __name__ == "__main__":
    unittest.main()
