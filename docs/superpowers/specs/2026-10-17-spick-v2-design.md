# spick v2: design

Status: approved for implementation 2026-10-17. Base: branch `spick-v2` (cut from `claude/review-round-1-b8e17b`,
which holds review round 1). Inputs: the two reviews of 2026-10-16 (Fable, Codex gpt-6-astra) and
`docs/research/2026-10-17-landscape.md`.

## 1. What v2 is for

spick's claim is that a small main session that delegates by the shape of the deliverable costs less than a strong
main session, without losing quality. v1 never measured it, and its controls were advisory (a stop-time nag) or
untruthful (a check counted before it ran; the guard blind inside a worktree). v2 does three things:

1. Makes every routing decision an observable record, and ships the harness that measures the claim.
2. Moves enforcement to the cheapest moment and bases it on facts (an edit, a failed check), not keywords.
3. Fixes every verified defect of both reviews and puts the rules in one data file that renders every copy.

Out of scope for v2 (deferred, with the reason): changing the main model mid-session (claude-router does it, with
cache and hysteresis machinery spick must not duplicate); a semantic classifier service (prompt text would leave the
machine; keyword hints stay advice); Windows support beyond what bash and python already give.

## 2. Rules as data

`skills/spick/assets/rules.json` is the single source of the routing policy. Shape (version 2):

```json
{
  "version": 2,
  "kinds": [
    {"id": "x-data",   "order": 1, "label": "X / Twitter data",            "route": "lane:x-data",   "fallback": "tell the user; never fake it with web search"},
    {"id": "image",    "order": 2, "label": "image generation or editing",  "route": "lane:image",    "fallback": "tell the user"},
    {"id": "long",     "order": 3, "label": "long video/audio, documents far beyond ~200 pages", "route": "lane:long-context", "fallback": "agent:deep (documents only)"},
    {"id": "search",   "order": 4, "label": "live web, fact check, versions, prices", "route": "lane:search", "fallback": "agent:general-purpose sonnet medium with WebSearch; judging the findings stays deep's"},
    {"id": "verdict",  "order": 5, "label": "compare, evaluate, find gaps, diagnose why, review a codebase or a design, recommend, formal writing", "route": "agent:deep", "keep_if": "the answer is two numbers or a fact already on disk"},
    {"id": "decision", "order": 6, "label": "a change that needs an architecture, public interface, data-format or cross-module decision the user did not make", "route": "agent:planner then agent:coder"},
    {"id": "code",     "order": 7, "label": "changed code beyond one file where the goal is clear; local layout, naming and file choice are the coder's", "route": "agent:coder"},
    {"id": "review",   "order": 8, "label": "independent review of a diff", "route": "lane:review", "fallback": "agent:deep"},
    {"id": "lookup",   "order": 9, "label": "the answer is already in a file here, a command's output or your own knowledge; a one-file edit", "route": "self"}
  ],
  "efforts": {"coder": {"default": "medium", ...}, "planner": {...}, "deep": {"default": "medium", "medium": "...", "high": "...", "xhigh": "...", "max": "..."}},
  "hints": { "judgement": [...], "review": [...], "design": [...], "code": [...], "web": [...], "x": [...] },
  "negations": ["不要", "别", "不用", "无需", "don't", "do not", "no need to", "without"],
  "phrases": { "judgement": "...", ... },
  "budget": {"snippet_lines": 30, "snippet_words": 450, "checklist_lines": 14, "checklist_words": 320, "skill_words": 2000}
}
```

`scripts/render_rules.py` renders four targets between marker pairs and `--check` fails when any target differs:

