根因：LRU.put 在 key 已存在时只更新了 self.d[k] 的值就直接返回，没有把 k 移到 self.order 的最近使用端，所以它保留了旧的淘汰位置。test_put_existing_refreshes_recency 因此在 put('a', 10) 之后仍把 'b' 当作最久未用而驱逐了 'a'，实际 'a' 才是最久未用的 key 之外的最新项，断言失败。

修复：只改了 lru.py 的 put 存在分支，增加了 self.order.remove(k) 和 self.order.append(k)。test_lru.py 未改动。

验证：在 work 目录用 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest -q 运行，结果 2 passed。
修改文件：/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/haiku-spick/T4/run-2/work/lru.py

Kept: 根因诊断由主会话在小文件（两个文件，约 30 行）上直接完成；代码修改委派给 coder。

[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (medium)]