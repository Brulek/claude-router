import json
import tempfile
import unittest
from pathlib import Path

import report


def g(arm, task, ok, cost=0.01, wall=10, **kw):
    d = dict(arm=arm, task=task, run=1, error=False, cost=cost, wall=wall, turns=2, models=["claude-haiku-5-5"],
             label_line=False, kept_line=False, ideal="haiku", tier_match=True, turn_record=False,
             outside_calls=None, explore_ran=False, explore_haiku=False, subagents=0, pass_=ok)
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

    def test_unpriced_runs_make_cost_unknown_not_a_partial_sum(self):
        runs = {"a/T1/run-1": g("a", "T1", True, cost=0.10), "a/T1/run-2": g("a", "T1", True, cost=None),
                "a/T1/run-3": g("a", "T1", False, cost=0.30)}
        c = report.aggregate(runs)[("a", "T1")]
        self.assertIsNone(c["cost_total"])
        self.assertIsNone(c["cost_mean"])
        self.assertEqual(c["cost_priced"], 2)
        self.assertAlmostEqual(c["cost_coverage"], 2 / 3)
        s = report.arm_summary(runs, "a")
        self.assertIsNone(s["cost_total"])
        self.assertIsNone(s["cost_per_success"])
        self.assertAlmostEqual(s["cost_coverage"], 2 / 3)
        self.assertEqual(report.fmt_cost(s["cost_total"], False, s["cost_priced"], s["n"]), "unknown (2/3 priced)")

    def test_all_unpriced_is_zero_of_n_not_zero_dollars(self):
        runs = {"a/T1/run-1": g("a", "T1", False, cost=None), "a/T1/run-2": g("a", "T1", False, cost=None)}
        s = report.arm_summary(runs, "a")
        self.assertIsNone(s["cost_total"])
        self.assertEqual(s["cost_priced"], 0)
        self.assertEqual(report.fmt_cost(None, False, 0, 2), "unknown (0/2 priced)")

    def test_fully_priced_cell_keeps_its_numbers(self):
        c = report.aggregate({"a/T1/run-1": g("a", "T1", True, cost=0.10), "a/T1/run-2": g("a", "T1", True, cost=0.30)})[("a", "T1")]
        self.assertAlmostEqual(c["cost_total"], 0.40)
        self.assertAlmostEqual(c["cost_mean"], 0.20)
        self.assertEqual(c["cost_coverage"], 1.0)

    def test_unknown_delegate_cost_keeps_the_floor(self):
        c = report.aggregate({"a/T1/run-1": g("a", "T1", True, outside_calls=0, unpriced_delegates=1)})[("a", "T1")]
        self.assertTrue(c["cost_floor"])
        self.assertFalse(report.aggregate({"a/T1/run-1": g("a", "T1", True, outside_calls=0, unpriced_delegates=0)})[("a", "T1")]["cost_floor"])
        s = report.arm_summary({"a/T1/run-1": g("a", "T1", True, unpriced_delegates=2)}, "a")
        self.assertTrue(s["cost_floor"])

    def test_floor_survives_in_the_rendered_row_and_unknown_is_printed(self):
        runs = {"haiku-bare/T1/run-1": g("haiku-bare", "T1", True, cost=0.10, outside_calls=1),
                "haiku-bare/T1/run-2": g("haiku-bare", "T1", True, cost=None),
                "opus-bare/T1/run-1": g("opus-bare", "T1", True, cost=0.20, unpriced_delegates=1)}
        with tempfile.TemporaryDirectory() as d:
            Path(d, "grades.json").write_text(json.dumps({"runs": runs, "judge": {}}))
            text = report.render(d, "2026-10-17")
        self.assertIn("| haiku-bare | 2/2 | 2/2 | unknown (1/2 priced) | unknown (1/2 priced) |", text)
        self.assertIn("| opus-bare | 1/1 | 1/1 | >=$0.200 | >=$0.200 |", text)
        self.assertNotIn("$0.000", text)

    def test_a_missing_delegate_record_is_an_unknown_floor_not_zero(self):
        runs = {"haiku-spick/T1/run-1": g("haiku-spick", "T1", True, cost=0.10, cost_floor=None),
                "haiku-spick/T1/run-2": dict(g("haiku-spick", "T1", True, cost=0.30, cost_floor=False), run=2)}
        c = report.aggregate(runs)[("haiku-spick", "T1")]
        self.assertEqual((c["cost_floor"], c["floor_unknown"]), (False, 1))
        s = report.arm_summary(runs, "haiku-spick")
        self.assertEqual(s["floor_unknown"], 1)
        with tempfile.TemporaryDirectory() as d:
            Path(d, "grades.json").write_text(json.dumps({"runs": runs, "judge": {}}))
            text = report.render(d, "2026-10-17")
        self.assertIn("| haiku-spick | 2/2 | 2/2 | $0.400 ? (1/2 floor unknown) | $0.200 ? (1/2 floor unknown) |", text)
        self.assertIn("| $0.200 ? (1/2 floor unknown) |", text.split("## Per arm and task")[1])
        self.assertEqual(report.fmt_cost(None, False, 1, 2, 1), "unknown (1/2 priced) ? (1/2 floor unknown)")
        # a floor known for every run prints no ?
        self.assertNotIn("?", report.fmt_cost(0.1, True, 1, 1, 0))

    def test_grades_written_before_the_field_read_a_spick_run_without_a_record_as_unknown(self):
        self.assertIsNone(report.run_floor(g("haiku-spick", "T1", True, unpriced_delegates=None)))
        self.assertTrue(report.run_floor(g("haiku-spick", "T1", True, outside_calls=1)))
        self.assertFalse(report.run_floor(g("haiku-spick", "T1", True, turn_record=True, outside_calls=0, unpriced_delegates=0)))
        self.assertFalse(report.run_floor(g("haiku-bare", "T1", True)))

    def test_explore_column_counts_verified_haiku_and_flags_unknown(self):
        runs = {"haiku-spick/T1/run-1": g("haiku-spick", "T1", True, explore_ran=True, explore_haiku=True),
                "haiku-spick/T1/run-2": g("haiku-spick", "T1", True, explore_ran=True, explore_haiku="unknown"),
                "haiku-spick/T1/run-3": g("haiku-spick", "T1", True, explore_ran=True, explore_haiku=False)}
        s = report.arm_summary(runs, "haiku-spick")
        self.assertEqual((s["explore_runs"], s["explore_haiku"], s["explore_unknown"]), (3, 1, 1))
        with tempfile.TemporaryDirectory() as d:
            Path(d, "grades.json").write_text(json.dumps({"runs": runs, "judge": {}}))
            text = report.render(d, "2026-10-17")
        self.assertIn("| haiku-spick | 0/3 | 3/3 | 1/3 (+1 unknown) | 0/3 |", text)


