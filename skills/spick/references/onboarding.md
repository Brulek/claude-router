# First-run onboarding

Follow this when `~/.claude/spick.json` is missing or the user says `spick setup`. Keep it conversational; most users have never configured a CLI. Ask one question at a time and explain each step in a sentence.

## 1. Detect

Run `bash <skill-dir>/scripts/setup.sh --check`. It prints a table like:

```
tool     installed  logged_in  version
claude   yes        yes        2.1.296
codex    yes        yes        0.162.1
grok     yes        no         1.0.52
agy      yes        yes        (antigravity)
node     yes        -          v22.x
python3  yes        -          3.12
```

Show it to the user. For anything missing, give the install or login command and say that lane will be skipped until it works:

- Codex: `npm i -g @openai/codex` then `codex login`
- Grok: install from x.ai (Grok Build), then `grok login`
- Gemini: `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy` once to sign in with Google
- Optional Claude Code plugins: `codex-image` (image generation), `grok` (X search commands)

Nothing is required except Claude itself. With no outside CLI installed the skill still does Claude-internal tiering.

## 2. Ask three things

1. **Which lanes to enable** among the detected ones (default: all that are logged in).
2. **Main-session model**: recommend Haiku and say why (it only triages and does chores). Offer Sonnet for users who want fewer handoffs. Mention that in the Claude desktop app they must also pick the model once in the composer's model menu; the app remembers its own choice.
3. **Default effort** for the main session (recommend Medium).

## 3. Install

Run `bash <skill-dir>/scripts/setup.sh --install --lanes <comma list> --model <haiku|sonnet|opus> --effort <level>`. It:

- copies `assets/agents/*.md` into `~/.claude/agents/` (existing files are kept unless `--force`),
- writes `~/.claude/spick.json` with the enabled lanes and thresholds,
- inserts `assets/claude-md-snippet.md` into `~/.claude/CLAUDE.md` between `<!-- spick:start -->` / `<!-- spick:end -->` markers (re-running replaces the block, never duplicates it),
- registers a `UserPromptSubmit` hook (`scripts/triage-hook.sh`) in `~/.claude/settings.json` that prints a three-question triage checklist on every prompt; small models follow a per-turn checklist far better than a once-per-session rule,
- sets `model` and `effortLevel` in `~/.claude/settings.json` only if `--model` / `--effort` were given, keeping every other key.

Tell the user what was written, file by file.

Optional: the user may declare extra lanes (other APIs, relays, local models) or override a built-in one by writing `lane_registry` into `~/.claude/spick.json` by hand; setup does not write it. Leaving it out is the normal case and changes nothing. The field list is in `references/providers.md` (Lane registry); `python3 <skill-dir>/scripts/lanes.py --validate` checks it.

## 4. Finish

Say, in the user's language:

- New sessions pick up the agents and the CLAUDE.md block; this session will not.
- Desktop app users: pick Haiku once in the model menu.
- Three self-tests to try in a new session: a web lookup (should go to a lane tagged `search`, Gemini by default), a small code change (should route to `coder`), "review what you just changed" (should trigger Codex review if the triggers match, otherwise say "not reviewed").
- `spick doctor` re-checks tools; `spick quota` shows usage.
