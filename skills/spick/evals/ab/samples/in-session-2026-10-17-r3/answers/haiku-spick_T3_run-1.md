修复了 textstat/stats.py 中 `median` 对偶数长度输入的错误：原来返回中间偏右的单个元素，现在改为返回两个中间值的平均值。

改动文件：/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r3/haiku-spick/T3/run-1/work/textstat/stats.py

主会话已复核：在该目录用 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest 运行，结果 4 passed。tests 目录未改动。

[Model: Haiku 5.5 (medium) → coder Haiku 5.5 (medium)]