- `skills/spick/assets/checklist.txt`: the whole hook text (items 1 to 3, the lane bullets in `order`, the tail). `triage-hook.sh` prints this file instead of its heredocs; the Hint, Lanes and Quota lines are still appended by the scripts.
- `mod/spick-dashboard/hooks/checklist.ts` between `// rules:start` and `// rules:end`: the same lines as exported constants (`LANE_BULLETS_BUILTIN`, `LANE_BULLETS_REGISTRY`, `LANE_TAIL`, ...).
- `mod/spick-dashboard/hooks/hint.ts` between `// hints:start` and `// hints:end` (already exists): keywords, negations, phrases.
- `skills/spick/SKILL.md` and `skills/spick/assets/claude-md-snippet.md` between `<!-- rules:start -->` and `<!-- rules:end -->`: the routing table and the effort table as Markdown.

The lane order is one list, used everywhere; the SKILL/snippet/hook inconsistency of v1 (capabilities first in one, deep first in another) ends here. `test_rules.py` runs `--check`, validates the schema, and asserts the budget numbers against the rendered files.

## 3. Routing policy changes

- **Not dispatching is the default for small work.** A one-file change with a clear goal is the main session's; a verdict whose answer is a number or a fact on disk is kept with a `Kept:` line. The checklist says so in one line.
- **Planner threshold narrows** to architecture, public interface, data format and cross-module trade-offs. Local layout, naming and which file are the coder's own decisions (Astra P2, okazaky).
- **The brief is a handoff packet** (the Handoff Tax lesson): Goal (the user's words), Workspace state, Verified findings, Failed approaches, Remaining work, Hard constraints (verbatim), Done when, Report. "Never paste your own trail."
- **Output contract keeps evidence.** Delegates end with an `Evidence` block (checks run with output, files changed, limits and uncertainties). The main session strips openers, closers and label lines only; it never removes the Evidence block or a stated limitation. SKILL Step 6 and the three agent files change accordingly.
- **Explore on Haiku.** `assets/agents/Explore.md` (model haiku, effort low, tools Read Grep Glob Bash read-only) is installed by setup unless `--no-explore`. The implementer verifies with `claude agents` whether a user-level file overrides the built-in Explore; if only a project-level file does, document that and keep the asset.
- **Escalation on facts.** When the same test command fails twice in a turn, the checklist's guard note says: escalate to `coder` at high effort, or to `deep` if the cause is unknown. The mod detects it (two Bash tool results of a check command with a failure) and adds one line of context to the next prompt of the turn (`tool.call` on Bash can append `context`).
- deep defaults to medium (round 1). Search fallback is a Sonnet general-purpose agent (round 1).

## 4. Hint v2

- Before matching, blank out URLs (keep the "a web address" web sign), path-like tokens (contain `/` without spaces, or start with `~`, `./`, `../`), and fenced code blocks.
- A keyword preceded within 6 characters by a negation from `rules.negations` does not fire.
- `test_triage_hint.py` and `hint.test.ts` share a labelled corpus `skills/spick/scripts/testdata/hint_corpus.json` (prompt, expected kinds), at least 40 prompts, Chinese and English, with paths, negations and the known false positives of both reviews.

## 5. Enforcement v2 (the mod)

- **Edit cap = 1.** With routing in force and the guard on, the main session may itself edit one distinct source file per turn; the second is refused with the reason naming the first and asking for `Agent(coder)`. `isSourcePath` works on the path relative to the session cwd: only a leading `.claude/` is excluded, so a worktree under `.claude/worktrees/` counts; extensionless names `Dockerfile`, `Makefile`, `Justfile`, `Rakefile`, `Gemfile` count as source.
- **Gate by required role.** The hinted kind names a role: judgement -> deep, review -> the review lane or deep. The gate fires at stop when the role did not complete (an Agent call of that type returned, or a review CLI call returned) and the reply has no `Kept:` line and the turn was substantive (a tool call, or a reply of 400+ characters). Design is a hint only, never gated (round 1).
- **Guard truthfulness.** A check counts only when (a) the Bash tool result returned without an error and (b) it ran after the last source edit of the turn (timestamps). The command's own first word (after `env`, `npx`, `sudo`, `time`, `cd x &&`) must be the check runner; `echo pytest` and `grep pytest README` do not count. `guard.check_commands` from spick.json stays.
- **One send-back per turn, all reasons at once.** If both the gate and the guard have a reason, the block lists both. After it, nothing more this turn.
- **Context-size note.** The band shows the main loop's last input size (cache read + input); on a Haiku session above 80,000 tokens it adds the warning `context 85k: Haiku bills 5x above 100k; /clear or delegate` (price fact from the claude-api reference; cite it in the code comment).
- **Lanes states.** The quota cache carries `registry: true|false` and `lanes: [...]`. `lanes: []` with `registry: true` renders the bullet "no outside lane is enabled: do not call Gemini, Grok or Codex" and `Review: skipped`; `null` means no registry (built-in bullet). Fixes Astra ③.
- **Data level is fail-closed in invoke.py** (python side): `--contains` above the lane's `data` exits 6 with the fact on stderr; `--override-data "<reason>"` proceeds and prints the reason as a fact line. Without `--contains`, invoke.py classifies the prompt file itself as `code` when it holds a fenced block or three or more lines that look like code (indentation plus `def`, `{`, `;`, `=>`), else `text`; a declared `public` lane needs `--contains public`.
- **Effort defaults by the mod.** On an Agent `tool.call` of `coder`, `planner` or `deep` with no `effort`, the mod fills the default from the rules file if the Mod API lets `next` take a modified envelope; if it does not, skip this item and say so in the report.

## 6. One turn record

The spend file and the gate log of round 1 merge into `~/.claude/spick/turns.jsonl`, one JSON line per main turn, written at the main `turn.complete`:

```
{"at","sessionId","turnId","cwd","mainModel","routing":"on|force|off",
 "hint":["judgement"],"kept":false,"gate":null|{"kind","outcome":"sent-back|kept|delegated"},
 "delegates":[{"lane":"coder","model":"claude-sonnet-5-5","effort":"medium","ok":true,"ms":41000}],
 "edits":{"main":1,"agents":3,"files":["a.py"]},
 "check":null|{"ran":true,"passed":true,"afterLastEdit":true,"command":"python3 -m pytest -q"},
 "usage":{"input","output","cacheRead","cacheWrite","costUsd"},"agentUsage":{...same...},
 "context":{"lastInput":84210},"ms":120000}
```

`scripts/spend.py` reads this file (and the legacy `spick-spend/` files for old sessions). New `scripts/audit.py` prints, for `--days N`: turns by hint kind and what ran; the share of hinted verdicts delegated vs kept; gate firings and their outcomes (a `kept` after `sent-back` is a false positive candidate); turns with edits and no passing check; cost by lane and by kind; the longest sessions by context size. `/spick audit` in the mod runs it.

## 7. Correctness fixes carried into v2

From Astra's review (file:line as of round 1): `_text_of` concatenates all text blocks and `finish_reason=length` / `stop_reason=max_tokens` exit 7 with the partial answer on stdout and `INCOMPLETE` on stderr (invoke.py); `parseCli` restores quoted `-m "model"` (format.ts); quota.ts reads `sampled_at`, `limits[]` and `reset` like quota.py and shows sample age, never read time; setup.sh checks every python step's exit code, validates `settings.json` and `spick.json` before writing, and reports `done` only when all steps passed. From round 1's leftovers: per-session marker (section 8), config-dir rule (section 8), hook quota refresh in the background, purge removes every state file, plugin.json 1.0.0.

## 8. Paths, marker, version

- State lives under `~/.claude/spick/` (quota.json, quota.lock, turns.jsonl, mod-active/, backup/). `spick.json` stays at `~/.claude/spick.json`. Python: `scripts/paths.py` is the one resolver, honouring `CLAUDE_CONFIG_DIR`; TS: `hooks/paths.ts`, reading `CLAUDE_CONFIG_DIR` through `$.env.get` with HOME/.claude as the fallback. setup.sh moves `spick-quota.json`, `spick-spend/`, `spick-gate.jsonl` and `spick-backup/` into the new directory on install (once; old names are then gone).
- Marker: the mod writes `~/.claude/spick/mod-active/<sessionId>` at session start and hourly; the hook reads `session_id` from its stdin JSON and is silent only when that file exists and is younger than 24 hours; it deletes markers older than 24 hours as it goes.
- Version: `skills/spick/assets/VERSION` (1.0.0) is written into `spick.json` as `installed_version` by setup; the hook prints one line (`spick: skill 1.1.0 installed 1.0.0, run spick setup`) when they differ. plugin.json carries the same number.

## 9. Overhead budget

`test_rules.py` fails when the rendered snippet exceeds 30 lines or 450 words, the rendered checklist 14 lines or 320 words, or SKILL.md 2,000 words. The snippet keeps: the scope sentence, the table, the brief rule, the relay rule and the label rule.

## 10. Evaluation harness

`skills/spick/evals/ab/` (tracked):

- `tasks/T1..T8`: T1 chore-count, T2 chore-qa, T3 code-fix (median), T4 debug-lru, T5 plan-backup, T6 formal-brief, copied from the gitignored `mode-compare` workspace with their hidden tests; new T7 verdict-compare (two scripts' error handling, judged) and T8 multi-file feature (three files, hidden tests).
- `run.py --arms haiku-spick,haiku-bare,sonnet-bare,opus-bare --runs N --parallel 2`. Arms: `haiku-spick` = `claude -p --model haiku --settings arm.json --agents <json rendered from assets/agents/*.md> --permission-mode acceptEdits --allowedTools ...` where arm.json adds the v2 hook from this checkout; bare arms add `{"disableAllHooks": true}` and `--disallowedTools Agent`. PATH gets a pytest for the task. The runner records the JSON result, wall time, `modelUsage`, `total_cost_usd`, the turn record from `turns.jsonl` for the spick arm, and the work tree.
- `grade.py`: T1/T2 exact, T3/T4/T8 hidden tests with the visible tests untouched, T6 length/placeholders/forbidden words, T5/T7 blind judge via `codex exec` (labels shuffled, key kept aside), plus per run: cost, wall time, models used, turns.
- `report.py` writes `REPORT-<date>.md`: per arm and task the pass rate, mean cost, mean wall time, with the losing cells kept; a caveats section (global CLAUDE.md still loads in bare arms, one judge, n runs).
- Limits known in advance: `claude -p` reads the user's global CLAUDE.md, so bare arms still see the spick block; `--disallowedTools Agent` keeps them from acting on it. The report says so.

## 11. Work packages and ownership

| Package | Session | Owns (nothing else) |
|---|---|---|
| S1 skill side | Opus | `skills/spick/**` except `scripts/spend.py`, `scripts/audit.py`, `evals/ab/**`; `mod/spick-dashboard/hooks/checklist.ts`, `hint.ts`, `quotaline.ts` and their tests; README.md and README.zh-CN.md except the "Dashboard (optional)" section; CHANGELOG.md |
| S2 mod side | Opus | `mod/spick-dashboard/**` except `checklist.ts`, `hint.ts`, `quotaline.ts`; `skills/spick/scripts/spend.py`, `scripts/audit.py` and their tests; the README "Dashboard (optional)" section in both languages; plugin.json |
| S3 harness | Sonnet | `skills/spick/evals/ab/**`; a new README section "Evaluation" at the end of both READMEs |

Contracts both sides follow without talking: section 6's record shape, section 8's paths and marker name, the cache's `registry`/`lanes` fields, the `// rules:start` markers in checklist.ts (S1 writes between them; S2 never edits checklist.ts), rules.json's effort defaults (S2 reads `assets/rules.json` for the effort fill).

## 12. Acceptance

Both suites green; `render_rules.py --check` clean; shellcheck and ruff clean; `test_rules.py` budget assertions pass; the hint corpus passes on both sides; `evals/ab/run.py` completes one run of T1 and T2 on `haiku-spick` and `haiku-bare` from a clean checkout; CHANGELOG lists every user-visible change; version 1.0.0 everywhere.

## 13. Amendments after the spec review (2026-10-17, Codex gpt-6-astra; full text in docs/reviews/)

Binding on the implementers; where an item is already built, the integrator applies it before merge.

- **Turn record per session** (section 6, 8): the mod writes `<state>/turns/<sessionId>.jsonl`, one file per session, never a shared file (two sessions ending turns together would lose lines; the mod's write queue is per process). `spend.py` and `audit.py` read the directory. Each line carries `schemaVersion: 2`, `delegates[]` with per-delegate `usage`, `costUsd`, `status` (`completed|running|failed|refused`), `gateEvents[]` (every firing and what followed), `checks[]` (each check: command, startedAt, finishedAt, exitOk, editsDuring), and `kept` with the `Kept:` text. A background agent that finishes after the main turn appends a `late: true` line with the same `turnId` holding its usage; readers merge by `turnId`.
- **Role completion** (section 5): a role counts as done when its subagent's `turn.complete` arrived without failure, or a review CLI call returned exit 0. A background agent still running at stop satisfies the gate (the relay comes in a later turn); a refused, failed or timed-out call does not.
- **Check truthfulness** (section 5): the mod binds the check to the edit count at its start and confirms no source edit happened while it ran; the exit status comes from the tool result; `pytest --version`, `pytest || true` and a check whose first word is not the runner do not count. The record keeps what the check covered (the command) so an edit outside its scope still reads as unchecked.
- **Escalation on facts** (section 3, 5): the second failure of the same check (same cwd, same first word and target) appends the escalation line to that second tool result itself, so the model sees it before its next step; the record notes whether an escalation followed.
- **Data level** (section 5): it is a declared constraint, not sensitive-data detection, and the docs say so. Without `--contains`, invoke.py assumes `code` (the strictest); a lane whose `data` is `text` or `public` needs an explicit `--contains` at or below its level; the heuristic then checks the prompt file and any `--system-file` and refuses when it sees code-looking content under a `text`/`public` declaration. `--override-data` prints the reason and is logged.
- **Edit cap scope** (section 5): json, yaml and toml count as source (CI and configuration changes matter); md, txt, csv, tsv, log and lock files do not. Bash writes (`sed -i`, redirections) are not caught; the docs say the cap is a tool-level soft bound, not an enforcement of change size.
- **Explore override** (section 3): acceptance is runtime, not a listing: the A/B run's spick arm spawns Explore and `modelUsage` must show Haiku for it; if a user-level file does not override the built-in, setup installs it project-level on request and the README says which.
- **Return budget** (section 3, 9): a delegate's Evidence block is at most 15 lines; longer logs go to a file under the scratchpad and the block names the path. The main session keeps the block; it never pastes a log.
- **Headless sessions** (section 3): SKILL Step 1b says that in a headless session a prompt that already says to proceed (for example "do it", "no need to ask") is executed without the plan stop.
- **Evaluation** (section 10): the spick arm loads the mod from the checkout with `--plugin-dir mod/spick-dashboard` and disables the globally installed copy through `--settings {"enabledPlugins": {"<installed key>": false}}`; `haiku-hook` (hook only) is a separate arm for ablation; `sonnet-free` and `opus-free` (hooks off, Agent allowed, no spick) are the fair strong baselines next to the single-model `*-bare` arms; the report prices the judge separately, keeps outside-CLI cost as unknown, and reports quality, completion, cost per successful delivery and latency percentiles. Hidden tests stay outside the agent's working tree until grading. The report states what the matrix cannot show: general non-inferiority, real bills, long-session cache effects, leak safety.
- **Traceability** (section 12): `docs/reviews/traceability.md` maps every finding of the three reviews to the spec section, the commit, the regression test, or the deferral reason.
