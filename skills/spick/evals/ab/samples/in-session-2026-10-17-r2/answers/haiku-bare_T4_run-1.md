根因：LRU.put 在键已存在时只更新了值，没有把该键移到 order 的最近使用端，所以 put('a', 10) 之后 'a' 仍被当作最久未用，下一次淘汰时错误地驱逐了 'a'（测试中实际是 'b' 应被淘汰，但 'b' 仍留在缓存中，断言 get('b') is None 失败）。修复：在 lru.py 的 put 已存在分支中，更新值后执行 self.order.remove(k) 和 self.order.append(k)，使写入同样刷新最近使用顺序。未修改测试文件。

Changed file: /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/haiku-bare/T4/run-1/work/lru.py

Verification (/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest):
```
collected 2 items

test_lru.py ..                                                           [100%]

============================== 2 passed in 0.01s ===============================
```