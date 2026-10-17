修复了 `textwrap2/wrap.py`：显示宽度现在按字符计算（东亚宽字符和全角字符占两格，组合用字符和格式字符不占格），超长单词也按显示宽度切分。我自己重跑了 `/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest`，结果 3 passed，0 failed。tests 目录未改动。

[Model: Haiku 5.5 (medium) → coder Haiku 5.5 (medium)]