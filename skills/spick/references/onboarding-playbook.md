# Playbook: adding an outside AI

Read this when the user says "add my DeepSeek / Kimi / OpenRouter" or lists AI services they pay for. Follow the steps in order. Paths are relative to the skill directory (`skills/spick/`).

## Rules

- Never write a key into any file. Never put a key on a command line.
- Never hand-write JSON for `spick.json`; use `scripts/add_lane.py`. It backs up `spick.json` to `spick.json.bak` before every write.
- Never write a `base_url` or a model id from memory.

## Preconditions

1. Check that `scripts/invoke.py`, `scripts/lanes.py` and `scripts/add_lane.py` exist.
2. Check that `spick.json` exists in `$CLAUDE_CONFIG_DIR` (default `~/.claude`). If it is missing, tell the user to run `spick setup` first. Create nothing else.

## Step 1. Ask

Send one message asking, for each service: its name; which site (for Kimi: China or international); plan or pay-per-use; what they want it for. Accept free text.

## Step 2. Look up

1. Find the service in `references/providers-catalog.md`. If present, take `base_url`, `api`, key name and meter preset from it.
2. If absent, ask the user for the provider's docs URL and read it with WebFetch. Extract: `base_url`, auth scheme, chat endpoint, model list endpoint, balance endpoint (if any). Write nothing from memory. With no balance endpoint, register without `--meter-preset`.

## Step 3. Key

Tell the user to run exactly this in their own terminal and type the key at the prompt:

    security add-generic-password -s spick-<name> -a spick -w

Never ask for the key in chat. If a key appears in chat, tell the user to revoke and regenerate it, and do not repeat it.

## Step 4. Register

Run `python3 scripts/add_lane.py --id <id> --name <display> --kind api-key|relay|local --base-url <url> --api openai-chat|anthropic-messages --model <model> [--key-name <name>] [--data public|text|code] [--tags a,b] [--prefer a,b] [--meter-preset <preset>] [--health-url <url>] [--max-tokens 400] [--notes "<text>"]`.

- `--id`: lowercase letters, digits, hyphens. `--key-name` only when it is not `spick-<id>`.
- `--health-url` is for `--kind local` only.
- Add `--dry-run` first if unsure; it prints the record and writes nothing.
- If no model is known yet, run steps 5 and 6 first with a model from the docs, then re-run with `--model`.

## Step 5. Test

Write `Reply with the single word OK.` to a scratchpad file. Run `python3 scripts/invoke.py --lane <id> --prompt-file <path>` (the lane default `max_tokens` of 400 applies). Report the exit code and one line.

## Step 6. Models (optional)

Run `python3 scripts/invoke.py --lane <id> --list-models`. Pick a model with the user. Record it by re-running `add_lane.py` with the same arguments and `--model <chosen>`.

## Step 7. Report

State what was registered, the test result, and that the Lanes line shows the lane from the next prompt.

## Privacy line the user must hear

Third-party services receive whatever is sent to them. spick prints a data-leak reminder on the Lanes line for api-key and relay lanes.

## Reasoning models

`deepseek-flash` and `kimi-k2.6` spend tokens on reasoning first. Keep `max_tokens` at 400 or more; an empty answer means `max_tokens` is too small.

## Troubleshooting

| Exit | Message | Do |
|---|---|---|
| 2 | usage error, unknown or disabled lane, no model | Check the lane id; pass `--model` or re-run `add_lane.py` with `--model` |
| 3 | key not found | Run step 3 again; the keychain name must match `key_ref` |
| 3 | web-only lane | It cannot be called; the user pastes the prompt into the site |
| 3 | auth failed (401/403) | Key wrong, or wrong site (Kimi China vs international); redo step 3 with the right key or `base_url` |
| 4 | quota or rate limit (402/429) | Tell the user; do not retry |
| 5 | any other error | Show the one-line message. Check whether `base_url` should end at `/v1` or not (compare with the catalogue or the docs). Reasoning model: `max_tokens` 400 or more. `empty answer`: `max_tokens` too small |
