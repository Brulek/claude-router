已实现标签功能，改动的文件是 shelf/models.py、shelf/store.py、shelf/report.py 三个文件，tests 目录未动。

实现要点：Item 新增 tags 字段（default_factory=list，实例不共享）；Store.add_item(name, qty, price, tags=None) 保存传入列表的副本；Store.items_with_tag(tag) 精确匹配、区分大小写，按名称升序返回；report 中带标签的条目在行尾追加 " [标签1,标签2]"（字母升序、逗号分隔、无空格），无标签的条目格式不变。

验证：在工作目录用 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest 运行，结果 5 passed（我本人复跑确认过）。coder 另做了一段内联脚本检查默认列表不共享、add_item 的副本语义、items_with_tag 的排序与大小写、报表后缀格式，均通过。

[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high)]