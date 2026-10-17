根因:LRU.put 在 key 已存在时只更新了 self.d[k] 的值就直接返回,没有把 k 移到 self.order 的最近使用端,所以被覆盖的 key 仍停留在旧的淘汰位置,随后被错误地淘汰(test_put_existing_refreshes_recency 中 'b' 本应被淘汰却仍能取到 2)。

修复:在 lru.py 的 put 中 key 已存在的分支里,补上 `self.order.remove(k); self.order.append(k)`。只改了 lru.py,未动测试文件。

验证:在工作目录用 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest 运行,2 passed。

Kept: 根因判断为一处小改动的诊断,材料仅 22 行,由主会话自行完成;代码修改交给 coder。

[Model: Haiku 5.5 (medium) → coder Haiku (default effort) | Review: skipped]