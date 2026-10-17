"""setup.sh --install: backup before every write, manifest, atomic writes. setup.sh --uninstall: removes
only what install wrote, keeps what the user changed.

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

    def _run(self, *args):
        prefix = tempfile.gettempdir()
        for key in ("CLAUDE_CONFIG_DIR", "HOME"):
            val = self.env[key]
            if not val.startswith(prefix) or os.path.realpath(val).startswith(REAL_CLAUDE):
                self.fail(f"{key}={val!r} is not under the temp prefix {prefix!r}; refusing to run setup.sh")
        r = subprocess.run(["bash", SETUP, *args], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    def run_setup(self, *extra):
        return self._run("--install", "--lanes", "gemini", "--model", "haiku", "--effort", "medium", *extra)

    def run_uninstall(self, *extra):
        return self._run("--uninstall", *extra)

    def path(self, *parts):
        return os.path.join(self.dir, *parts)

    def put(self, name, text):
        with open(self.path(name), "w") as f:
            f.write(text)

    def read(self, *parts):
        with open(self.path(*parts)) as f:
            return f.read()

    def backups(self):
        base = self.path("spick", "backup")
        return sorted(os.path.join(base, d) for d in os.listdir(base)) if os.path.isdir(base) else []

    def settings(self):
        with open(self.path("settings.json")) as f:
            return json.load(f)

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

    def test_explore_is_installed_unless_no_explore(self):
        self.assertIn("Explore.md", AGENTS)
        self.run_setup()
        with open(self.path("agents", "Explore.md")) as f:
            head = f.read().split("---")[1]
        self.assertIn("name: Explore", head)
        self.assertIn("model: haiku", head)
        self.assertIn("tools: Read, Grep, Glob, Bash", head)
        os.unlink(self.path("agents", "Explore.md"))
        r = self.run_setup("--no-explore")
        self.assertFalse(os.path.exists(self.path("agents", "Explore.md")))
        self.assertIn("skip   %s (--no-explore)" % self.path("agents", "Explore.md"), r.stdout)
        self.assertTrue(os.path.exists(self.path("agents", "coder.md")))

    def test_hook_entry_exactly_once_next_to_other_hooks(self):
        other = {"hooks": [{"type": "command", "command": "echo mine"}]}
        self.put("settings.json", json.dumps({"hooks": {"UserPromptSubmit": [other]}}))
        self.run_setup()
        self.run_setup()
        self.assertEqual(len(self.spick_hooks()), 1)
        d = json.loads(self.read("settings.json"))
        self.assertIn(other, d["hooks"]["UserPromptSubmit"])

    def test_hook_command_is_the_absolute_path_next_to_setup(self):
        # not $HOME/.claude/...: the skill may live elsewhere, and CLAUDE_CONFIG_DIR may point elsewhere
        self.run_setup()
        (h,) = self.spick_hooks()
        self.assertEqual(h["command"], 'bash "%s"' % os.path.join(HERE, "triage-hook.sh"))
        self.assertTrue(os.path.isabs(os.path.join(HERE, "triage-hook.sh")))
        self.run_uninstall()
        self.assertEqual(self.spick_hooks(), [])

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


class TestUninstall(Base):
    def test_claude_md_without_a_block_comes_back_byte_for_byte(self):
        user_md = "# 我的规则\n\nKeep answers short.\n"
        self.put("CLAUDE.md", user_md)
        self.run_setup()
        self.run_uninstall()
        with open(self.path("CLAUDE.md"), "rb") as f:
            self.assertEqual(f.read(), user_md.encode())

    def test_claude_md_holding_only_the_block_is_removed(self):
        self.run_setup()
        self.assertTrue(os.path.exists(self.path("CLAUDE.md")))
        self.run_uninstall()
        self.assertFalse(os.path.exists(self.path("CLAUDE.md")))

    def test_text_added_after_the_block_is_kept(self):
        self.put("CLAUDE.md", "top\n")
        self.run_setup()
        with open(self.path("CLAUDE.md"), "a") as f:
            f.write("\nadded later\n")
        self.run_uninstall()
        md = self.read("CLAUDE.md")
        self.assertNotIn(START, md)
        self.assertNotIn(END, md)
        self.assertTrue(md.startswith("top\n"))
        self.assertTrue(md.endswith("added later\n"))

    def test_symlinked_claude_md_stays_a_link(self):
        os.mkdir(self.path("sync"))
        target = self.path("sync", "CLAUDE.md")
        with open(target, "w") as f:
            f.write("synced rules\n")
        os.symlink(target, self.path("CLAUDE.md"))
        self.run_setup()
        self.run_uninstall()
        self.assertTrue(os.path.islink(self.path("CLAUDE.md")))
        with open(target) as f:
            self.assertEqual(f.read(), "synced rules\n")

    def test_settings_hook_gone_model_back_other_keys_kept(self):
        other = {"hooks": [{"type": "command", "command": "echo mine"}]}
        self.put("settings.json", json.dumps({"model": "sonnet", "theme": "dark",
                                              "hooks": {"UserPromptSubmit": [other]}}))
        self.run_setup()
        self.run_uninstall()
        d = self.settings()
        self.assertEqual(d["model"], "sonnet")
        self.assertNotIn("effortLevel", d)  # it was not set before install
        self.assertEqual(d["theme"], "dark")
        self.assertEqual(d["hooks"]["UserPromptSubmit"], [other])
        self.assertEqual(self.spick_hooks(), [])

    def test_empty_hook_list_and_hooks_key_are_dropped(self):
        self.run_setup()
        self.run_uninstall()
        d = self.settings()
        self.assertNotIn("hooks", d)
        self.assertNotIn("model", d)
        self.assertNotIn("effortLevel", d)

    def test_model_changed_by_hand_is_kept(self):
        self.put("settings.json", json.dumps({"model": "sonnet"}))
        self.run_setup()
        d = self.settings()
        d["model"] = "opus"
        self.put("settings.json", json.dumps(d))
        r = self.run_uninstall()
        self.assertEqual(self.settings()["model"], "opus")
        self.assertIn("keep   model=opus (changed since install)", r.stdout)
        self.assertNotIn("effortLevel", self.settings())

    def test_reinstall_then_uninstall_restores_the_value_from_before_spick(self):
        self.put("settings.json", json.dumps({"model": "sonnet"}))
        self.run_setup()
        self.run_setup()
        self.run_uninstall()
        self.assertEqual(self.settings()["model"], "sonnet")

    def test_install_without_manifest_still_removes_the_rest(self):
        # an install made before backups existed: no manifest at all
        self.put("settings.json", json.dumps({"model": "sonnet"}))
        self.run_setup()
        for b in self.backups():
            os.unlink(os.path.join(b, "manifest.json"))
        r = self.run_uninstall()
        self.assertEqual(self.settings()["model"], "haiku")
        self.assertIn("keep   model=haiku (no install record", r.stdout)
        self.assertEqual(self.spick_hooks(), [])
        self.assertFalse(os.path.exists(self.path("CLAUDE.md")))
        for a in AGENTS:
            self.assertFalse(os.path.exists(self.path("agents", a)))

    def test_agents_removed_hand_edited_kept_unless_force(self):
        self.run_setup()
        edited = self.path("agents", AGENTS[0])
        with open(edited, "a") as f:
            f.write("\nmy own note\n")
        r = self.run_uninstall()
        self.assertTrue(os.path.exists(edited))
        self.assertIn(f"keep   {edited} (changed since install; --force to remove)", r.stdout)
        for a in AGENTS[1:]:
            self.assertFalse(os.path.exists(self.path("agents", a)))
        self.run_uninstall("--force")
        self.assertFalse(os.path.exists(edited))

    def test_state_files_and_purge(self):
        self.run_setup()
        os.makedirs(self.path("spick", "mod-active"))
        for p in (self.path("spick", "mod-active", "s1"), self.path("spick", "quota.json")):
            with open(p, "w") as f:
                f.write("x")
        os.makedirs(self.path("spick", "turns"))
        self.put(os.path.join("spick", "turns", "s1.jsonl"), "{}\n")
        r = self.run_uninstall()
        self.assertFalse(os.path.exists(self.path("spick", "mod-active")))
        self.assertFalse(os.path.exists(self.path("spick", "quota.json")))
        # turn records and backups stay without --purge
        self.assertTrue(os.path.exists(self.path("spick", "turns", "s1.jsonl")))
        self.assertTrue(os.path.exists(self.path("spick.json")))
        self.assertIn("(turn records, backups; --purge to remove)", r.stdout)
        r = self.run_uninstall("--purge")
        self.assertFalse(os.path.exists(self.path("spick.json")))
        self.assertFalse(os.path.exists(self.path("spick")))
        self.assertIn(f"  removed {self.path('spick')} (--purge)\n", r.stdout)

class TestState(Base):
    def test_round_1_state_files_move_into_the_state_dir_once(self):
        self.put("spick-quota.json", '{"written_at": "x"}')
        os.makedirs(self.path("spick-spend"))
        self.put(os.path.join("spick-spend", "s1.json"), "{}")
        self.put("spick-gate.jsonl", '{"a": 1}\n')
        os.makedirs(self.path("spick-backup", "20261001-120000"))
        self.put(os.path.join("spick-backup", "20261001-120000", "manifest.json"), "{}")
        self.put(".spick-mod-active", "x")
        r = self.run_setup()
        for old in ("spick-quota.json", "spick-spend", "spick-gate.jsonl", "spick-backup", ".spick-mod-active"):
            self.assertFalse(os.path.exists(self.path(old)), old)
        self.assertEqual(self.read("spick", "quota.json"), '{"written_at": "x"}')
        self.assertTrue(os.path.exists(self.path("spick", "spend", "s1.json")))
        self.assertEqual(self.read("spick", "gate.jsonl"), '{"a": 1}\n')
        # the old backup sits next to this run's
        self.assertEqual(len(self.backups()), 2)
        self.assertIn("moved  %s -> %s" % (self.path("spick-spend"), self.path("spick", "spend")), r.stdout)
        # nothing left to move: the second run says nothing about it
        self.assertNotIn("round 1 ->", self.run_setup().stdout)

    def test_a_log_already_in_place_keeps_both_halves(self):
        os.makedirs(self.path("spick"))
        self.put(os.path.join("spick", "gate.jsonl"), '{"new": 1}\n')
        self.put("spick-gate.jsonl", '{"old": 1}')
        self.run_setup()
        self.assertEqual(self.read("spick", "gate.jsonl"), '{"old": 1}\n{"new": 1}\n')

    def test_paths_py_and_setup_agree_on_the_state_dir(self):
        def ask(name):
            r = subprocess.run(["python3", os.path.join(HERE, "paths.py"), name], env=self.env, capture_output=True, text=True)
            return r.stdout.strip()
        self.assertEqual(ask("state"), self.path("spick"))
        self.assertEqual(ask("turns"), self.path("spick", "turns"))
        self.run_setup()
        self.assertTrue(self.backups()[0].startswith(self.path("spick", "backup") + os.sep))

    def test_installed_version_is_the_skill_version(self):
        self.run_setup()
        with open(os.path.join(HERE, "..", "assets", "VERSION")) as f:
            version = f.read().strip()
        self.assertEqual(version, "1.0.0")
        self.assertEqual(json.loads(self.read("spick.json"))["installed_version"], version)


class TestUninstallMore(Base):
    def test_uninstall_writes_its_own_backup_manifest(self):
        self.run_setup()
        before_md = self.read("CLAUDE.md")
        self.run_uninstall()
        dirs = self.backups()
        self.assertEqual(len(dirs), 2)
        m = self.manifest(dirs[1])
        self.assertEqual(m["action"], "uninstall")
        self.assertEqual(m["settings"]["model"], {"before": "haiku", "after": None})
        with open(os.path.join(dirs[1], "CLAUDE.md")) as f:
            self.assertEqual(f.read(), before_md)

    def test_uninstall_twice_is_harmless(self):
        self.put("settings.json", json.dumps({"model": "sonnet"}))
        self.run_setup()
        self.run_uninstall()
        r = self.run_uninstall()
        self.assertEqual(self.settings()["model"], "sonnet")
        self.assertIn("no install record since the last uninstall", r.stdout)
        self.assertEqual(len(self.backups()), 3)

    def test_uninstall_on_a_fresh_dir(self):
        r = self.run_uninstall()
        self.assertIn("does not exist", r.stdout)
        self.assertEqual(len(self.backups()), 1)


if __name__ == "__main__":
    unittest.main()
