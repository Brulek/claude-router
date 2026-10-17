# Landscape: routing and triage tools for coding agents (2026-10-17)

What comparable tools do, what their authors measured, and the lessons spick v2 takes from them.
Sources: GitHub READMEs read on 2026-10-17, an X scan by Grok (grok-4.7, posts 2026-04-17 to 2026-10-17) and a
web scan by Gemini (appended at the end when it finished). Star counts and dollar figures are the posters' claims
unless marked verified.

## Comparable projects

| Project | Mechanism | Evidence it publishes | Lesson for spick |
|---|---|---|---|
| alexei-led/claude-router (1.14) | Mod rewrites `model`/`effort` on every `turn.step`; external classifier (Jev, Clef, OpenAI, Ollama) gives tier + activity; local policy adds vote hysteresis, a cache-write switching tax, failure escalation, context fit | Says plainly "no measured savings"; one old gateway replay (15.5% below always-Opus at list price) | A router that changes the main model carries cache and hysteresis machinery spick must not duplicate. spick's lever is different: delegation keeps the main cache warm |
| nobodyohm-web/claude-code-model-router (v2) | `UserPromptSubmit` hook scores the prompt against weighted regex rules (`rules.json`), optional one Haiku call when ambiguous; pinned-model subagents; `PreToolUse(Task)` ledger; `/router-stats` reads the ledger | Ledger counts are exact; "saved" is an estimate from per-tier token averages; bats tests of the classifier against a labelled corpus | Rules as data with a labelled test corpus; a ledger of who actually ran; a 15-line always-on stub (overhead budget) |
| okazaky/claude-code-model-router | Skill + YAML routing table (the table is the single source, the skill executes it); default `no_dispatch`; fail-closed PII guard before guarded providers; independent verification by a different model lineage; one JSON line per dispatch with `outcome` | Adversarial review of the guard, gaps listed | "Not dispatching is the default" because delegation has overhead; the dispatch log reviewed weekly adjusts the table; a delegate's "done" is a claim |
| nedjamez/claude-code-model-router | `PreToolUse` hook on `Task`/`Agent` sets `model` via `updatedInput` when unset ("a floor, not a cage") | Unit tests | A hook can set a subagent's model/effort deterministically; the model need not remember |
| ToolMonsters/claude-code-routing (Spotify rebuild) | Cheap model writes boilerplate from a spec; bulk-read summaries; a hook blocks reads over 350 lines | Four tasks, one run each, costs including the Haiku calls, the unflattering cells kept: reading-side routing barely moved the bill, boilerplate writing paid, judgement tasks got worse and slower | Context isolation is the lever, not the price per token; measure and publish the losses |
| musistudio/claude-code-router (37k stars) | Local gateway and control plane across providers | Request logs, resolved routes | Different category (provider switching), not a difficulty router |
| ccusage (19k stars) | Reads local Claude Code logs; cost per day/session | Users' breakdowns: one stuck session, cache writes and repeated file discovery dominate bills | Measure before routing; a per-turn record is the product |

## What practitioners on X report (Grok scan, 2026-04 to 2026-10)

- A viral "Opus thinks, Haiku swarms" stack cost $1.37 on one bug fix; plain Sonnet 5.5 $1.14; Haiku 5.5 alone $0.39 (@Skaly__Bull, 12 Oct). Tiered stacks can cost more than staying on one mid model.
- Escalate on a check outside the model (a test failed twice, a linter), not on the small model's confidence; an uncalibrated cheap model either escalates constantly or stays silent on the calls it is wrong about (@viyaappsdev, @KissonL, 16 Oct).
- The built-in Explore subagent follows the main model: an Opus session greps on Opus. A project agent named `Explore` with `model: haiku` and read-only tools replaces it (several posts, 11-13 Oct).
- Haiku 5.5 bills 5x above 100k input tokens: do not hand it the repo (@simond_dev, 13 Oct).
- "The Handoff Tax" (paper summarised by @al3rez, 16 Oct): escalating with the weak model's full trajectory recovered under half the quality gap and added cost; cutting the weak model's history improved escalation. The next model should receive workspace state, the original task, verified findings, failed approaches, remaining work and test evidence.
- Switching models inside one warm session resets the cache; routers that look only at the next prompt switch at the wrong time (@aakashgupta, @_TrojanMorse).
- 4 of 6 "MCP routers" used more tokens than no router; 2 did not finish, against claims of 85-99% savings (@progrrammer, 16 Oct).
- A router only helps when the model pool is diverse for the task (tinyrouter thread, 103k views).
- Long sessions are where the money goes: 61% of one user's weekly usage was a session left open three days; the practical advice is `/clear` between tasks and a status line showing context size.

## Ten principles for spick v2

1. The product is the per-turn record (who ran, what it cost, whether it was checked); routing rules are hypotheses that the record tests.
2. Not dispatching is the default for small, self-contained work; delegation has a handoff cost that must be paid back.
3. Delegate for context isolation first, price per token second: the brief is a handoff packet, never the main session's trail.
4. Rules are data with a labelled corpus; every rendering (hook, mod, skill, snippet) is generated from one source.
5. Enforce at the cheapest moment, on facts: refuse the edit before it happens, escalate on a failed check, not on a keyword.
6. The small main session must stay small: an overhead budget for the always-on text and a context-size warning before Haiku's price step.
7. A delegate's "done" is a claim: the deliverable carries evidence (checks run, files changed, limits), and the main session verifies against the real artifact.
8. Keep the main cache warm: never switch the main model mid-session; subagents and CLIs run in their own contexts.
9. Cheap wins that hold on any main model come first (Explore on Haiku, review by another lineage, quota facts).
10. Publish the unflattering cells: every benchmark reports cost, time and quality per arm, including the arms that lose.
