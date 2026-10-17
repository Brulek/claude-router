根因：`LRU.put` 在键已存在时只更新了 `self.d[k]` 的值就直接 `return`，没有把该键在 `self.order` 中移到最近使用的位置。因此对已有键的 put 不会刷新其访问顺序，之后淘汰时它仍被当作最旧条目，`test_put_existing_refreshes_recency` 因此失败。

修复：在 `lru.py` 的 `put` 的"键已存在"分支中，更新值之后、`return` 之前，加入 `self.order.remove(k)` 与 `self.order.append(k)`。未改动其他逻辑，也未修改 test_lru.py。

验证：在工作目录内用 `/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest` 运行，结果为 `2 passed`。（按要求使用 venv 的 python，未用系统的 `python3 -m pytest`。）

[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high)]