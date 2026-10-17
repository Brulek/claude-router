根因：`LRU.put` 在键已存在时只更新了值，没有把该键移到 `order` 的最近使用端，于是 `a` 仍排在 `b` 前面，容量满时被当成最久未用淘汰（`test_put_existing_refreshes_recency` 中 `get('b')` 本应为 None 却返回 2）。修复：在 `lru.py` 的 `put` 已存在键分支中，更新值后执行 `self.order.remove(k)`、`self.order.append(k)`。未修改测试文件；`venv/bin/python -m pytest` 现为 2 passed。

Kept: 材料只有 `lru.py` 一个 22 行文件，属于单文件修复，由本会话直接完成，无需委派。

[Model: Haiku 5.5 | Effort: medium]