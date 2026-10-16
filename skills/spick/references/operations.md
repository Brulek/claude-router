# Operations

The Router mod, adding an outside AI, and what to do when a lane fails. `SKILL.md` points here.

## Works with the Router mod (optional, recommended)

[alexei-led/claude-router](https://github.com/alexei-led/claude-router) is a Claude Code Mod that re-prices the **main conversation** itself: a local classifier (Ollama works) picks the model and effort for every turn, so the session is not stuck on Haiku and context is never lost to a handoff. This skill does not do that and does not try to; the two compose:

- Router mod: which Claude model and effort the main session runs on, turn by turn; subagents that pin a model (ours do) pass through untouched.
- This skill: the outside lanes (Gemini, Grok, Codex), the review triggers, the quota check, and the onboarding.

If `~/.claude/router.json` exists, assume the mod is active: skip the "I am Haiku, delegate everything heavy" reflex for pure reasoning and writing tasks (the mod will have raised the tier already), keep delegating coding to `coder` only when you want an isolated worker, and keep the label line honest about which model actually answered (the mod's band above the prompt shows it).

## Adding an outside AI

When the user says "add my DeepSeek", "spick setup" for an API service, or lists the AI services they have, follow `references/onboarding-playbook.md` step by step. Three rules hold throughout:

1. Ask first (one message: name, site, plan, purpose) and look the service up in `references/providers-catalog.md`; if it is not there, read the provider's docs with WebFetch before writing anything.
2. The key goes into the keychain through the user's own command; never into chat, a file or a command line.
3. Never hand-write JSON: register with `scripts/add_lane.py`.

## Failures

- **Auth failure** (401, "not authenticated", browser login prompt): do not retry. Move to the next lane and, at the end, tell the user the exact re-login command (`codex login`, `grok login`, `agy` opens a browser). Never try to log in on their behalf.
- **Other CLI failure**: run `<cli> --version`, compare with the version noted in `references/providers.md`; if it changed, re-read `--help`, update the notes, retry once.
- **Hung process**: Codex can hang silently; the kill and diagnosis recipe is in providers.md.
