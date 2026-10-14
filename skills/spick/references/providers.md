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

## Lane registry

Built-in lanes (gemini, grok, codex) are records in `assets/builtin-lanes.json`. The user may override any field of them, and add lanes of their own, under `lane_registry` in `~/.claude/spick.json`, keyed by lane id (lowercase letters, digits, hyphens). The `lanes` booleans still switch built-ins on and off. If `lane_registry` is absent, nothing below applies and all output stays as before. `python3 scripts/lanes.py --validate` checks the file; secret-looking values are reported by field name, never echoed.

| Field | Meaning |
|---|---|
| `name` | display name |
| `kind` | `cli-subscription`, `api-key`, `local`, `relay` or `web-only` |
| `enabled` | false leaves the lane out entirely |
| `tags` | what the lane is for, free words (`search`, `x-data`, `image`, `long-context`, `multimodal`, `code`, `review`, `cheap`, `chinese`, ...), printed as declared |
| `prefer` | the tags the user wants this lane picked for first |
| `data` | the most that may be sent: `public`, `text` or `code`. Optional; when absent the Lanes line says `data:unset` and nothing is blocked |
| `price` | free-form object; built-ins use `{"model": "subscription"}`; the plan and price from `subscriptions` are folded in |
| `meter` | `{"type": ...}` with `none`, `builtin` (+ `collector`), `local-file`, `balance-endpoint` or `usage-endpoint`; an optional `health_url` adds one GET-status fact. See Meters below |
| `key_ref` | top level of the lane record (not inside `invoke`); where the key lives: `keychain:<name>` or `env:<VAR>`; never the key itself, never printed |
| `invoke` | how to call it; built-ins point here (`see references/providers.md`) |
| `notes` | free text for the model; never printed in the checklist |

The checklist prints one `Lanes` line (enabled lanes only: id, tags, `prefer:`, `data:`) before the `Quota` line. For `api-key` and `relay` lanes it adds one fact per lane: "<id> is a third-party service: sending content to it carries a data-leak risk." That is a reminder, not a gate. `web-only` lanes cannot be called; give the user a paste-ready prompt. The Quota line shows each lane's meter facts, for example `no meter (declared plan only)`.

Example:

```json
"lane_registry": {
  "glm": {"kind": "api-key", "tags": ["cheap", "chinese"], "prefer": ["chinese"], "data": "text",
          "key_ref": "keychain:glm-api", "meter": {"type": "none"},
          "invoke": {"api": "openai-chat", "base_url": "https://example.invalid/v1", "model": "glm-x"}},
  "qwen-local": {"kind": "local", "tags": ["cheap"], "data": "code",
                 "meter": {"type": "none", "health_url": "http://127.0.0.1:11434/api/tags"}}
}
```

### Meters

A lane's `meter` says where its balance or usage can be read. The program reads one number (or a used/total pair), prints it as a fact and judges nothing.

| `meter.type` | Needs | Fact it produces |
|---|---|---|
| `none` | nothing | `no meter (declared plan only)` |
| `balance-endpoint` | `preset` or `url`, plus `value_path` | `balance 12.40 CNY` |
| `usage-endpoint` | `preset` or `url`, plus `value_path` and `total_path` | `used 3.20 of 10.00 USD` |
| `local-file` | `path` to a JSON file, plus `value_path` | the same two strings, read from the file |

Endpoint meters make one `GET` with `Authorization: Bearer <key>` (key from the lane's `key_ref`, 10 s timeout, no retry, redirects not followed). Fields: `url`, `value_path`, `total_path`, `currency_path` (dotted, a number segment indexes a list), `currency` (a fixed code when the response has none), `kind` (`balance` or `used-total`; a null total prints `used <n> USD (no cap)`; defaults to the type's usual one). Numbers print with two decimals; a numeric string is accepted. Fields written on the meter win over the preset's. `lanes.py --validate` requires `preset` or `url` for the endpoint types and `path` for `local-file`, and nothing more.

