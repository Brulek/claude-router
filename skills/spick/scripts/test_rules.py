"""assets/rules.json is the one source of the routing policy: its schema, the rendered copies (render_rules.py
--check) and the overhead budget of the always-on text (spec section 9)."""
import copy
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render_rules as rr  # noqa: E402

RULES = rr.load()


def words(text):
    return len(text.split())


def broken(f):
    """validate() of a copy of rules.json after f changed it: the problems it names"""
    r = copy.deepcopy(RULES)
    f(r)
    return rr.validate(r)


class Schema(unittest.TestCase):
    def test_rules_json_is_valid(self):
        self.assertEqual(rr.validate(RULES), [])

    def test_kinds_in_the_spec_order(self):
        self.assertEqual([k["id"] for k in RULES["kinds"]],
                         ["x-data", "image", "long", "search", "verdict", "decision", "code", "review", "lookup"])
        self.assertEqual(RULES["efforts"]["coder"]["default"], "medium")
        self.assertEqual(RULES["efforts"]["planner"]["default"], "high")
        self.assertEqual(RULES["efforts"]["deep"]["default"], "medium")
        self.assertEqual(list(RULES["hints"]), ["judgement", "review", "design", "code", "web", "x"])

    def test_broken_rules_are_named(self):
        self.assertTrue(broken(lambda r: r["kinds"].reverse()))
        self.assertTrue(broken(lambda r: r["kinds"][0].update(route="lane x")))
        self.assertTrue(broken(lambda r: r["efforts"]["deep"].update(default="huge")))
        self.assertTrue(broken(lambda r: r["phrases"].update(judgement="no placeholder")))
        self.assertTrue(broken(lambda r: r["checklist"]["bullets"].pop()))
        self.assertTrue(broken(lambda r: r["checklist"].update(label="no placeholders")))
        self.assertTrue(broken(lambda r: r.update(version=1)))

    def test_the_verdicts_deep_variants_are_validated(self):
        # the mod's /spick verdicts deep: two bullets carry a second text, the judgement phrase a second wording
        bullets = RULES["checklist"]["bullets"]
        self.assertEqual([b["name"] for b in bullets if rr.VERDICTS_KEY in b], ["DEEP", "YOU"])
        self.assertEqual(list(RULES[rr.PHRASES_VERDICTS_DEEP]), ["judgement"])
        self.assertTrue(broken(lambda r: r["checklist"]["bullets"][1].update(verdicts_deep="no dash")))
        self.assertTrue(broken(lambda r: r["checklist"]["bullets"][1].update(verdicts_deep=3)))
        self.assertTrue(broken(lambda r: r[rr.PHRASES_VERDICTS_DEEP].update(judgement="no placeholder")))
        self.assertTrue(broken(lambda r: r[rr.PHRASES_VERDICTS_DEEP].update(bogus="x {t}")))
        self.assertTrue(broken(lambda r: r.update(phrases_verdicts_deep=["x"])))
        # both are optional: without them the policy is the default alone
        self.assertEqual(broken(lambda r: (r.pop(rr.PHRASES_VERDICTS_DEEP), [b.pop(rr.VERDICTS_KEY, None) for b in r["checklist"]["bullets"]])), [])


class Rendered(unittest.TestCase):
    def test_check_is_clean(self):
        r = subprocess.run([sys.executable, os.path.join(HERE, "render_rules.py"), "--check"], capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stderr), (0, ""))

    def test_check_names_a_drifted_target(self):
        # a copy of rules.json with one word changed: every target that carries it differs
        import json
        import tempfile
        r = copy.deepcopy(RULES)
        r["checklist"]["title"] = "[spick triage - changed]"
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(r, f)
        try:
            problems = rr.render(check=True, rules_path=f.name)
        finally:
            os.unlink(f.name)
        self.assertTrue(any("checklist.txt" in p for p in problems))
        self.assertTrue(any("checklist.ts" in p for p in problems))

    def test_every_variant_keeps_the_kinds_in_order_and_ends_with_the_label(self):
        for v in rr.VARIANTS:
            lines = rr.checklist_variant(RULES, v)
            self.assertTrue(lines[0].startswith("[spick triage"))
            self.assertTrue(lines[-1].startswith("Reply starts with the deliverable"))
            self.assertEqual(sum(1 for line in lines if line.startswith("   - ")), len(RULES["checklist"]["bullets"]))
        self.assertIn("Review: skipped]", rr.checklist_variant(RULES, "none")[-1])

    def test_the_verdicts_deep_variant_swaps_two_bullets_and_nothing_else(self):
        swapped = [b for b in RULES["checklist"]["bullets"] if rr.VERDICTS_KEY in b]
        for v in rr.VARIANTS:
            keep, deep = rr.checklist_variant(RULES, v), rr.checklist_variant(RULES, v, verdicts="deep")
            self.assertEqual(len(keep), len(deep))
            diff = [(a, b) for a, b in zip(keep, deep) if a != b]
            self.assertEqual([a for a, _ in diff], [rr.bullet_text(b, v) for b in swapped])
            self.assertEqual([b for _, b in diff], [b[rr.VERDICTS_KEY] for b in swapped])
            self.assertEqual(rr.checklist_variant(RULES, v, verdicts="keep"), keep)
        # the hook's file carries the default only; the mod's constants carry both
        with open(rr.CHECKLIST_TXT, encoding="utf-8") as f:
            self.assertNotIn("small material too", f.read())
        with open(rr.CHECKLIST_TS, encoding="utf-8") as f:
            ts = f.read()
        for name in ("LANE_BULLET_DEEP_VERDICTS_DEEP", "LANE_BULLET_YOU_VERDICTS_DEEP", "LANE_BULLETS_BUILTIN_VERDICTS_DEEP",
                     "LANE_BULLETS_REGISTRY_VERDICTS_DEEP", "LANE_BULLETS_NONE_VERDICTS_DEEP"):
            self.assertIn("export const %s" % name, ts)
        with open(rr.HINT_TS, encoding="utf-8") as f:
            self.assertIn("export const PHRASE_TEMPLATES_VERDICTS_DEEP", f.read())


class Budget(unittest.TestCase):
    """Spec section 9: the always-on text stays small; the numbers live in rules.json and are asserted here too."""

    def test_the_numbers_are_the_specs(self):
        self.assertEqual(RULES["budget"], {"snippet_lines": 30, "snippet_words": 450, "checklist_lines": 14,
                                           "checklist_words": 320, "skill_words": 2000})

    def test_the_rendered_checklist_fits(self):
        b = RULES["budget"]
        # the variant the model sees, Hint, Lanes and Quota lines aside (the scripts append those), under both
        # values of the mod's verdicts switch
        for v in rr.VARIANTS:
            for verdicts in ("keep", "deep"):
                lines = rr.checklist_variant(RULES, v, verdicts=verdicts)
                self.assertLessEqual(len(lines), b["checklist_lines"], (v, verdicts))
                self.assertLessEqual(words("\n".join(lines)), b["checklist_words"], (v, verdicts))

    def test_the_snippet_fits(self):
        with open(rr.SNIPPET, encoding="utf-8") as f:
            text = f.read()
        self.assertLessEqual(len(text.rstrip("\n").split("\n")), RULES["budget"]["snippet_lines"])
        self.assertLessEqual(words(text), RULES["budget"]["snippet_words"])

    def test_skill_md_fits(self):
        with open(rr.SKILL_MD, encoding="utf-8") as f:
            self.assertLessEqual(words(f.read()), RULES["budget"]["skill_words"])


if __name__ == "__main__":
    unittest.main()
