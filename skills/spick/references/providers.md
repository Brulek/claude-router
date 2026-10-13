# Providers: spells, models, effort, quota, pitfalls

Verified against these versions on 2026-10-13 (macOS). When a `--version` differs, re-check `--help` before trusting a flag.

| CLI | Version | Login | Auth check |
|---|---|---|---|
| `claude` | 2.1.296 | subscription OAuth | `claude -p "hi"` fails with "OAuth session expired" when logged out |
| `codex` | 0.162.1 | ChatGPT account | `codex login status` |
| `grok` | 1.0.52 | SuperGrok account | `grok models` prints "You are not authenticated." when logged out |
| `agy` | Antigravity CLI | Google account | `agy models` lists models only when logged in |

---

## Claude (in-session tiers)

Models: Haiku 5.5 (`haiku`), Sonnet 5.5 (`sonnet`), Opus 5.5 (`opus`), Fable 5.1 (`fable`). Effort levels: low, medium, high, xhigh, max.

- Subagent models are pinned in `~/.claude/agents/{coder,planner,deep}.md` (`model:` and `effort:` frontmatter). Override effort per call with the Agent tool's `effort` parameter.
- The main session cannot change its own model or effort; the user does it in the model menu. The desktop app's model picker remembers its own choice and overrides `settings.json`, so a user who once picked Fable keeps getting Fable until they pick Haiku once.
- Quota source (local, no network): `~/.claude.json` → `cachedUsageUtilization`: `fetchedAtMs` (sample time) and `utilization.limits[]` (`kind` session / weekly_all / weekly_scoped, `percent`, `resets_at`, `scope.model.display_name`); older builds only have `utilization.five_hour|seven_day.utilization`. The CLI refreshes it while running, so it can be hours old.

## Gemini (`agy`, Antigravity CLI)

Strengths: built-in web search, fact checking, long context (documents, video, audio), image generation (image-generator subagent), and it can run Claude Opus/Sonnet 5.5 on Google's quota.

Spell:

```bash
agy -p "<brief> Use only your built-in web search; do not run shell commands, do not read or write files, do not open specific URLs." --model gemini-3.8-flash-medium --effort medium
```

Add `--output-format json` for machine-readable output. Models (from `agy models`): `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium`. Effort flag: `--effort low|medium|high|xhigh|max`.

Pitfalls:
- Headless mode auto-denies permission prompts. Asking it to open a URL triggers `read_url` → denied → empty answer. Asking it to run a command triggers `command` → denied → empty answer. Always say "built-in search only".
- It does not read `AGENTS.md`; put project rules in the prompt.
- Its source links are not fetched by itself. Verify any number you will act on (prices, sizes, versions) with `curl` or an official API before relaying.
- Long answers may be cut and continued; capture the whole stdout, not the tail.
- Quota: `agy -p /usage --output-format json` (about 10 s) answers `command.data.groups[].buckets[]` with `name`, `window` (`weekly`/`5h`), `remaining_fraction` (remaining, so used = 1 minus it) and `reset_time`. Fixture: `scripts/testdata/agy_usage.json`.

## Grok (`grok`, Grok Build)

Strength: X/Twitter data - posts, trends, account activity, sentiment. Use it for nothing else unless it is the only lane left.

Spell:

```bash
grok -p "<brief>" -m grok-4.7 --effort low
```

Models (`grok models`): `grok-4.7` (default), `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`. Effort: `--effort none|minimal|low|medium|high|xhigh|max` (`--reasoning-effort` is an alias). Plugin commands, if the Claude Code grok plugin is installed: `/grok:search`, `/grok:review`, `/grok:rescue`.

Pitfalls:
- Logs out silently; check with `grok models` when a call returns nothing useful. Re-login is `grok login` (user).
- No cloud dispatch from the CLI; "remote sessions" are the machine acting as a worker for grok.com, the opposite direction.
- Image and video generation (Grok Imagine) are web/app only.
- Quota: `grok agent stdio` JSON-RPC (`initialize` with `protocolVersion` "1", `authenticate` with `methodId` `cached_token`, then `_x.ai/billing`; plain `x.ai/billing` is "Method not found") returns the billing period (start, end) and tier only, no used percent. So it reports unknown; if `authenticate` fails the reason is `login needed`.

