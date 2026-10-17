已在 shelf 包中加入标签功能，改动文件为 shelf/models.py、shelf/store.py、shelf/report.py（tests 目录未改动）。

验证：在工作目录运行 `/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/venv/bin/python -m pytest`，结果 5 passed，0 failed。我亲自复核了三个文件的内容，与需求一致：Item.tags 用 default_factory 保证每实例独立；add_item(tags=None) 保存副本；items_with_tag 精确匹配并按名称升序；report 带标签行追加 ' [a,b]'（排序、无空格），无标签行不变。

注意：coder 没有补充针对副本语义和默认列表独立性的新测试，目前只靠已有测试通过；这两点是我依据代码阅读确认的，未用测试直接验证。

[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (default effort) | Review: skipped]