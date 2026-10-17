# Commands and files

What to do when the user types a spick phrase or a `/spick` command, and what each file of the skill is for. `SKILL.md` holds the routing rules; this file is looked up, not read every session.

## Commands the user may type

| Phrase | What to do |
|---|---|
| `spick setup` | Follow `references/onboarding.md` from the top; for API services follow "Adding an outside AI" in `references/operations.md` |
| `spick doctor` | `bash scripts/setup.sh --check` and report the table |
| `spick quota` | `bash scripts/quota.sh` and report |
| `spick uninstall` | `bash scripts/setup.sh --uninstall` (add `--purge` only if the user asks to drop `spick.json` and the state directory `~/.claude/spick/` too, `--force` only if they want hand-edited subagents removed) and report what it removed and kept, plus the two steps it leaves to the user. A non-zero exit lists what was already changed: report that list |
| `/spick` | (dashboard mod) opens the pane; with no UI it prints a one-paragraph status |
| `/spick on` / `force` / `off` | (dashboard mod) routing switch, remembered: `on` routes in a Haiku session only (a stronger model does the work itself), `force` routes on any model, `off` means do the work yourself, no Spick dispatch (`auto`, the old name of `on`, still works). A manual `/model` turns it off for the session |
| `/spick review on` / `off` | (dashboard mod) Codex review step, remembered; when off write `Review: off` in the label line |
| `/spick gate on` / `off` | (dashboard mod) the gate, remembered: a prompt whose Hint line named a verdict (judgement or review words; design words never), answered by the main session with nothing delegated, is sent back once at stop time (dispatch `deep`, or one `Kept:` line saying why it was a lookup); each firing and its outcome is part of the turn record (`~/.claude/spick/turns/<sessionId>.jsonl`) |
| `/spick guard on` / `off` | (dashboard mod) the guard, remembered: while routing is in force, the main session's own edit of a second distinct source file in a turn is refused (hand the change to `coder`; a tool-level soft bound, Bash writes are not caught), and a turn in which source was edited (a subagent's edits included) and no passing check ran after the last edit is sent back once at stop time (run the project's check, hand the user a `/goal` line, or one `Unchecked:` line saying why there is none); `/spick guard off` is the escape hatch |
| `/spick lane <id> on` / `off` | (dashboard mod) one lane (a built-in or a registered id): writes `enabled` through `scripts/set_lane.py`, so it persists in `spick.json`; an off lane is left out |
| `/spick lane <id> <field> <value>` / `/spick lane <id>` | (dashboard mod) changes one field through `scripts/set_lane.py` (any field; secrets and unknown ids refused) / shows the lane's record. The pane's lanes page (`l`) does the same |
| `/spick hide` / `show` | (dashboard mod) band visibility, this session only |
| `/spick quota` | (dashboard mod) refreshes quota now and prints the meters |
| `/spick spend` | (dashboard mod) prints `scripts/spend.py --days 7`: the last seven days' cost by lane, from the turn records in `~/.claude/spick/turns/` (and the round-1 spend files, for old sessions) |
| `/spick audit` | (dashboard mod) prints `scripts/audit.py --days 7`: what ran for each hint kind, gate firings and outcomes, edits without a passing check, cost by lane and kind, the longest sessions by context size |

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
- `scripts/triage_hint.py` - the Hint line: the keywords of a prompt and the default route they imply (`--stdin-json` from the hook, `--text` by hand); keywords, negations and phrases in `assets/rules.json`, twin in the dashboard mod's `hint.ts`.
- `assets/rules.json` - the routing policy (kinds, efforts, hint keywords, checklist text, overhead budget); `scripts/render_rules.py` renders `assets/checklist.txt`, the mod's `checklist.ts`/`hint.ts` blocks and the tables in SKILL.md and the snippet (`--check` fails on drift).
- `scripts/paths.py` - the one path rule: the config dir is `$CLAUDE_CONFIG_DIR` or `~/.claude`; state lives in `<config>/spick/` (`quota.json`, `quota.lock`, `turns/<sessionId>.jsonl`, `mod-active/<sessionId>`, `backup/`, and the round-1 `spick-spend/` and `spick-gate.jsonl` moved there); `python3 scripts/paths.py <name>` prints one path, `--migrate` moves the round-1 files.
- `scripts/quota.sh` / `scripts/quota.py` - quota collector and cache (`<state>/quota.json`, carrying `registry` and the enabled `lanes`). `scripts/setup.sh` - detection, install (`--no-explore` skips the Explore agent), uninstall and backup: it validates `settings.json` and `spick.json` first, copies CLAUDE.md, settings.json and spick.json into `<state>/backup/<timestamp>/` with a `manifest.json`, checks every step, exits 1 with the list of what it already changed when one fails, and says `done` only when all passed. It writes `installed_version` (from `assets/VERSION`) and `efforts` into spick.json.
- `scripts/spend.py` / `scripts/audit.py` - what the sessions cost and what ran, from the turn records the dashboard mod writes to `<state>/turns/` (`--days N`; spend also `--by lane|day|session`, `--json`). No mod, no records.
- `assets/agents/*.md` - the four subagent definitions (`coder`, `planner`, `deep`, `Explore`). `assets/claude-md-snippet.md` - the always-on cheat sheet installed into `~/.claude/CLAUDE.md`. `assets/VERSION` - the skill's version; the hook nudges when spick.json's `installed_version` differs.
