找到 5 个真实缺陷：超时 1 个、guard 2 个、gate 1 个、嵌套委派记账 1 个。按严重度排列。mod 目录为 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/haiku-spick/T9/run-3/work/mod/。

1. 高｜超时按"开始至今"计算，误判后不可撤销
   - 位置：register.tsx:401（`now - l.startedAt < STALE_MS`），连同 :598、:544、:1001-1004、:799
   - 触发：一次前台 `Agent(deep)` 调用，或一次 `codex exec` review，运行超过 30 分钟。`sweep` 在每次 tool.call 时执行（:764），子代理自己的工具调用也计入，子代理越忙越早被判超时。
   - 后果：该委派被 `settle(id,'failed', Date.now())` 标为 failed，并从 `delegateOfCall` 删除（:544）。子代理之后正常结束时，:1002 和 :799 的 settle 找不到记录，状态永远停在 failed。Stop 时 `roleDone('deep')` 返回 false，gate 会把一个已正确委派并转述结果的回合退回（"no deep run completed"），gateOutcome 也永远记不到 delegated。turn 记录里该委派为 `ok:false`；超时后的用量因 :994 取不到 d 而丢失，后台委派也因 :1004 的 `d` 为空不再写补记行。`ms` 用 `Date.now()` 计算，而 startedAt 来自 `$.clock`，两者不在同一时钟上。
   - 理由：注释写的是"无完成信号 30 分钟"，代码量的是存活时长；超时只是猜测，却按"已报告的失败"处理，且不可撤销。

2. 高｜失败的检查被算作通过（guard 的"是否跑过检查"）
   - 位置：guard.ts:94（只看紧随其后的分隔符是否为 `||`），配合 register.tsx:890（`exitOk` 取整行退出码）
   - 触发：`pytest; echo done`、`npm test && echo PASS || echo FAIL`、`pytest &` 这类写法。检查后面跟着 `;` 或 `&`，或之后某处有 `||`。
   - 后果：整行退出码是最后一条命令的，结果为 0，于是 `exitOk=true`、`coversTurn=true`。测试实际失败，guard 仍认定"已检查"，不退回；第 2 次失败的升级提示（:875 依赖 `r.isError`）也永远不会触发。
   - 理由：文档只承认管道是盲区，但同样的退出码遮蔽在 `;`、`&` 和后置 `||` 上也存在，代码未排除。

3. 中｜编辑在落地前就计数（guard 的编辑计数）
   - 位置：register.tsx:481-484（`mainEdits.add`、`sourceEdits.add`、`editCount++`）。:906、:912、:918 调用 guardEdit 时尚未执行 `next(e)`，之后也不检查结果。
   - 触发：Edit 失败（如 old_string 未找到）或被权限拒绝。
   - 后果：一次未生效的编辑占掉编辑名额，之后对另一文件的真实编辑被拒，并被要求转给 coder。若它发生在一次通过的检查之后，`editsAtStart !== editCount`，回合被判未检查而退回，`uncheckedReason` 还会列出实际没改过的文件。
   - 理由：计数依据是"发起了编辑"而非"编辑生效"，cap 和 coversTurn 都建立在这个计数上。

4. 中｜嵌套委派的用量不进 turn 记录，回合还会记到孙代理名下
   - 位置：register.tsx:781（只有主会话的调用才建 DelegateRec），:993-995（用量只挂到 `delegateOfCall.get(call)`），:780（嵌套调用也执行 `delegate = entry`）
   - 触发：deep 或 coder 子代理再派子代理。:768-787 与 :817-820 明确处理带 `agentId` 的 Agent 调用和 spawn。
   - 后果：孙代理的 turn.complete 查不到 DelegateRec，用量只进 `totals`，不进 turn 文件，spend.py 读到的每回合委派成本偏低。回合结束时 `last` 和 `turns` 记在"最近一个委派"名下（:1040），可能是孙代理的 lane，而非主会话真正派出的那个。
   - 理由：嵌套调用占用了全局的 `delegate`、`agentsThisTurn`，用量却无处可归，记账口径不一致。

5. 中低｜后台启动的 review CLI 一启动就被算作"干净返回"（gate）
   - 位置：register.tsx:896（`settle(id, statusOf(r))`），配合 :857 的 isReview 判定
   - 触发：`codex exec "review ..." > out.txt 2>&1 &`（parseCli 按 `&` 切段，能识别该 lane）；或 Bash 带 `run_in_background` 启动 review lane（Bash 钩子从不读该字段，Agent 钩子在 :798 读了）。
   - 后果：Bash 立即返回 0，委派记为 completed，`roleDone('review')` 为真，gate 放行，而 review 结果尚未产生。
   - 理由：gate 对 review 要求"returned cleanly"，Bash 路径把"进程已派出"当成"结果已返回"，不像 Agent 路径那样区分前台和后台。

不确定之处（均未在代码外核实）：
- 第 3 条：Edit 结果是否带 `isError` 或 `deny`，是从 :385 `statusOf` 的用法推断的，未见引擎类型定义。
- 第 5 条：Bash 信封是否带 `run_in_background`，同样未见类型定义；`&` 那条路径不依赖该字段，可直接从代码确认。
- 第 4 条：嵌套子代理的 spawn 和 turn.complete 事件是否真会到达本 mod，依据的是代码内的处理分支，需实测确认。

本轮未修改任何文件，未运行测试。我抽查了 register.tsx:401、:481-485、:890、:896 与 guard.ts:94，与报告所述一致。

[Model: Haiku 5.5 (medium) → deep Opus (high)]