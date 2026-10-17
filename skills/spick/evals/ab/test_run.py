import argparse
import contextlib
import io
import json
import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path

import common
import grade
import run


def make_stub(d, body, code=0):
    """A stand-in `claude` executable: prints `body` (a dict, or a raw string) and exits with `code`."""
    d = Path(d)
    (d / "out.json").write_text(body if isinstance(body, str) else json.dumps(body), encoding="utf-8")
    stub = d / "claude-stub"
    stub.write_text(f'#!/bin/sh\ncat "$(dirname "$0")/out.json"\nexit {code}\n', encoding="utf-8")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    return str(stub)


def good_result(text="星期二", **kw):
    r = {"type": "result", "is_error": False, "result": text, "session_id": "s1", "total_cost_usd": 0.01,
         "num_turns": 1, "modelUsage": {"claude-haiku-5-5": {}}, "subagent_stats": {"spawned": 0, "by_type": {}}}
    r.update(kw)
    return r


def one_run(tmp, stub, arm="haiku-bare", timeout=30):
    """do_run on T2 with the stub, then grade_run on what it wrote; returns the grade."""
    out = Path(tmp) / "out"
    (out / "_arms").mkdir(parents=True, exist_ok=True)
    (out / "_arms" / f"{arm}.json").write_text("{}")
    (out / "_arms" / "agents.json").write_text("{}")
    args = argparse.Namespace(out=str(out), force=True, claude_bin=stub, timeout=timeout)
    with contextlib.redirect_stdout(io.StringIO()):
        run.do_run((arm, "T2", 1), args, dict(os.environ), out / "_arms" / "agents.json", out / "_arms",
                   threading.Lock())
    rdir = out / arm / "T2" / "run-1"
    rec = json.loads((rdir / "result.json").read_text(encoding="utf-8"))
    return grade.grade_run(rdir, rec, common.load_tasks()["T2"])


class Agents(unittest.TestCase):
    def test_render_matches_assets(self):
        agents = json.loads(run.render_agents())
        self.assertEqual(sorted(agents), ["Explore", "coder", "deep", "planner"])
        self.assertEqual(agents["Explore"]["model"], "haiku")
        coder = agents["coder"]
        self.assertEqual(coder["model"], "sonnet")
        self.assertIn("Edit", coder["tools"])
        self.assertTrue(coder["prompt"].startswith("The "))
        self.assertNotIn("---", coder["prompt"].splitlines()[0])


class Arms(unittest.TestCase):
    def cmd(self, arm):
        return run.build_cmd(arm, "P", "/a.json", f"/{arm}.json")

    def test_bare_arms_disallow_agent_and_turn_hooks_off(self):
        for arm in ("haiku-bare", "sonnet-bare", "opus-bare"):
            c = self.cmd(arm)
            self.assertIn("--disallowedTools", c)
            self.assertNotIn("Agent", c[c.index("--allowedTools"):])
            self.assertNotIn("--agents", c)
            s = run.arm_settings(common.ARMS[arm])
            self.assertTrue(s["disableAllHooks"])
            self.assertFalse(s["enabledPlugins"][common.GLOBAL_MOD_KEY])

    def test_spick_arm_loads_mod_agents_and_no_bash_hook(self):
        c = self.cmd("haiku-spick")
        self.assertEqual(c[c.index("--plugin-dir") + 1], str(common.MOD_DIR))
        self.assertIn("--agents", c)
        self.assertIn("Agent", c[c.index("--allowedTools"):])
        s = run.arm_settings(common.ARMS["haiku-spick"])
        self.assertTrue(s["disableAllHooks"])
        self.assertNotIn("hooks", s)

    def test_hook_arm_has_hook_from_the_checkout_and_no_mod(self):
        s = run.arm_settings(common.ARMS["haiku-hook"])
        self.assertNotIn("disableAllHooks", s)
        cmd = s["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
        self.assertIn(str(common.SKILL / "scripts" / "triage-hook.sh"), cmd)
        self.assertNotIn("--plugin-dir", self.cmd("haiku-hook"))

    def test_free_arms_allow_agent_without_spick(self):
        for arm in ("sonnet-free", "opus-free"):
            c = self.cmd(arm)
            self.assertNotIn("--disallowedTools", c)
            self.assertIn("Agent", c[c.index("--allowedTools"):])
            self.assertNotIn("--agents", c)
            self.assertTrue(run.arm_settings(common.ARMS[arm])["disableAllHooks"])

    def test_allowed_tools_flag_is_last(self):
        c = self.cmd("opus-free")
        self.assertTrue(set(c[c.index("--allowedTools") + 1:]) <= set(run.ALLOW + ["Agent"]))


class ExitStatus(unittest.TestCase):
    """A run that crashed, errored or timed out is never a pass, whatever the answer text says."""

    def test_clean_run_with_the_right_answer_passes(self):
        with tempfile.TemporaryDirectory() as d:
            g = one_run(d, make_stub(d, good_result()))
        self.assertTrue(g["pass"])
        self.assertFalse(g["error"])
        self.assertIsNone(g["error_reason"])

    def test_nonzero_exit_with_correct_answer_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            g = one_run(d, make_stub(d, good_result(), code=1))
        self.assertFalse(g["pass"])
        self.assertTrue(g["error"])
        self.assertIn("exit_code=1", g["error_reason"])

    def test_is_error_result_with_correct_answer_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            g = one_run(d, make_stub(d, good_result(is_error=True)))
        self.assertFalse(g["pass"])
        self.assertEqual(g["error_reason"], "is_error")

    def test_timeout_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            stub = Path(d) / "slow"
            stub.write_text("#!/bin/sh\nsleep 5\n")
            stub.chmod(0o755)
            g = one_run(d, str(stub), timeout=1)
        self.assertFalse(g["pass"])
        self.assertIn("timeout", g["error_reason"])

    def test_unparsable_output_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            g = one_run(d, make_stub(d, "not json"))
        self.assertFalse(g["pass"])
        self.assertEqual(g["error_reason"], "no result json")


if __name__ == "__main__":
    unittest.main()
