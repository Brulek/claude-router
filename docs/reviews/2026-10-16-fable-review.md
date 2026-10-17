# Review of spick, 2026-10-16 (Claude Fable 5.1, in the user's session)

Scope: the whole repository at 343354d (main) read end to end, both test suites run (220 python, 219 mod, green), a
probe that showed a `coder` subagent sees the CLAUDE.md routing block but not the hook checklist.

## Findings (numbered as in the session)

Correctness:
1. The CLAUDE.md snippet is read by subagents and contradicts their role ("you never edit source files").
2. The checklist text exists in four copies (SKILL.md, snippet, bash hook, checklist.ts); only the hint table had a drift test.
3. Machine-specific facts shipped to every user (`Review: Codex gpt-6-astra (medium)` in the hook and mod; "on this machine" in providers.md).
4. Config-dir paths inconsistent: the hook command hard-coded `$HOME/.claude/skills/...`; the marker under `$HOME` in one place and `$CLAUDE_DIR` in another; the mod only knows HOME.

Worth doing:
5. Evaluation evidence out of date: the benchmark predates the route-by-shape rules, Hint, gate and guard; 14 evals never run; mode-compare n=1.
6. Keyword false positives (`add`, `why`, `分析`, `设计`) and the gate turning them into a cost; gate should act on judgement/review only and log firings.
7. SKILL.md at 4,500 words read by Haiku on every non-trivial task.
8. `subscriptions` hand-written in spick.json against the "never hand-edit" rule.
9. The guard's check detector misses `python test_x.py`, `node --test`, `./run_tests.sh`, `cargo build`, `swift build`.
10. No Fable price in the spend table.
11. CI without shellcheck or ruff; mod tests pinned to one Claude Code version; a plan file with every box unticked.

Design questions:
12. "You never write a verdict" sends every "why" to Opus high; consider deep at medium or a Sonnet judge.
13. The search fallback to deep with WebSearch is expensive; a Sonnet general-purpose agent is enough.
14. A Fable or Opus session switches spick off entirely; document it and give `force` a reason to exist.

## Architecture review (same day)

Structural: one rule set with four renderers; the mod-to-hook marker is global and expires in 24 h (silences other
sessions); state scattered over ten files and two config-dir conventions; built-in lanes invoked from prose while
registry lanes go through invoke.py; no upgrade path (agents and the snippet are copies); register.tsx as a 1,228-line
god module; the quota line formatted twice (python and TS).

Strategic: whether to change the main model mid-session at all (answered later: no, claude-router does it with the
cache machinery spick should not duplicate); gate at stop time is the most expensive moment to intervene; the logs
should become the measurement layer; keyword hints have a ceiling.

Verdict on 2026-10-17: not the best it can be; the gap is evidence (no measurement of the core claim) and binding
force (advisory controls), not features.