class Probe(unittest.TestCase):
    def render(self, probe):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "grades.json").write_text(json.dumps({"runs": {"haiku-bare/T1/run-1": g("haiku-bare", "T1", True)}, "judge": {}}))
            if probe is not None:
                Path(d, "_probe.json").write_text(json.dumps(probe))
            return report.render(d, "2026-10-17")

    def test_caveats_show_probe_results_version_and_head(self):
        text = self.render({"claude_version": "2.9.9 (Claude Code)", "checkout_head": "abcdef0123456789", "allow_unverified": True,
                            "arms": {"haiku-spick": {"ok": False, "check": "record", "detail": "no schemaVersion 2 turn record"},
                                     "haiku-bare": {"ok": True, "check": "no-record", "detail": "no turn record"},
                                     "haiku-hook": {"ok": True, "check": "best-effort", "detail": "accepted unverified"}}})
        self.assertIn("claude `2.9.9 (Claude Code)`, checkout `abcdef012345`, run with --allow-unverified", text)
        self.assertIn("`haiku-spick`: **INVALID**", text)
        self.assertIn("`haiku-bare`: **verified**", text)
        self.assertIn("`haiku-hook`: **accepted, not verified**", text)

    def test_missing_probe_file_is_said_out_loud(self):
        self.assertIn("Arm start-up probe: none recorded", self.render(None))


def probe(ok=True, head="abcdef0123456789", check="record"):
    return {"ok": ok, "check": check, "detail": "x", "at": "2026-10-17T00:00:00+00:00", "claude_version": "2.9.9",
            "checkout_head": head}


class CellProbe(unittest.TestCase):
    def cell(self, *probes):
        return report.cell_probe([g("a", "T1", True, probe=p) for p in probes])

    def test_every_run_passing_at_one_head_is_verified(self):
        self.assertEqual(self.cell(probe(), probe()), "verified at HEAD abcdef012345")

    def test_runs_from_another_invocation_make_a_mixed_cell(self):
        self.assertEqual(self.cell(probe(), probe(ok=False)), "mixed (1 of 2 verified at HEAD abcdef012345)")
        self.assertEqual(self.cell(probe(), probe(), None), "mixed (2 of 3 verified at HEAD abcdef012345)")
        # two passing probes at different heads are not one verified cell
        self.assertEqual(self.cell(probe(), probe(head="1234567890abcdef")), "mixed (1 of 2 verified at HEAD abcdef012345)")

    def test_no_passing_probe_says_why(self):
        self.assertEqual(self.cell(None, None), "not verified (2 without a probe)")
        self.assertEqual(self.cell(probe(ok=False), None), "not verified (1 invalid, 1 without a probe)")
        self.assertEqual(self.cell(probe(head=None)), "not verified (1 HEAD unknown)")

    def test_a_best_effort_arm_is_accepted_not_verified(self):
        self.assertEqual(self.cell(probe(check="best-effort")), "accepted, not verified at HEAD abcdef012345")

    def test_the_rendered_row_carries_the_cell_probe(self):
        runs = {"haiku-bare/T1/run-1": dict(g("haiku-bare", "T1", True, probe=probe()), run=1),
                "haiku-bare/T1/run-2": dict(g("haiku-bare", "T1", True, probe=None), run=2)}
        with tempfile.TemporaryDirectory() as d:
            Path(d, "grades.json").write_text(json.dumps({"runs": runs, "judge": {}}))
            # the latest probe passed: it must not vouch for the run made without one
            Path(d, "_probe.json").write_text(json.dumps({"checkout_head": "abcdef0123456789", "arms": {"haiku-bare": probe()}}))
            text = report.render(d, "2026-10-17")
        self.assertIn("| 0/2 | 0/2 | mixed (1 of 2 verified at HEAD abcdef012345) |", text)
        self.assertIn("Arm start-up probe of the latest invocation only", text)


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
        for phrase in ("General non-inferiority", "Real bills", "Long-session cache", "A spick-free baseline", "Leak safety"):
            self.assertIn(phrase, text)


if __name__ == "__main__":
    unittest.main()
