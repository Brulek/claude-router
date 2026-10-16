# Commands and files

What to do when the user types a spick phrase or a `/spick` command, and what each file of the skill is for. `SKILL.md` holds the routing rules; this file is looked up, not read every session.

## Commands the user may type

| Phrase | What to do |
|---|---|
| `spick setup` | Follow `references/onboarding.md` from the top; for API services follow "Adding an outside AI" in `references/operations.md` |
| `spick doctor` | `bash scripts/setup.sh --check` and report the table |
| `spick quota` | `bash scripts/quota.sh` and report |
| `spick uninstall` | `bash scripts/setup.sh --uninstall` (add `--purge` only if the user asks to drop `spick.json` too, `--force` only if they want hand-edited subagents removed) and report what it removed and kept, plus the two steps it leaves to the user |
| `/spick` | (dashboard mod) opens the pane; with no UI it prints a one-paragraph status |
| `/spick on` / `force` / `off` | (dashboard mod) routing switch, remembered: `on` routes in a Haiku session only (a stronger model does the work itself), `force` routes on any model, `off` means do the work yourself, no Spick dispatch (`auto`, the old name of `on`, still works). A manual `/model` turns it off for the session |
| `/spick review on` / `off` | (dashboard mod) Codex review step, remembered; when off write `Review: off` in the label line |
| `/spick gate on` / `off` | (dashboard mod) the gate, remembered: a prompt whose Hint line named a verdict (judgement or review words; design words never), answered by the main session with nothing delegated, is sent back once at stop time (dispatch `deep`, or one `Kept:` line saying why it was a lookup); each firing and its outcome is a line in `~/.claude/spick-gate.jsonl` |
| `/spick guard on` / `off` | (dashboard mod) the guard, remembered: while routing is in force, the main session's own edit of a fourth distinct source file in a turn is refused (hand the change to `coder`), and a turn in which source was edited (a subagent's edits included) and no check ran is sent back once at stop time (run the project's check, hand the user a `/goal` line, or one `Unchecked:` line saying why there is none); `/spick guard off` is the escape hatch |
| `/spick lane <id> on` / `off` | (dashboard mod) one lane (a built-in or a registered id): writes `enabled` through `scripts/set_lane.py`, so it persists in `spick.json`; an off lane is left out |
| `/spick lane <id> <field> <value>` / `/spick lane <id>` | (dashboard mod) changes one field through `scripts/set_lane.py` (any field; secrets and unknown ids refused) / shows the lane's record. The pane's lanes page (`l`) does the same |
| `/spick hide` / `show` | (dashboard mod) band visibility, this session only |
| `/spick quota` | (dashboard mod) refreshes quota now and prints the meters |
| `/spick spend` | (dashboard mod) prints `scripts/spend.py --days 7`: the last seven days' cost by lane, from `~/.claude/spick-spend/` |

## Files in this skill

- `references/providers.md` - per-provider spells, flags, model ids, quota sources, known pitfalls. Read before the first external call.
- `references/onboarding.md` - first-run flow.
- `references/commands.md` - this file. `references/operations.md` - the Router mod, adding an outside AI, failures.
- `references/onboarding-playbook.md` - the steps for adding an outside AI (ask, look up, key, register, test, report).
- `references/providers-catalog.md` - checked `base_url`, key name and meter preset per API service. Read it before writing a registry entry.
- `scripts/add_lane.py` - registers one lane in `spick.json` (backup, validation, `--dry-run`).
- `scripts/set_lane.py` - changes one field of one lane (`--list` shows tags, data, enabled, notes; `--field enabled --value yes|no` is the one on/off switch; backup, validation, `--dry-run`). The user may change any field; never hand-edit `spick.json`.
- `scripts/set_subscription.py` - records which plan the user is on per built-in provider (`subscriptions`, what the Quota line shows): `--provider P --plan "<text>" [--price "<text>"]`, `--remove`, `--list`; backup, validation, `--dry-run`.
- `scripts/invoke.py` - calls a registered lane (`--list-models`).
- `scripts/lanes.py` - lane registry (`--validate`, `--line`, `--json`); built-ins in `assets/builtin-lanes.json`.
- `scripts/triage_hint.py` - the Hint line: the keywords of a prompt and the default route they imply (`--stdin-json` from the hook, `--text` by hand); table in `assets/triage-hints.json`, twin in the dashboard mod's `hint.ts`.
- `scripts/quota.sh` / `scripts/quota.py` - quota collector and cache (`~/.claude/spick-quota.json`). `scripts/setup.sh` - detection, install, uninstall and backup (every install or uninstall first copies CLAUDE.md, settings.json and spick.json into `~/.claude/spick-backup/<timestamp>/` with a `manifest.json`).
- `scripts/spend.py` - what the sessions cost, from the per-session files the dashboard mod writes to `~/.claude/spick-spend/` (`--days N`, `--by lane|day|session`, `--json`); a row per turn with usage and per outside CLI call (unpriced). No mod, no records.
- `assets/agents/*.md` - the three subagent definitions. `assets/claude-md-snippet.md` - the always-on cheat sheet installed into `~/.claude/CLAUDE.md`.
