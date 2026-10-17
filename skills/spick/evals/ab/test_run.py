import argparse
import contextlib
import io
import json
import os
import stat
import tempfile
import threading
import sys
import unittest
from pathlib import Path
from unittest import mock

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
        self.assertNotIn("disableAllHooks", s)  # it would disable the mod itself (measured 2026-10-17)
        self.assertNotIn("hooks", s)
        self.assertFalse(s["enabledPlugins"][common.GLOBAL_MOD_KEY])

    def test_hook_arm_has_hook_from_the_checkout_and_no_mod(self):
        s = run.arm_settings(common.ARMS["haiku-hook"], global_settings={})
        self.assertNotIn("disableAllHooks", s)
        cmd = s["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
        self.assertIn(str(common.SKILL / "scripts" / "triage-hook.sh"), cmd)
        self.assertNotIn("--plugin-dir", self.cmd("haiku-hook"))

    def test_hook_arm_does_not_add_the_hook_twice_when_the_global_one_is_this_file(self):
        """A symlinked install runs this checkout's hook from ~/.claude/settings.json already."""
        with tempfile.TemporaryDirectory() as d:
            link = Path(d) / "skills" / "spick"
            link.parent.mkdir()
            link.symlink_to(common.SKILL)
            same = {"hooks": {"UserPromptSubmit": [{"hooks": [
                {"type": "command", "command": f"bash \"{link}/scripts/triage-hook.sh\""}]}]}}
            self.assertTrue(run.hook_from_global(same))
            self.assertNotIn("hooks", run.arm_settings(common.ARMS["haiku-hook"], global_settings=same))
            other = {"hooks": {"UserPromptSubmit": [{"hooks": [
                {"type": "command", "command": f"bash {d}/elsewhere/triage-hook.sh"}]}]}}
            self.assertFalse(run.hook_from_global(other))
            self.assertIn("hooks", run.arm_settings(common.ARMS["haiku-hook"], global_settings=other))

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


def probe_stub(d, record=None, code=0):
    """A stub claude that answers with session id `sess-1` and, when `record` is a dict, writes it as the session's
    turn record under $CLAUDE_CONFIG_DIR (what the mod does at turn end)."""
    d = Path(d)
    (d / "out.json").write_text(json.dumps(good_result("OK", session_id="sess-1")), encoding="utf-8")
    write = ""
    if record is not None:
        (d / "rec.json").write_text(json.dumps(record) + "\n", encoding="utf-8")
        write = ('mkdir -p "$CLAUDE_CONFIG_DIR/spick/turns"\n'
                 'cp "$(dirname "$0")/rec.json" "$CLAUDE_CONFIG_DIR/spick/turns/sess-1.jsonl"\n')
    stub = d / "claude-probe"
    stub.write_text(f'#!/bin/sh\n{write}cat "$(dirname "$0")/out.json"\nexit {code}\n', encoding="utf-8")
    stub.chmod(0o755)
    return str(stub)


class Probe(unittest.TestCase):
    """The start-up probe, against stubs that do and do not leave a turn record."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        (self.d / "cfg").mkdir()
        (self.d / "out" / "_arms").mkdir(parents=True)
        self.env = dict(os.environ, CLAUDE_CONFIG_DIR=str(self.d / "cfg"))
        patcher = mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.d / "cfg")})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def probe(self, arm, stub, allow=False):
        args = argparse.Namespace(out=str(self.d / "out"), claude_bin=stub, probe_timeout=30, allow_unverified=allow)
        return run.probe_arm(arm, args, self.env, self.d / "agents.json", self.d / "out" / "_arms", settle=0)

    def test_spick_arm_needs_a_schema_2_record(self):
        good = self.probe("haiku-spick", probe_stub(self.d, {"schemaVersion": 2, "sessionId": "sess-1"}))
        self.assertTrue(good["ok"], good)
        self.assertEqual((good["check"], good["schema_version"]), ("record", 2))

    def test_spick_arm_without_a_record_fails(self):
        p = self.probe("haiku-spick", probe_stub(self.d))
        self.assertFalse(p["ok"])
        self.assertFalse(p["record_seen"])
        self.assertIn("did not run", p["detail"])

    def test_spick_arm_with_an_old_schema_record_fails(self):
        p = self.probe("haiku-spick", probe_stub(self.d, {"sessionId": "sess-1"}))  # v1 shape: the global copy ran
        self.assertFalse(p["ok"])
        self.assertTrue(p["record_seen"])

    def test_bare_and_free_arms_need_no_record(self):
        for arm in ("haiku-bare", "sonnet-bare", "opus-bare", "sonnet-free", "opus-free"):
            p = self.probe(arm, probe_stub(self.d))
            self.assertTrue(p["ok"], (arm, p))
            self.assertEqual(p["check"], "no-record")

    def test_bare_arm_with_a_record_fails(self):
        p = self.probe("haiku-bare", probe_stub(self.d, {"schemaVersion": 2}))
        self.assertFalse(p["ok"])
        self.assertIn("global mod ran", p["detail"])

    def test_hook_arm_is_accepted_best_effort_with_or_without_a_record(self):
        self.assertEqual(self.probe("haiku-hook", probe_stub(self.d))["check"], "best-effort")
        self.assertTrue(self.probe("haiku-hook", probe_stub(self.d, {"schemaVersion": 2}))["ok"])

    def test_a_failed_probe_call_fails_every_arm_kind(self):
        for arm in ("haiku-spick", "haiku-bare", "haiku-hook"):
            p = self.probe(arm, probe_stub(self.d, {"schemaVersion": 2}, code=1))
            self.assertFalse(p["ok"], arm)
            self.assertIn("probe call failed", p["detail"])

    def test_probe_all_writes_probe_json_with_version_and_head(self):
        args = argparse.Namespace(out=str(self.d / "out"), claude_bin=probe_stub(self.d), probe_timeout=30, allow_unverified=False)
        with mock.patch.object(run, "PROBE_SETTLE", 0):
            res = run.probe_all(["haiku-bare", "haiku-bare", "opus-bare"], args, self.env, self.d / "a.json", self.d / "out" / "_arms")
        self.assertEqual(sorted(res["arms"]), ["haiku-bare", "opus-bare"])  # once per arm
        info = json.loads((self.d / "out" / "_probe.json").read_text())
        self.assertEqual(info, res)
        self.assertEqual(sorted(info["arms"]), ["haiku-bare", "opus-bare"])
        for key in ("claude_version", "checkout_head", "allow_unverified", "at"):
            self.assertIn(key, info)
        self.assertEqual(info["checkout_head"], run.checkout_head())

    def main(self, stub, *extra):
        argv = ["run.py", "--arms", "haiku-spick", "--tasks", "T2", "--out", str(self.d / "res"), "--claude-bin", stub, *extra]
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, "argv", argv))
            stack.enter_context(mock.patch.object(run, "PROBE_SETTLE", 0))
            stack.enter_context(mock.patch.object(common, "venv_python", lambda: Path(sys.executable)))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            return run.main()

    def test_main_stops_on_a_failed_probe_before_any_matrix_run(self):
        with self.assertRaises(SystemExit) as cm:
            self.main(probe_stub(self.d))
        self.assertIn("start-up probe failed for haiku-spick", str(cm.exception))
        self.assertFalse((self.d / "res" / "haiku-spick" / "T2").exists())
        self.assertFalse(json.loads((self.d / "res" / "_probe.json").read_text())["arms"]["haiku-spick"]["ok"])

    def test_allow_unverified_goes_on_and_keeps_the_arm_marked_invalid(self):
        self.assertEqual(self.main(probe_stub(self.d), "--allow-unverified"), 0)
        self.assertTrue((self.d / "res" / "haiku-spick" / "T2" / "run-1" / "result.json").exists())
        info = json.loads((self.d / "res" / "_probe.json").read_text())
        self.assertTrue(info["allow_unverified"])
        self.assertFalse(info["arms"]["haiku-spick"]["ok"])

    def test_main_with_a_verified_arm_runs_the_matrix(self):
        self.assertEqual(self.main(probe_stub(self.d, {"schemaVersion": 2})), 0)
        self.assertTrue((self.d / "res" / "haiku-spick" / "T2" / "run-1" / "result.json").exists())

    def result(self):
        return json.loads((self.d / "res" / "haiku-spick" / "T2" / "run-1" / "result.json").read_text())

    def test_each_run_carries_the_probe_it_was_made_under(self):
        self.main(probe_stub(self.d, {"schemaVersion": 2}))
        p = self.result()["meta"]["probe"]
        self.assertTrue(p["ok"])
        self.assertEqual((p["check"], p["checkout_head"]), ("record", run.checkout_head()))
        for key in ("claude_version", "at", "detail"):
            self.assertIn(key, p)

    def test_a_resumed_run_keeps_its_own_probe_not_the_latest(self):
        # first invocation: the probe fails, the run is made anyway; the second passes and skips the existing run
        self.main(probe_stub(self.d), "--allow-unverified")
        self.assertFalse(self.result()["meta"]["probe"]["ok"])
        self.main(probe_stub(self.d, {"schemaVersion": 2}))
        self.assertTrue(json.loads((self.d / "res" / "_probe.json").read_text())["arms"]["haiku-spick"]["ok"])
        rec = self.result()
        self.assertFalse(rec["meta"]["probe"]["ok"])
        g = grade.run_metrics(rec, common.load_tasks()["T2"])
        self.assertFalse(g["probe"]["ok"])

    def test_a_result_written_before_the_field_grades_with_no_probe(self):
        rec = {"meta": {"arm": "haiku-bare", "task": "T2", "run": 1, "exit_code": 0}, "result": good_result()}
        self.assertIsNone(grade.run_metrics(rec, common.load_tasks()["T2"])["probe"])


class OutDir(unittest.TestCase):
    def test_a_dir_inside_a_work_tree_is_refused_and_one_outside_is_not(self):
        here = Path(__file__).resolve().parent  # this checkout
        self.assertTrue(run.inside_git_work_tree(here / "results" / "new"))  # a not-yet-existing child counts too
        self.assertIn("inside a git work tree", run.check_out_dir(here / "results"))
        self.assertIsNone(run.check_out_dir(here / "results", allow_in_repo=True))
        with tempfile.TemporaryDirectory() as d:
            if not run.inside_git_work_tree(d):  # a temp dir under a repository would make this vacuous
                self.assertIsNone(run.check_out_dir(Path(d) / "out"))
        self.assertFalse(str(run.DEFAULT_OUT).startswith(str(here)))


class ParseResult(unittest.TestCase):
    clean = '{"session_id": "s1", "result": "OK", "total_cost_usd": 0.01}'

    def test_clean_json(self):
        self.assertEqual(common.parse_result(self.clean)["session_id"], "s1")
        self.assertIsNone(common.parse_result(""))
        self.assertIsNone(common.parse_result("not json"))

    def test_a_stray_line_on_stdout_does_not_lose_the_run(self):
        self.assertEqual(common.parse_result("spick: something printed\n" + self.clean + "\n")["result"], "OK")
        self.assertEqual(common.parse_result(self.clean + "\ntrailing noise")["session_id"], "s1")

    def test_control_characters_inside_strings_are_tolerated(self):
        raw = '{"session_id": "s2", "result": "line one\x1b[0m\ttab"}'
        self.assertEqual(common.parse_result(raw)["session_id"], "s2")


if __name__ == "__main__":
    unittest.main()
