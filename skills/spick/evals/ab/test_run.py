import json
import unittest

import common
import run


class Agents(unittest.TestCase):
    def test_render_matches_assets(self):
        agents = json.loads(run.render_agents())
        self.assertEqual(sorted(agents), ["coder", "deep", "planner"])
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


if __name__ == "__main__":
    unittest.main()
