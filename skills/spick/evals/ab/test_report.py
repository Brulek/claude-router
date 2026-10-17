import json
import tempfile
import unittest
from pathlib import Path

import report


def g(arm, task, ok, cost=0.01, wall=10, **kw):
    d = dict(arm=arm, task=task, run=1, error=False, cost=cost, wall=wall, turns=2, models=["claude-haiku-5-5"],
             label_line=False, kept_line=False, ideal="haiku", tier_match=True, turn_record=False,
             outside_calls=None, explore_ran=False, haiku_billed=True, subagents=0, pass_=ok)
    d["pass"] = d.pop("pass_")
    d.update(kw)
    return d


class Stats(unittest.TestCase):
    def test_percentile_nearest_rank(self):
        self.assertEqual(report.percentile([1, 2, 3, 4], 50), 2)
        self.assertEqual(report.percentile([1, 2, 3, 4], 95), 4)
        self.assertIsNone(report.percentile([], 50))

    def test_cost_per_success_counts_failures(self):
        runs = {"a/T1/run-1": g("a", "T1", True, cost=0.10), "a/T1/run-2": g("a", "T1", False, cost=0.30)}
        s = report.arm_summary(runs, "a")
        self.assertAlmostEqual(s["cost_per_success"], 0.40)
        self.assertEqual((s["passed"], s["graded"]), (1, 2))

    def test_no_success_means_no_cost_per_success(self):
        self.assertIsNone(report.arm_summary({"a/T1/run-1": g("a", "T1", False)}, "a")["cost_per_success"])

    def test_outside_calls_make_cost_a_floor(self):
        c = report.aggregate({"a/T1/run-1": g("a", "T1", True, outside_calls=2)})[("a", "T1")]
        self.assertTrue(c["cost_floor"])
        self.assertTrue(report.fmt_cost(0.1, True).startswith(">="))

    def test_ungraded_judge_runs_are_not_failures(self):
        c = report.aggregate({"a/T5/run-1": g("a", "T5", None)})[("a", "T5")]
        self.assertEqual((c["passed"], c["graded"], c["n"]), (0, 0, 1))


class Render(unittest.TestCase):
    def test_report_has_every_section_and_marks_losing_cells(self):
        runs = {"haiku-bare/T1/run-1": g("haiku-bare", "T1", False), "opus-bare/T1/run-1": g("opus-bare", "T1", True)}
        with tempfile.TemporaryDirectory() as d:
            Path(d, "grades.json").write_text(json.dumps({"runs": runs, "judge": {"T5": {"calls": 1, "tokens": 900, "cost_usd": None}}}))
            text = report.render(d, "2026-10-17")
        for h in ("## Per arm", "## Per arm and task", "## Failed runs", "## Judge", "## Caveats", "## What this matrix cannot show"):
            self.assertIn(h, text)
        self.assertIn("| T1 chore-count | haiku-bare | 0/1 LOSES", text)
        self.assertIn("| T1 chore-count | opus-bare | 1/1 |", text)
        for phrase in ("General non-inferiority", "Real bills", "Long-session cache", "Leak safety"):
            self.assertIn(phrase, text)


if __name__ == "__main__":
    unittest.main()
