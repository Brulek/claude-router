已知缺陷（评审参考，由独立评审在该版本代码上复现）：
K1 检查误判：guard.ts:85 的 checkOf 把 `true || pytest`、`pytest; true`、`pytest | cat` 这类复合命令当作检查，而 register.tsx:888 只看整条 Bash 的退出状态；register.tsx:481 在 next(Edit) 之前就递增编辑计数，于是编辑尚未完成时跑的测试也被算作"编辑之后"（coversTurn:true）。
K2 完成状态可伪造：format.ts:81 只要引号参数含 review 就算 review 调用，register.tsx:896 以整条 Bash 成功为完成，所以 `codex exec --help "review"`、`true || codex exec "review"` 都生成 completed review；register.tsx:795 前台 deep 仅凭工具返回非空就记 completed。
K3 记账遗漏：register.tsx:781/849 只为主循环（!e.agentId）的 Agent/CLI 调用建 delegate 记录，嵌套委派不进 turn 记录；register.tsx:538/598 超时后删除索引，之后完成无法补写 late 行，用量丢失。
K4 冷缓存回退：register.tsx:72 从 quota 缓存读 lane 状态，缓存缺失返回 null，checklist.ts:87 把 null 当作"无 registry"，于是配置里已禁用的 Gemini/Grok/Codex 又被推荐。
K5 子代理的 turn.start 清空主回合状态：register.tsx 的 turn.start 处理器不检查 e.agentId，而引擎对子代理循环的每个事件都带 agentId；后台 planner/coder/deep 自己的第一回合开始时，主回合的 delegates、hint、gateEvents、edits 和 turnId 全部被重置，于是凡是委派过的回合记录为 delegates: []、hint: []，gate 也看不到仍在运行的 deep（2026-10-17 在真实运行中复现，修复见提交 43a4fc3）。
