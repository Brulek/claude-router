根因：LRU.put 在键已存在时只更新了 self.d[k] 的值，没有把 k 移到 self.order 的最近使用端（get 是对的，会 remove 再 append）。于是 put('a', 10) 之后 a 仍留在队首，容量满时被淘汰的是 a 而不是最久未用的 b，测试因此失败。

修复：在 lru.py 的 put 已存在键分支里，更新值后补上 self.order.remove(k) 和 self.order.append(k)。没有修改 test_lru.py。

验证：在工作目录用 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest -q 运行，结果 2 passed。改动文件：/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r3/haiku-spick/T4/run-2/work/lru.py

Kept: 根因判定是对一个小文件（22 行）的诊断，由本会话自己完成。
修复是两行改动，由 coder 子代理（Haiku，失败测试作为检查）完成，本会话复核了 pytest 结果。

[Model: Haiku 5.5 (medium) → coder Haiku (default) | Review: skipped]