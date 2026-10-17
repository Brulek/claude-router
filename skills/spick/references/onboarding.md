# First-run onboarding

Follow this when `<config>/spick.json` is missing (`<config>` is `$CLAUDE_CONFIG_DIR`, else `~/.claude`) or the user says `spick setup`. Keep it conversational; most users have never configured a CLI. Ask one question at a time and explain each step in a sentence.

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

## 2. Ask four things

1. **Which lanes to enable** among the detected ones (default: all that are logged in).
2. **Main-session model**: recommend Haiku and say why (it only triages and does chores). Offer Sonnet for users who want fewer handoffs. Mention that in the Claude desktop app they must also pick the model once in the composer's model menu; the app remembers its own choice.
3. **Default effort** for the main session (recommend Medium).
4. **Which plan each enabled lane is on** (Claude too), in the user's own words, for example "Max 20x, $200/mo" or "Pro Lite". Optional: a provider left out is simply not shown on the Quota line.

## 3. Install

Run `bash <skill-dir>/scripts/setup.sh --install --lanes <comma list> --model <haiku|sonnet|opus> --effort <level>` (add `--no-explore` to keep Claude Code's built-in Explore). It:

- stops with nothing written if `settings.json` or `spick.json` is not valid JSON (tell the user which, and stop),
- moves the round-1 state files (`spick-quota.json`, `spick-spend/`, `spick-gate.jsonl`, `spick-backup/`) into `~/.claude/spick/`, once,
- copies `~/.claude/CLAUDE.md`, `settings.json` and `spick.json` (those that exist) into `~/.claude/spick/backup/<YYYYmmdd-HHMMSS>/` with a `manifest.json` listing what this run wrote (agents, CLAUDE.md block, hook, `model`/`effortLevel` before and after); every run makes a new folder, and each file is written to a temp file then swapped in, so a symlinked file stays a link,
- copies `assets/agents/*.md` (`coder`, `planner`, `deep`, `Explore`) into `~/.claude/agents/` (existing files are kept unless `--force`),
- writes `<config>/spick.json` with the enabled lanes and the delegates' default `efforts`; last, once every step passed, `installed_version` with `installed` (agents written or kept, hook added, updated or kept, block replaced or appended); the summary lists kept agent files with the `--force` hint,
- inserts `assets/claude-md-snippet.md` into `~/.claude/CLAUDE.md` between `<!-- spick:start -->` / `<!-- spick:end -->` markers (re-running replaces the block, never duplicates it),
- registers a `UserPromptSubmit` hook (`scripts/triage-hook.sh`) in `~/.claude/settings.json` that prints a three-question triage checklist on every prompt (a spick hook already there at another path is updated to this one); small models follow a per-turn checklist far better than a once-per-session rule,
- sets `model` and `effortLevel` in `~/.claude/settings.json` only if `--model` / `--effort` were given, keeping every other key.

Every step is checked. A non-zero exit means setup stopped: it prints the failed step and what it had already changed (and the backup folder); tell the user exactly that, never "installed". Only a run that prints `done` succeeded.

Then record each plan from question 4, one call per provider: `python3 <skill-dir>/scripts/set_subscription.py --provider <claude|codex|gemini|grok> --plan "<plan>" [--price "<price>"]`. Never hand-edit `spick.json`.

Tell the user what was written, file by file.

Optional: if the user has other AI services (DeepSeek, Kimi, OpenRouter, a local Ollama, a relay), ask which ones and follow "Adding an outside AI" in `references/operations.md`: you write the `lane_registry` entries yourself, the user only stores each key in the keychain. Leaving it out is the normal case and changes nothing. The field list is in `references/providers.md` (Lane registry).

## 4. Finish

Say, in the user's language:

- New sessions pick up the agents and the CLAUDE.md block; this session will not.
- Desktop app users: pick Haiku once in the model menu.
- Three self-tests to try in a new session: a web lookup (should go to a lane tagged `search`, Gemini by default), a small code change (should route to `coder`), "review what you just changed" (should trigger Codex review if the triggers match, otherwise say "not reviewed").
- `spick doctor` re-checks tools; `spick quota` shows usage.
- `spick uninstall` (`setup.sh --uninstall [--purge] [--force]`) removes only what this install wrote and keeps anything the user changed since; `~/.claude/spick/` (turn records, backups) stays unless `--purge`.