Failures print as facts, never as a guess: `unknown (HTTP 401)` (with at most 80 characters of the response, key and Bearer tokens replaced by `***`), `unknown (key not found: keychain <name>)` / `env <VAR>`, `unknown (unexpected response)` when the path is missing or not a number, `unknown (unreachable (...))`, `unknown (file not found)`. The key is never printed, cached or logged.

Presets are in `assets/meter-presets.json`: `deepseek`, `openrouter`, `kimi` (China site, static currency CNY), and note-only `new-api` / `one-api` (two calls needed; no collector in v1, shown as `unknown (preset has no collector)`). `deepseek`, `openrouter` and `kimi` carry `"verified": "docs"` and `"live": true`: the endpoints and field names were read from the official documentation (DeepSeek `GET /user/balance`; OpenRouter `GET /api/v1/key`, fields `data.usage` and `data.limit`; Kimi `GET https://api.moonshot.cn/v1/users/me/balance`, field `data.available_balance`) and a real call with a user key succeeded on 2026-10-14. "live" means a real call succeeded on that date; it does not mean every field of every response was checked. When OpenRouter reports `limit: null` (no cap) the fact is `used 3.20 USD (no cap)`. `new-api` / `one-api` stay `"verified": false` (note only). With your own key, set locally and never pasted into chat or a file:

```
read -s KEY && export KEY      # then
curl -s -H "Authorization: Bearer $KEY" https://api.deepseek.com/user/balance
```

Compare the JSON with the preset's `value_path` / `total_path` / `currency_path`; if they match, the preset works for you. If not, override the paths on the meter. Volcano Engine (Ark) needs AK/SK request signing and Zhipu has no public balance endpoint known to us, so both show `no meter` for now.

### Calling a registry lane

`scripts/invoke.py` sends one prompt to a lane and prints the answer:

```
python3 scripts/invoke.py --lane <id> --prompt-file <path> [--system-file <path>] [--model <m>] [--max-tokens <n>] [--timeout <s>] [--contains public|text|code]
```

`python3 scripts/invoke.py --lane <id> --list-models` is read-only: it GETs `{base_url}/models` with the lane's key (openai-chat lanes only) and prints the model ids, one per line, never the key. Pick a model for the task and pass it with `--model`; the lane's `invoke.model` stays the default. Exit codes are the same (3 on 401/403 or a missing key, 2 for a lane that is not openai-chat).

Write the brief to a scratchpad file first and pass only the path; never put the brief on the command line and never pass secrets. `invoke` in the lane record is one of: `{"api": "openai-chat" | "anthropic-messages", "base_url": ..., "model": ...}` (POST `{base_url}/chat/completions`, or `{base_url}/v1/messages`) or `{"cli": "<command with {prompt_file}>"}` (run as argv without a shell; without `{prompt_file}` the prompt goes on stdin). `key_ref` sits at the top level of the lane record, next to `invoke`, never inside it (example: `{"kind": "api-key", "key_ref": "keychain:kimi", "invoke": {"api": "openai-chat", "base_url": "https://api.moonshot.cn/v1", "model": "kimi-k2.6"}}`). A `key_ref` is required for an api lane except `kind: local`; `keychain:<name>` is read as service `<name>`, account `spick`. stdout is the answer only; stderr is one fact line (`spick-invoke: <id> <model> <in> in / <out> out tokens, <s>s`). `--contains` is a self-report: a lane whose declared `data` is lower gets one warning line and the call proceeds. Exit codes: 0 ok, 2 usage error or unknown lane, 3 web-only lane or missing key or auth 401/403, 4 quota or rate 402/429, 5 anything else. No retries, no streaming. Step 6 checks the answer as usual.

Reasoning models (deepseek-flash, kimi-k2.6) spend output tokens on reasoning before the answer, so a small `--max-tokens` (for example 20) returns an empty answer. Use 400 or more even for a short answer.

### Verified providers

Called end to end with a user key on 2026-10-14:

- deepseek: chat, balance (2026-10-14)
- openrouter: chat, balance (2026-10-14)
- kimi (China site, api.moonshot.cn): chat, balance (2026-10-14)

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
