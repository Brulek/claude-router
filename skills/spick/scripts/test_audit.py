"""audit.py: the figures of the turn records (spec section 6), from testdata/turns_sample.jsonl in a temp HOME."""
import datetime as dt
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import audit  # noqa: E402

SCRIPT = os.path.join(HERE, "audit.py")
TURNS = os.path.join(HERE, "testdata", "turns_sample.jsonl")
NOW = dt.datetime(2026, 10, 14, 12, 0, tzinfo=dt.timezone.utc)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        self.dir = os.path.join(self.home, ".claude", "spick", "turns")

    def put_turns(self):
        os.makedirs(self.dir, exist_ok=True)
        shutil.copy(TURNS, os.path.join(self.dir, "aaaaaaaa.jsonl"))

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = audit.main(list(argv), home=self.home, now=NOW)
        return code, out.getvalue(), err.getvalue()

    def figures(self, *argv):
        code, out, _ = self.run_main("--json", *argv)
        self.assertEqual(code, 0)
        return json.loads(out)


class TestFigures(Base):
    def setUp(self):
        super().setUp()
        self.put_turns()
        self.f = self.figures()

    def test_window_counts_turns_not_late_lines(self):
        self.assertEqual((self.f["days"], self.f["turns"], self.f["sessions"]), (7, 6, 2))

    def test_turns_by_hint_kind_and_what_ran(self):
        h = self.f["byHint"]
        self.assertEqual(h["judgement"], {"turns": 3, "ran": {"deep": 1, "self": 2}})
        self.assertEqual(h["code"], {"turns": 1, "ran": {"coder": 1, "Gemini": 1}})
        self.assertEqual(h["none"], {"turns": 1, "ran": {"coder": 1}})
        self.assertEqual(h["review"], {"turns": 1, "ran": {"Codex": 1}})

    def test_hinted_verdicts_delegated_kept_or_neither(self):
        # a review delegated to the Codex review lane counts as delegated; a judgement needs deep
        self.assertEqual(self.f["verdicts"], {"turns": 4, "delegated": 2, "kept": 1, "neither": 1})

    def test_gate_firings_outcomes_and_false_positive_candidates(self):
        self.assertEqual(self.f["gate"], {"firings": 3, "delegated": 1, "kept": 1, "none": 1, "falsePositiveCandidates": 1})

    def test_edit_turns_with_no_passing_check(self):
        e = self.f["edits"]
        self.assertEqual((e["turns"], e["unchecked"]), (3, 2))
        self.assertEqual(sorted(t["turnId"] for t in e["uncheckedTurns"]), ["t2", "t4"])

    def test_escalations_and_whether_one_followed(self):
        self.assertEqual(self.f["escalations"], {"count": 1, "followed": 1})

    def test_cost_by_lane_and_by_kind(self):
        lane = self.f["costByLane"]
        self.assertAlmostEqual(lane["coder"]["costUsd"], 1.40)
        self.assertAlmostEqual(lane["main session"]["costUsd"], 0.14)
        self.assertEqual((lane["Gemini"]["costUsd"], lane["Gemini"]["unpriced"]), (None, 1))
        kind = self.f["costByKind"]
        self.assertAlmostEqual(kind["judgement"]["costUsd"], 0.44)
        self.assertAlmostEqual(kind["code"]["costUsd"], 0.93)
        # the background coder's late cost goes to its turn's kind
        self.assertAlmostEqual(kind["none"]["costUsd"], 0.52)

    def test_longest_sessions_by_context(self):
        self.assertEqual([(s["sessionId"][:8], s["maxContext"], s["turns"]) for s in self.f["longestSessions"]],
                         [("bbbbbbbb", 91000, 2), ("aaaaaaaa", 52000, 4)])

    def test_days_widens_the_window(self):
        self.assertEqual(self.figures("--days", "30")["turns"], 7)


class TestText(Base):
    def test_report_text(self):
        self.put_turns()
        code, out, err = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(err, "audit.py: skipped 1 turn record line that does not read\n")
        lines = out.splitlines()
        self.assertEqual(lines[0], "spick audit: last 7 days, 6 turns in 2 sessions")
        self.assertIn("  judgement: 3 (self 2, deep 1)", lines)
        self.assertIn("hinted verdicts: 4; delegated 2 (50%), kept 1 (25%), neither 1 (25%)", lines)
        self.assertIn("gate: 3 firings; then delegated 1, kept 1, nothing 1; false positive candidates (kept after sent-back): 1", lines)
        self.assertIn("edits: 3 turns edited source; 2 with no passing check after the last edit", lines)
        self.assertIn("escalations: 1; a coder or deep followed 1", lines)
        self.assertIn("  bbbbbbbb  91k  2 turns  /repo/lib", lines)

    def test_no_records(self):
        self.assertEqual(self.run_main(), (0, "spick audit: no records\n", ""))

    def test_script_runs_in_a_temp_home(self):
        self.put_turns()
        env = dict(os.environ, HOME=self.home)
        env.pop("CLAUDE_CONFIG_DIR", None)
        r = subprocess.run([sys.executable, SCRIPT, "--days", "3650", "--json"], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["turns"], 7)

    def test_days_below_one_is_refused(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
            audit.main(["--days", "0"], home=self.home, now=NOW)
        self.assertEqual(cm.exception.code, 2)


class TestReviewDone(unittest.TestCase):
    def test_a_review_call_counts_from_200_characters_of_output(self):
        t = lambda n: {"hint": ["review"], "delegates": [dict({"lane": "Codex", "isReview": True, "status": "completed"}, **({} if n is None else {"outputChars": n}))]}  # noqa: E731
        self.assertEqual(audit._done(t(200)), "delegated")
        self.assertEqual(audit._done(t(36)), "neither")
        self.assertEqual(audit._done(t(None)), "delegated")


class TestCovered(unittest.TestCase):
    def test_a_check_covers_only_when_it_passed_and_ran_after_the_last_completed_edit(self):
        c = lambda **k: {"checks": [dict({"command": "pytest", "editsDuring": 0}, **k)]}  # noqa: E731
        self.assertTrue(audit._covered(c(exitOk=True, afterLastEdit=True)))
        self.assertFalse(audit._covered(c(exitOk=False, afterLastEdit=True)))
        self.assertFalse(audit._covered(c(exitOk=True, afterLastEdit=False)))
        # records written before the rename carry coversTurn
        self.assertTrue(audit._covered(c(exitOk=True, coversTurn=True)))


if __name__ == "__main__":
    unittest.main()
