import json
import shutil
import tempfile
import unittest
from pathlib import Path

import common
import grade


class Exact(unittest.TestCase):
    def test_csv_tolerates_crlf_bom_and_trailing_newline(self):
        exp = "文件名,行数\na.txt,3"
        self.assertTrue(grade.grade_exact_csv("﻿文件名,行数\r\na.txt,3\r\n", exp))

    def test_csv_wrong_or_missing(self):
        self.assertFalse(grade.grade_exact_csv("文件名,行数\na.txt,4", "文件名,行数\na.txt,3"))
        self.assertFalse(grade.grade_exact_csv(None, "x"))

    def test_text_ignores_label_and_kept_lines(self):
        chk = {"must_contain": ["星期二"], "must_not_contain": ["星期一"]}
        self.assertTrue(grade.grade_exact_text("星期二\n\n[Model: Haiku 5.5 | Effort: medium]", chk))
        self.assertFalse(grade.grade_exact_text("星期二，不是星期一", chk))
        self.assertFalse(grade.grade_exact_text("星期三", chk))
        # a Kept: line names the arm and is not part of the answer
        self.assertFalse(grade.grade_exact_text("Kept: 星期二 is a lookup\n星期三", chk))


class Rules(unittest.TestCase):
    chk = {"min_chars": 10, "max_chars": 20, "placeholders": ["[X1]", "[X2]"], "forbidden": ["我们"]}

    def test_pass(self):
        r = grade.grade_rules("巡检完成率由[X1]升至[X2]。\n[Model: Haiku 5.5 | Effort: low]", self.chk)
        self.assertTrue(r["pass"])

    def test_too_long_missing_placeholder_forbidden(self):
        self.assertFalse(grade.grade_rules("巡检完成率由[X1]升至[X2]" + "字" * 30, self.chk)["pass"])
        self.assertFalse(grade.grade_rules("巡检完成率由[X1]升至百分之九十", self.chk)["pass"])
        r = grade.grade_rules("我们的巡检完成率由[X1]升至[X2]", self.chk)
        self.assertEqual(r["forbidden_found"], ["我们"])
        self.assertFalse(r["pass"])

    def test_whitespace_not_counted(self):
        r = grade.grade_rules("a b c d e f g h i j [X1][X2]".replace("[X1][X2]", "") + "[X1][X2]", self.chk)
        self.assertEqual(r["chars"], 10 + 8)


class Tiers(unittest.TestCase):
    def test_haiku_ideal_needs_only_haiku(self):
        self.assertTrue(grade.tier_match(["claude-haiku-5-5"], "haiku"))
        self.assertFalse(grade.tier_match(["claude-haiku-5-5", "claude-opus-5-5"], "haiku"))

    def test_ideal_tier_with_haiku_triage(self):
        self.assertTrue(grade.tier_match(["claude-haiku-5-5", "claude-sonnet-5-5"], "sonnet"))
        self.assertFalse(grade.tier_match(["claude-haiku-5-5", "claude-opus-5-5"], "sonnet"))
        self.assertFalse(grade.tier_match(["claude-haiku-5-5"], "opus"))
        self.assertIsNone(grade.tier_match([], "opus"))


class Judge(unittest.TestCase):
    answers = [("a/T5/run-1", "答案一\n[Model: Haiku 5.5 | Effort: low]"), ("b/T5/run-1", "答案二"), ("c/T5/run-1", "答案三")]

    def test_prompt_is_blind_and_key_complete(self):
        prompt, key = grade.build_judge_prompt("评分标准", "任务", self.answers)
        self.assertEqual(sorted(key.values()), sorted(r for r, _ in self.answers))
        self.assertEqual(sorted(key), ["A", "B", "C"])
        self.assertNotIn("[Model:", prompt)
        self.assertNotIn("haiku", prompt.lower())
        for rid in key.values():
            self.assertNotIn(rid, prompt)

    def test_shuffle_is_seeded(self):
        self.assertEqual(grade.build_judge_prompt("r", "t", self.answers)[1], grade.build_judge_prompt("r", "t", self.answers)[1])
        keys = {tuple(grade.build_judge_prompt("r", "t", self.answers, seed=s)[1].values()) for s in range(20)}
        self.assertGreater(len(keys), 1)

    def test_label_maps_to_the_right_text(self):
        prompt, key = grade.build_judge_prompt("r", "t", self.answers)
        texts = dict(self.answers)
        for letter, rid in key.items():
            body = prompt.split(f"=== 回答 {letter} ===\n")[1].split("\n\n")[0]
            self.assertEqual(body, common.strip_markers(texts[rid]))

    def test_parse(self):
        raw = '理由\nJUDGE_JSON: {"A": {"scores": {"x": 4}, "overall": 4}, "B": {"scores": {}, "overall": 2}}\n'
        self.assertEqual(grade.parse_judge(raw, ["A", "B", "C"]), {"A": 4, "B": 2})

    def test_parse_takes_last_line_and_survives_trailing_text(self):
        raw = 'JUDGE_JSON: {"A": {"overall": 1}}\nJUDGE_JSON: {"A": {"overall": 5}} 以上\n'
        self.assertEqual(grade.parse_judge(raw, ["A"]), {"A": 5})
        self.assertEqual(grade.parse_judge("no verdict", ["A"]), {})


