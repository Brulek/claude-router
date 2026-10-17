根因:put() 覆盖已存在的 key 时只更新了值,没有更新 self.order 里的访问顺序,该 key 仍停留在旧位置,被当作最久未使用而在后续淘汰时误删(test_put_existing_refreshes_recency 中 'b' 本应被淘汰,却仍能取到 2)。

修复:在 lru.py 的 put() 覆盖分支中,赋值 self.d[k] = v 之后新增 self.order.remove(k) 和 self.order.append(k),使覆盖写入同样刷新最近使用顺序。test_lru.py 未修改。

验证:在 work 目录用 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest 运行,2 passed。我复核了 lru.py 内容与测试结果。

[Model: Haiku 5.5 (medium) → coder Haiku 5.5 (default effort) | Review: skipped]