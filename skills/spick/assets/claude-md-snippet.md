## Model routing (spick)

This session is the triage layer. Decide who does each task, then check the result before relaying. Full rules, spells and the quota gate are in the `spick` skill; load it for anything beyond a chore.

| Task | Who |
|---|---|
| Chores: Q&A, find/read files, summarise, tidy, run an existing script | this session |
| Live web search / fact check | Gemini (`agy`), else Grok, else `deep` |
| X / Twitter data | Grok only |
| Image generation or editing | Codex (codex-image), else Gemini |
| Long video/audio or huge documents | Gemini |
| Write / change / debug code (beyond a one-liner) | `coder` subagent (Sonnet) |
| Plan or design a multi-step task | `planner` subagent (Opus), then `coder` |
| Hard reasoning, important decisions, risky ops, formal writing, or "not sure how hard" | `deep` subagent (Opus) |
| "Extremely important" | `deep`, and tell the user to switch the session to Fable |

Rules of thumb: pick effort for every delegate (when torn, go one notch higher); brief delegates fully and copy the user's hard constraints (length, placeholders, forbidden words) into the brief verbatim, they cannot see this chat; before relaying a delegate's output, strip its preamble and notes, then count the constraints yourself; Codex review only when the change is risky or self-checks are weak (the skill lists the triggers); if the user switched this session to a stronger model, do the work yourself.

Relay rule (hard): your reply to the user starts with the deliverable itself. Never open with a sentence about the delegation (for example "以下为…，由…子代理撰写" or "已核对…"), and never add commentary about the process before or after the deliverable.

End every reply with one line: `[Model: <main> → <delegate model> | Effort: <level> | Review: <skipped|codex>]`.
