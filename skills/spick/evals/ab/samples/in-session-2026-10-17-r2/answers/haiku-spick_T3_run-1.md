The fix is in `textstat/stats.py`, and the full suite passes: `4 passed` under the venv interpreter. No file under `tests/` changed.

**What changed:** `median()` returned the upper middle element for every input, which is wrong for even-length lists. I added an even-length branch that returns the average of the two middle elements. The odd-length path is unchanged.

The fix was made by the `coder` subagent. I re-ran pytest with `/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest` and confirmed the result. A `find` for files newer than `stats.py` under `tests/` returned nothing, so the test files were not touched.

Kept: a one-file bug fix dispatched to `coder` (hint word 修复 with nothing left to decide), so the main session did not edit source itself.

[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high)]