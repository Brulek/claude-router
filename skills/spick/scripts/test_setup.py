"""setup.sh --install: backup before every write, manifest, atomic writes.

Every run goes through Base.run_setup, which points CLAUDE_CONFIG_DIR and HOME at a temp dir and fails
the test before running anything if either is not under the temp prefix, so the real ~/.claude is
never touched."""
import glob
import json
import os
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SETUP = os.path.join(HERE, "setup.sh")
AGENTS = sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "..", "assets", "agents", "*.md")))
START, END = "<!-- spick:start -->", "<!-- spick:end -->"
HOOK = "spick/scripts/triage-hook.sh"
REAL_CLAUDE = os.path.realpath(os.path.expanduser("~/.claude"))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name
        self.env = dict(os.environ, CLAUDE_CONFIG_DIR=self.dir, HOME=self.dir)

    def run_setup(self, *extra):
        prefix = tempfile.gettempdir()
        for key in ("CLAUDE_CONFIG_DIR", "HOME"):
            val = self.env[key]
            if not val.startswith(prefix) or os.path.realpath(val).startswith(REAL_CLAUDE):
                self.fail(f"{key}={val!r} is not under the temp prefix {prefix!r}; refusing to run setup.sh")
        r = subprocess.run(["bash", SETUP, "--install", "--lanes", "gemini", "--model", "haiku", "--effort", "medium",
                            *extra], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    def path(self, *parts):
        return os.path.join(self.dir, *parts)

    def put(self, name, text):
        with open(self.path(name), "w") as f:
            f.write(text)

    def read(self, *parts):
        with open(self.path(*parts)) as f:
            return f.read()

    def backups(self):
        base = self.path("spick-backup")
        return sorted(os.path.join(base, d) for d in os.listdir(base)) if os.path.isdir(base) else []

    def manifest(self, backup_dir):
        with open(os.path.join(backup_dir, "manifest.json")) as f:
            return json.load(f)

    def spick_hooks(self):
        with open(self.path("settings.json")) as f:
            d = json.load(f)
        return [h for e in d.get("hooks", {}).get("UserPromptSubmit", []) for h in e.get("hooks", [])
                if HOOK in h.get("command", "")]


class TestBackup(Base):
    def test_backup_dir_and_manifest_on_a_fresh_dir(self):
        r = self.run_setup()
        dirs = self.backups()
        self.assertEqual(len(dirs), 1)
        self.assertRegex(os.path.basename(dirs[0]), r"^\d{8}-\d{6}$")
        self.assertIn(f"  backup {dirs[0]}\n", r.stdout)
        # nothing existed before, so only the manifest is in the backup
        self.assertEqual(os.listdir(dirs[0]), ["manifest.json"])
        m = self.manifest(dirs[0])
        self.assertEqual(m["action"], "install")
        self.assertTrue(m["at"])
        self.assertEqual(sorted(os.path.basename(p) for p in m["agents_written"]), AGENTS)
        self.assertTrue(m["claude_md_block"])
        self.assertTrue(m["hook_added"])
        self.assertEqual(m["settings"], {"model": {"before": None, "after": "haiku"},
                                         "effortLevel": {"before": None, "after": "medium"}})

    def test_existing_files_are_backed_up_byte_for_byte(self):
        user_md = "# 我的规则\n\nKeep answers short.\n"
        settings = '{\n  "model": "sonnet",\n  "theme": "dark"\n}\n'
        cfg = '{"version": 1, "subscriptions": {"codex": "plus"}}'
        self.put("CLAUDE.md", user_md)
        self.put("settings.json", settings)
        self.put("spick.json", cfg)
        self.run_setup()
        (b,) = self.backups()
        with open(os.path.join(b, "CLAUDE.md"), "rb") as f:
            self.assertEqual(f.read(), user_md.encode())
        with open(os.path.join(b, "settings.json"), "rb") as f:
            self.assertEqual(f.read(), settings.encode())
        with open(os.path.join(b, "spick.json"), "rb") as f:
            self.assertEqual(f.read(), cfg.encode())
        md = self.read("CLAUDE.md")
        self.assertTrue(md.startswith(user_md.rstrip()))
        self.assertEqual(md.count(START), 1)
        self.assertEqual(md.count(END), 1)
        m = self.manifest(b)
        self.assertEqual(m["settings"]["model"], {"before": "sonnet", "after": "haiku"})
        s = json.loads(self.read("settings.json"))
        self.assertEqual(s["theme"], "dark")

    def test_two_runs_two_backups_no_duplicates(self):
        self.put("CLAUDE.md", "user text\n")
        self.run_setup()
        after_first = self.read("CLAUDE.md")
        self.run_setup()
        dirs = self.backups()
        self.assertEqual(len(dirs), 2)
        self.assertEqual(self.read("CLAUDE.md").count(START), 1)
        self.assertEqual(len(self.spick_hooks()), 1)
        # the second backup holds the file as the first run left it
        with open(os.path.join(dirs[1], "CLAUDE.md")) as f:
            self.assertEqual(f.read(), after_first)
        m2 = self.manifest(dirs[1])
        self.assertFalse(m2["hook_added"])
        self.assertEqual(m2["agents_written"], [])  # agents exist and --force was not given
        self.assertEqual(m2["settings"]["model"], {"before": "haiku", "after": "haiku"})

    def test_hook_entry_exactly_once_next_to_other_hooks(self):
        other = {"hooks": [{"type": "command", "command": "echo mine"}]}
        self.put("settings.json", json.dumps({"hooks": {"UserPromptSubmit": [other]}}))
        self.run_setup()
        self.run_setup()
        self.assertEqual(len(self.spick_hooks()), 1)
        d = json.loads(self.read("settings.json"))
        self.assertIn(other, d["hooks"]["UserPromptSubmit"])

    def test_spick_json_keeps_keys_setup_does_not_own(self):
        old = {"version": 1, "subscriptions": {"codex": "plus"}, "lane_registry": {"x": {"kind": "api-key"}},
               "main_session": {"model": "opus"}, "quota": {"warn": 80}}
        self.put("spick.json", json.dumps(old))
        self.run_setup()
        d = json.loads(self.read("spick.json"))
        self.assertEqual(d["subscriptions"], old["subscriptions"])
        self.assertEqual(d["lane_registry"], old["lane_registry"])
        self.assertEqual(d["main_session"], {"model": "haiku", "effort": "medium"})
        self.assertNotIn("quota", d)
        self.assertEqual(d["lanes"], {"gemini": True, "grok": False, "codex": False})
        # the old spick.json.bak behaviour is kept
        self.assertEqual(json.loads(self.read("spick.json.bak")), old)


class TestAtomicWrite(Base):
    def test_symlinked_claude_md_stays_a_link(self):
        os.mkdir(self.path("sync"))
        target = self.path("sync", "CLAUDE.md")
        with open(target, "w") as f:
            f.write("synced rules\n")
        os.symlink(target, self.path("CLAUDE.md"))
        self.run_setup()
        self.assertTrue(os.path.islink(self.path("CLAUDE.md")))
        with open(target) as f:
            text = f.read()
        self.assertTrue(text.startswith("synced rules"))
        self.assertEqual(text.count(START), 1)
        (b,) = self.backups()
        with open(os.path.join(b, "CLAUDE.md")) as f:
            self.assertEqual(f.read(), "synced rules\n")

    def test_settings_mode_kept_and_no_tmp_left(self):
        self.put("settings.json", "{}\n")
        os.chmod(self.path("settings.json"), 0o600)
        self.run_setup()
        self.assertEqual(stat.S_IMODE(os.stat(self.path("settings.json")).st_mode), 0o600)
        left = [p for p in glob.glob(os.path.join(self.dir, "**", "*"), recursive=True) if p.endswith(".spick-tmp")]
        self.assertEqual(left, [])


if __name__ == "__main__":
    unittest.main()
