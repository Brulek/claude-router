把 textwrap2/wrap.py 改为按显示宽度计算：东亚宽字符和全角字符计 2 格，组合用字符（Mn/Me/Cf）计 0 格；超长单词按格数切分，且不会切断一个字符。

修改文件：仅 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r4/haiku-spick/T10/run-1/work/textwrap2/wrap.py（新增 `_char_width`、`_split_by_width`，`display_width` 与 `wrap` 改用它们）。tests/ 未改动，__init__.py 未改动。

我本机复核：`/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest` 结果 3 passed。

[Model: Haiku 5.5 (medium) → coder Haiku 5.5 (medium)]