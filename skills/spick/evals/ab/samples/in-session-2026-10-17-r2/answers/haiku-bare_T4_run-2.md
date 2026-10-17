Done. Fixed lru.py; both tests pass.

Root cause: in LRU.put, when the key already exists, the value is updated but the key is not moved to the most-recent end of self.order. So after put('a', 10), 'a' still sat at the front and 'b' was evicted instead, which broke the recency rule.

Change in /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/haiku-bare/T4/run-2/work/lru.py: in the `if k in self.d:` branch of put, added `self.order.remove(k)` and `self.order.append(k)` before the return. The test file is unchanged.

Verification:
```
============================= test session starts ==============================
platform darwin -- Python 3.15.0, pytest-9.1.1, pluggy-1.7.0
rootdir: /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/haiku-bare/T4/run-2/work
collected 2 items

test_lru.py ..                                                           [100%]

============================== 2 passed in 0.01s ===============================
```