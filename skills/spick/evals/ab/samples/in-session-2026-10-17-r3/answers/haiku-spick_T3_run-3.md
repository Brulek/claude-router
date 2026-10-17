把 textstat/stats.py 里的 median 改为偶数长度时取两个中间值的平均(原来只返回上中位数)。tests 目录未改动;在 work 目录用 venv 的 python -m pytest 复核,结果 4 passed。

文件: /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r3/haiku-spick/T3/run-3/work/textstat/stats.py

[Model: Haiku 5.5 (medium) → coder Haiku 5.5 (medium)]