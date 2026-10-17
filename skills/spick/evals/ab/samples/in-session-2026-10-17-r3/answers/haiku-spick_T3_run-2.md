I changed `median` in `textstat/stats.py` so that even-length lists return the average of the two middle values instead of the upper one. `python3 -m pytest` now passes all 4 tests (verified by re-running it with the scratchpad venv). The `tests` directory is untouched; its file timestamps predate the fix.

Delegation: the bug went to a `coder` subagent on Haiku (medium). Its report matched my re-run, so no review was triggered.

Modified file: /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r3/haiku-spick/T3/run-2/work/textstat/stats.py

[Model: Haiku 5.5 (medium) → coder Haiku (medium) | Review: skipped]