class Pinned(unittest.TestCase):
    def test_sha_compare(self):
        with tempfile.TemporaryDirectory() as d:
            t, w = Path(d, "t"), Path(d, "w")
            for p in (t, w):
                (p / "tests").mkdir(parents=True)
                (p / "tests" / "t.py").write_text("x")
            self.assertTrue(grade.pinned_untouched(w, t, ["tests/t.py"]))
            (w / "tests" / "t.py").write_text("y")
            self.assertFalse(grade.pinned_untouched(w, t, ["tests/t.py"]))
            (w / "tests" / "t.py").unlink()
            self.assertFalse(grade.pinned_untouched(w, t, ["tests/t.py"]))


class Metrics(unittest.TestCase):
    def test_outside_calls_and_explore(self):
        recs = [{"delegates": [{"lane": "coder"}, {"lane": "agy"}, {"lane": "Codex"}]}]
        self.assertEqual(grade.outside_calls(recs), 2)
        self.assertIsNone(grade.outside_calls(None))
        res = {"subagent_stats": {"by_type": {"Explore": 1}}, "modelUsage": {"claude-haiku-5-5": {}}}
        self.assertEqual(grade.explore_ran(res), (True, True))
        self.assertEqual(grade.explore_ran({"modelUsage": {"claude-opus-5-5": {}}}), (False, False))


@unittest.skipUnless(common.venv_python().exists(), "run.py --setup first")
class HiddenTests(unittest.TestCase):
    """T3 end to end: the template fails, a fixed copy passes, an edited visible test is caught."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.task = common.load_tasks()["T3"]
        self.work = self.tmp / "work"
        shutil.copytree(common.TASKS_DIR / "T3" / "template", self.work)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def fix(self):
        p = self.work / "textstat" / "stats.py"
        p.write_text(p.read_text().replace("return s[len(s) // 2]",
                                           "m = len(s) // 2\n    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2"))

    def test_unfixed_fails(self):
        g = grade.grade_hidden(self.work, self.task)
        self.assertFalse(g["pass"])
        self.assertFalse((self.work / "tests" / "test_hidden.py").exists())

    def test_fixed_passes(self):
        self.fix()
        g = grade.grade_hidden(self.work, self.task)
        self.assertTrue(g["pass"], g)

    def test_edited_visible_test_fails_even_if_green(self):
        self.fix()
        (self.work / "tests" / "test_stats.py").write_text("def test_nothing():\n    pass\n")
        g = grade.grade_hidden(self.work, self.task)
        self.assertFalse(g["tests_untouched"])
        self.assertFalse(g["pass"])


class TaskFiles(unittest.TestCase):
    def test_every_task_is_wired(self):
        for tid, t in common.load_tasks().items():
            self.assertIn(t["grader"], {"exact_csv", "exact_text", "hidden_tests", "rules", "judge"})
            if t["template"]:
                self.assertTrue((common.TASKS_DIR / t["template"]).is_dir(), tid)
            if t["grader"] == "hidden_tests":
                self.assertTrue((common.TASKS_DIR / t["check"]["hidden"]).is_file(), tid)
                for p in t["check"]["pinned"]:
                    self.assertTrue((common.TASKS_DIR / t["template"] / p).is_file(), (tid, p))
            if t["grader"] == "judge":
                self.assertTrue(t["rubric"], tid)


if __name__ == "__main__":
    unittest.main()
