# Providers catalogue

Only services whose chat call (and balance call, where there is a preset) was actually made are listed. Write `base_url` from this table; never from memory. `key` is the keychain service name (account `spick`); `meter` is the preset to put in `meter.preset` with the `meter.type` shown. Model ids are not stored here: use `invoke.py --lane <id> --list-models` or ask the user.

| Service | base_url | api | key | meter | last checked | what was tested |
|---|---|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com` | openai-chat | `spick-deepseek` | `balance-endpoint`, preset `deepseek` | 2026-10-14 | chat and balance, live |
| Kimi, China site | `https://api.moonshot.cn/v1` | openai-chat | `spick-kimi` | `balance-endpoint`, preset `kimi` | 2026-10-14 | chat and balance, live |
| Kimi, international site | `https://api.moonshot.ai/v1` | openai-chat | `spick-kimi` | none (the `kimi` preset is the China endpoint) | not checked | NOT live-checked: neither chat nor balance |
| OpenRouter | `https://openrouter.ai/api/v1` | openai-chat | `spick-openrouter` | `usage-endpoint`, preset `openrouter` | 2026-10-14 | chat and key/balance, live |
| Ollama (local) | `http://127.0.0.1:11434/v1` | openai-chat | none (`kind: local`) | `none` with `health_url` `http://127.0.0.1:11434/api/tags` | 2026-10-14 | chat with a local model, live; health_url not separately recorded |

Notes:

- DeepSeek and Kimi models are reasoning models: use `max_tokens` 400 or more or the answer comes back empty.
- OpenRouter has hundreds of models. The user names the one they want; list them with `invoke.py --lane openrouter --list-models` (GET `/api/v1/models`).
- Ollama installed models: `--list-models` works on the local lane too (no key sent).

## Not in the catalogue

GLM (Zhipu), Doubao (Volcano Engine Ark), relay stations (new-api / one-api) and anything else: not in catalogue, read the provider's docs before writing an entry. Do not write their URLs or model ids from memory. Ask the user for the docs URL and read it first (see "Adding an outside AI" in `SKILL.md`). Volcano Engine needs AK/SK signing for its balance and Zhipu has no known public balance endpoint, so use `meter` type `none` for them.
