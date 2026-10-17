# The verdicts switch: design

Status: implemented 2026-10-17 on `feat/verdicts-switch`. Input: `docs/reviews/2026-10-17-real-harness-ab.md`,
sections 5 and 6: the v2.1 size rule keeps a small verdict (T7) in the Haiku main session, which scores one judge
point below an Opus verdict under both judges, for $0.30 a verdict less. The rule stands as the default; this switch
makes the trade a per-session choice instead of a policy.

## 1. The switch

`/spick verdicts keep|deep`, remembered like routing, review, the gate and the guard (`$.store`, key
`spick:verdicts`; a malformed or missing value reads as the default). Default `keep`: nothing changes for a session
that never touches it. The switch acts only while routing is in force (the checklist and the gate already do nothing
otherwise). It is a dashboard-mod switch: the bash hook (`triage-hook.sh`, `assets/checklist.txt`) has no session
state and keeps printing the default text.

| value | the checklist's DEEP bullet | the gate on a judgement hint |
|---|---|---|
| `keep` (default) | small material -> you, with a `Kept:` line; large, high stakes, unsure -> `deep` | a `Kept:` line pre-empts the send-back |
| `deep` | every verdict -> `Agent(deep)`, small material too; a `Kept:` line does not excuse one | a `Kept:` line no longer pre-empts it; the send-back names `deep` as the one way out |

The switch is about the `verdict` kind (judgement words). A review hint (the `review` kind) already routes to the
review lane or `deep` with no size rule, and its `Kept:` escape (a false positive: "review" in a prompt that was a
lookup) is unchanged under either value.

## 2. One source: rules.json

Nothing is hand-edited into the rendered copies. `assets/rules.json` gains:

- on the bullets `DEEP` and `YOU`, an optional `verdicts_deep` key holding the bullet's text while the switch is
  `deep` (same rules as `text`: one line, starting with `   - `);
- a top-level `phrases_verdicts_deep` map, a subset of the hint kinds (`judgement` only today), with the Hint phrase
  used while the switch is `deep` (must hold `{t}`).

`render_rules.py` validates both and renders, next to the existing constants: `LANE_BULLET_DEEP_VERDICTS_DEEP`,
`LANE_BULLET_YOU_VERDICTS_DEEP`, one `LANE_BULLETS_<VARIANT>_VERDICTS_DEEP` array per lane variant (checklist.ts),
and `PHRASE_TEMPLATES_VERDICTS_DEEP` (hint.ts). `checklist.txt`, SKILL.md's table and the CLAUDE.md block are
unchanged: they describe the default. `test_rules.py` checks the schema, `--check`, and the 14-line / 320-word
budget for the `deep` variants as well as the `keep` ones (the `deep` bullets are shorter).

## 3. The mod

- `types`: `Verdicts = 'keep' | 'deep'`; `Controls.verdicts`. `DEFAULT_CONTROLS.verdicts = 'keep'`; `parseVerdicts`;
  `loadControls` reads `spick:verdicts`, `setControls` writes it.
- `parseSpick`: `verdicts keep|deep` -> `{ kind: 'verdicts', value }`; anything else under `verdicts` is usage.
  `ARGUMENT_HINT` lists it between `review` and `gate`.
- `laneBullets(variant, verdicts)` picks the `_VERDICTS_DEEP` array under `deep`; `checklist()` passes
  `c.verdicts`. `lineOf(hints, verdicts)` uses the `deep` phrase for the kinds `phrases_verdicts_deep` names.
- `gateFiring(hints, runs, { kept, verdictsDeep })`: a hint is missing when its role did not complete and the
  `Kept:` line does not excuse it; under `verdictsDeep` a `Kept:` line excuses every kind but `judgement`. When the
  strict case fires, the text names the switch and offers only `Agent(deep)`. register.tsx no longer short-circuits
  on `KEPT_RE` before calling the gate; everything else at stop time (substantive turn, one send-back per turn,
  the record's `gateEvents` and `kept` line) is as before.
- The pane: a `Verdicts` row (`keep` / `deep` radio, hotkey `j`, after Review) with a one-line note saying what the
  value does. `/spick` with no UI lists `verdicts <value>` after `review`. The band is unchanged.

## 4. Out of scope

The turn record does not carry the switch (its `kept` line and `gateEvents` already show what happened); the bash
hook stays on the default; no A/B run for the switch (the trade is measured in the review it answers).