## Codex (`codex`, ChatGPT subscription)

Strengths: coding, independent code review, second-opinion debugging, image generation through its built-in imagegen skill. Also has a cloud mode (`codex cloud exec --env <ENV_ID>`) that needs an environment created on chatgpt.com/codex; not covered here.

Spells:

```bash
# read-only (review, analysis)
codex exec --skip-git-repo-check --sandbox read-only -c 'model_reasoning_effort="medium"' "<brief>" < /dev/null

# allowed to edit files
codex exec --skip-git-repo-check --sandbox workspace-write -c 'model_reasoning_effort="medium"' "<brief>" < /dev/null

# review the current diff
git diff | codex exec --skip-git-repo-check --sandbox read-only -c 'model_reasoning_effort="high"' \
  "Review this diff for bugs, security issues and missing tests. Be specific; cite file and line. Diff follows on stdin." 

# image generation (if the codex-image Claude Code plugin is installed, prefer its /codex-image:generate command)
codex exec --skip-git-repo-check --full-auto "Generate an image: <prompt>. Save it under ./out/ and print SAVED: <path>" < /dev/null
```

Model flag: `-m <model>`; effort: `-c 'model_reasoning_effort="low|medium|high|xhigh"'`. Leave the model at the account default unless the user names one; the default is the `model` line in `~/.codex/config.toml` (`gpt-6-astra` on this machine as of 2026-10-13), and that name goes into the label line.

Pitfalls (all hit in practice):
- **Must close stdin** (`< /dev/null`) unless you are piping input; otherwise it prints "Reading additional input from stdin..." and hangs forever.
- Outside a git repo it refuses to start without `--skip-git-repo-check`.
- **`high` effort plus a long prompt can hang** behind some proxies: the long time-to-first-byte on the SSE stream gets buffered. For long rewrites use `low` or `medium`. Short tasks are fine at any level.
- A hung `codex exec` survives Ctrl-C of the outer shell. Check with `ps -eo pid,etime,command | grep "bin/codex exec"`, then `ps -o time= -p <pid>` twice; if CPU time does not grow, `pkill -f "codex exec"`.
- Does not self-update: `npm update -g @openai/codex` monthly.
- Quota source: `codex -s read-only -a never app-server` speaks JSON-RPC on stdio: `initialize` (`params.clientInfo`), notification `initialized`, then `account/rateLimits/read` answers `result.rateLimits.primary|secondary` as `{usedPercent, windowDurationMins, resetsAt}` (`secondary` is null on this plan). Fallback when that fails: the newest `~/.codex/sessions/**/rollout-*.jsonl` event with `payload.rate_limits` (`used_percent`, `window_minutes`, `resets_at`), only as fresh as the last session. Fixtures: `scripts/testdata/codex_*`; the schema is unofficial, parse defensively.

## Fallback chains at a glance

```
web search / fact check : gemini → grok → deep(+WebSearch)
X data                  : grok → (none; tell the user)
image gen / edit        : codex → gemini → (tell the user)
video gen               : (none; web only)
long media / huge docs  : gemini → deep (docs only)
coding                  : coder → codex → gemini(claude-sonnet-5-5) 
review                  : codex → deep
planning                : planner → deep
hard reasoning          : deep → gemini(claude-opus-5-5-high)
```

When Claude's own quota is tight (≥80% weekly), coding flips to `codex → coder`.

## Subscriptions and the quota cache

`~/.claude/spick.json` may carry a `subscriptions` object. Only the providers listed in it are collected and shown; a missing key means not subscribed. Write it by hand (setup does not manage it yet):

```json
"subscriptions": {
  "claude": {"plan": "Max 20x", "price": "$200/mo"},
  "codex":  {"plan": "Pro Lite"},
  "gemini": {"plan": "AI Pro"},
  "grok":   {"plan": "SuperGrok"}
}
```

`plan` and `price` are free text, both optional. `scripts/quota.py` collects the raw facts into `~/.claude/spick-quota.json` (written atomically, refreshed in the background when older than 10 minutes, never awaited by the hook) and the checklist prints them as one `Quota` line. Nothing in the program judges them. `status` is only the age of the sample: `fresh` under 30 minutes, `stale` older, `unknown` no data. A window past its `resets_at` is reported with `used_pct` null and `reset` true.
