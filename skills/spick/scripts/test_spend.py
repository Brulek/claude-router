"""spend.py: sums the per-session files the dashboard mod writes under ~/.claude/spick-spend/.

Every test works in a temp HOME; a run of the script as a program fails the test before it starts if HOME is not
under the temp prefix, so the real ~/.claude/spick-spend is never read or written."""
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
import spend  # noqa: E402

SCRIPT = os.path.join(HERE, "spend.py")
FIXTURE = os.path.join(HERE, "testdata", "spend_session.json")
NOW = dt.datetime(2026, 10, 14, 12, 0, tzinfo=dt.timezone.utc)
REAL_CLAUDE = os.path.realpath(os.path.expanduser("~/.claude"))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        self.dir = os.path.join(self.home, ".claude", "spick-spend")

    def put_fixture(self):
        os.makedirs(self.dir, exist_ok=True)
        shutil.copy(FIXTURE, os.path.join(self.dir, "5f0c2a9e-1111-4222-8333-944455556666.json"))

    def put(self, name, doc):
        os.makedirs(self.dir, exist_ok=True)
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as f:
            f.write(doc if isinstance(doc, str) else json.dumps(doc))

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = spend.main(list(argv), home=self.home, now=NOW)
        return code, out.getvalue(), err.getvalue()

    def run_json(self, *argv):
        code, out, _ = self.run_main("--json", *argv)
        self.assertEqual(code, 0)
        return json.loads(out)

    def run_script(self, *argv):
        prefix = tempfile.gettempdir()
        if not self.home.startswith(prefix) or os.path.realpath(self.home).startswith(REAL_CLAUDE):
            self.fail(f"HOME={self.home!r} is not under the temp prefix {prefix!r}; refusing to run spend.py")
        env = dict(os.environ, HOME=self.home)
        return subprocess.run([sys.executable, SCRIPT, *argv], env=env, capture_output=True, text=True, timeout=30)


class TestEmpty(Base):
    def test_no_directory_prints_no_records(self):
        r = self.run_script("--days", "30")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "spick spend: no records\n")

    def test_empty_directory_prints_no_records(self):
        os.makedirs(self.dir)
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "spick spend: no records\n")

    def test_rows_outside_the_window_are_no_records(self):
        self.put_fixture()
        code, out, _ = self.run_main("--days", "1")
        self.assertEqual((code, out), (0, "spick spend: no records\n"))

    def test_days_below_one_is_refused(self):
        r = self.run_script("--days", "0")
        self.assertEqual(r.returncode, 2)


class TestByLane(Base):
    def test_last_seven_days_by_lane(self):
        self.put_fixture()
        d = self.run_json()
        self.assertEqual((d["days"], d["by"], d["sessions"]), (7, "lane", 1))
        self.assertEqual([g["key"] for g in d["groups"]], ["coder", "main session", "Gemini"])
        coder, main, gemini = d["groups"]
        self.assertEqual((coder["rows"], coder["inputTokens"], coder["outputTokens"], coder["costUsd"]), (1, 200000, 20000, 0.9))
        self.assertEqual((main["rows"], main["cacheReadTokens"], main["cacheCreationTokens"], main["costUsd"]), (1, 50000, 1000, 0.05))
        # a CLI call: counted, unpriced
        self.assertEqual((gemini["rows"], gemini["inputTokens"], gemini["costUsd"], gemini["unpriced"]), (1, 0, None, 1))
        self.assertEqual((d["total"]["rows"], d["total"]["unpriced"]), (3, 1))
        self.assertAlmostEqual(d["total"]["costUsd"], 0.95)

    def test_days_widens_the_window(self):
        self.put_fixture()
        d = self.run_json("--days", "30")
        main = next(g for g in d["groups"] if g["key"] == "main session")
        self.assertEqual(main["rows"], 2)
        self.assertAlmostEqual(main["costUsd"], 0.06)
        self.assertEqual(d["total"]["rows"], 4)

    def test_table_text(self):
        self.put_fixture()
        code, out, err = self.run_main()
        self.assertEqual((code, err), (0, ""))
        lines = out.splitlines()
        self.assertEqual(lines[0], "spick spend: last 7 days, by lane (1 session, 3 rows)")
        self.assertEqual(lines[1].split(), ["lane", "rows", "input", "output", "cache", "read", "cache", "write", "cost"])
        self.assertTrue(lines[2].startswith("coder "))
        self.assertTrue(lines[2].endswith("$0.90"))
        self.assertTrue(lines[4].startswith("Gemini ") and lines[4].endswith("-"))
        self.assertTrue(lines[5].startswith("total ") and lines[5].endswith("$0.95"))
        self.assertIn("200,000", lines[2])
        self.assertEqual(lines[6], "cost leaves out 1 unpriced row (outside CLI calls report no usage; a model with no price)")


class TestByDayAndSession(Base):
    def test_by_day_in_date_order(self):
        self.put_fixture()
        d = self.run_json("--days", "30", "--by", "day")
        self.assertEqual([(g["key"], g["rows"]) for g in d["groups"]], [("2026-10-01", 1), ("2026-10-12", 3)])

    def test_by_session_two_files(self):
        self.put_fixture()
        self.put("s2.json", {"sessionId": "s2", "cwd": "/repo", "startedAt": "2026-10-13T00:00:00.000Z", "rows": [
            {"at": "2026-10-13T00:00:01.000Z", "turnId": "x", "lane": "main session", "model": "m", "inputTokens": 5,
             "outputTokens": 6, "cacheReadTokens": 0, "cacheCreationTokens": 0, "costUsd": 2.5}]})
        d = self.run_json("--by", "session")
        self.assertEqual(d["sessions"], 2)
        self.assertEqual([(g["key"], g["cwd"], g["rows"]) for g in d["groups"]],
                         [("s2", "/repo", 1), ("5f0c2a9e-1111-4222-8333-944455556666", "/Users/me/dev/app", 3)])
        code, out, _ = self.run_main("--by", "session")
        self.assertIn("5f0c2a9e  /Users/me/dev/app", out)


class TestBadFiles(Base):
    def test_unreadable_files_are_skipped_and_counted(self):
        self.put_fixture()
        self.put("broken.json", "{not json")
        self.put("list.json", "[1, 2]")
        self.put("rowsbad.json", {"sessionId": "x", "rows": [1, {"at": "not a time"}, {"lane": "no time"}]})
        code, out, err = self.run_main("--json")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["total"]["rows"], 3)
        self.assertEqual(err, "spend.py: skipped 2 files that are not spend records\n")

    def test_non_numbers_count_as_zero_and_unpriced(self):
        self.put("s.json", {"sessionId": "s", "rows": [{"at": "2026-10-14T00:00:00Z", "lane": "coder", "inputTokens": "9",
                                                        "outputTokens": True, "costUsd": "1"}]})
        g = self.run_json()["groups"][0]
        self.assertEqual((g["inputTokens"], g["outputTokens"], g["costUsd"], g["unpriced"]), (0, 0, None, 1))


if __name__ == "__main__":
    unittest.main()
