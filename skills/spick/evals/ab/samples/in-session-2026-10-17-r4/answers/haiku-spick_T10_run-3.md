修复已完成：在 textwrap2/wrap.py 中按显示宽度计算换行（东亚宽字符和全角字符计两格，组合用字符计零格），超长单词也按格数切分。tests/ 未修改。

在 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r4/haiku-spick/T10/run-3/work 下用 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest 复核：3 passed（修复前为 2 failed, 1 passed）。

[Model: Haiku 5.5 (medium) → coder Haiku 5.5 (default effort) | Review: skipped]