1. 超时把已完成的委派记成失败，gate 误触发，用量和迟到行丢失（register.tsx:397-408、538-545、598、799、994、1004、1015-1017）
   - 触发条件：一个 deep 子代理（前台或后台）运行超过 STALE_MS（30 分钟），之后正常完成。判定的起点是调用开始时间，不是最后一次活动时间，所以仍在正常工作的长任务也会被判超时。
   - 过程：`sweepStale` 把它移入 `timedOut`，并通过 `onTimeout` 调 `settle(id,'failed')`。`settle` 会把记录从 `delegateOfCall` 删掉。它之后真正完成时，`settle` 找不到记录，直接返回。
   - 后果：
     - 记录永远是 `failed`，`roleDone('deep')` 为假。gate 在 Stop 时会对一个已交付判断的回合误触发，逼模型重派 deep 或写 `Kept:`。
     - 第 994 行 `delegateOfCall.get(call)` 取不到记录，这个子代理的用量不进回合记录。
     - 第 1004 行 `d?.isRecorded` 为空，迟到行不写。
     - 第 1015 行只把 "timed out" 行从面板删掉，委派状态没有改回。
   - 同一处还有一个小问题：第 598 行用 `Date.now()` 写 `endedAt`，其余地方用 `$.clock.now()`，两种时钟混用，`ms` 可能错。

2. 检查是否通过按整条命令的退出码判定，后台、分号和管道会把失败的检查记成通过（guard.ts:85-99；register.tsx:890）
   - 触发条件：
     - `pytest -x; echo done`：退出码是 echo 的。
     - `pytest &`、`npm test &`：`&` 被当作分隔符，检查被识别，但退出码恒为 0。
     - Bash 的 `run_in_background: true`：调用立刻返回，`isError` 为假。
     - `pytest 2>&1 | tail`：退出码是 tail 的。
   - 注释只承认了管道这一种盲区。其余几种也会让 `exitOk` 为真，且 `editsDuring` 为 0。
   - 后果：`isChecked` 为真，Stop 时的"未检查"拦截被绕过，源码带着失败的测试结束回合。

3. 编辑在真正执行前就被计数（register.tsx:481-484、905-921）
   - 触发条件：Edit 或 Write 经过 `guardEdit` 之后，才在后面失败。例如 `old_string` 没找到、被权限拒绝，或写入出错。
   - `guardEdit` 在 `next(e)` 之前就执行了 `sourceEdits.add` 和 `editCount++`，也没有看结果。
   - 后果：
     - 前面已通过的检查因为 `editsAtStart !== editCount` 变得不再覆盖本回合，被迫重跑。
     - 一次什么都没改的失败 Edit，就能让 `sourceEdits` 非空，触发"源码已编辑、无检查"的回送。
   - 同一函数里 `mainEdits.has(path)` 用原始字符串比较（第 473 行）。`./a.ts` 和 `/abs/a.ts` 会被算成两个文件，所以对同一文件的第二次编辑可能被误拒。

4. 嵌套委派的记账错位（register.tsx:778-786、994、1040）
   - 触发条件：子代理自己又调 Agent，即 `e.agentId` 有值的 Agent 调用。
   - 第 780 行对嵌套调用也会 `delegate = entry` 并 `++agentsThisTurn`，只有第 781 行才用 `!e.agentId` 排除委派记录。
   - 后果：
     - 回合记录（第 1040 行）和面板会把这一回合算在孙代理名下，agents 数量也被撑大。
     - 嵌套子代理的 `turn.complete` 在第 994 行查不到记录（`delegateOfCall` 里没有嵌套调用），它的用量没记到父委派的 `usage`。回合记录里的成本因此少算，只有 `totals` 里有。

5. 升级计数的 key 把带值的标志当成检查目标（guard.ts:97，影响 register.tsx:876-880）
   - `key` 取"不以 `-` 开头的参数"，所以 `pytest -k foo`、`pytest -n 4` 里的 `foo`、`4` 都进了 key。
   - 触发条件：模型换一个 `-k` 表达式或 `-n` 值，重跑本质上同一个检查。
   - 后果：失败计数分到不同的 key，永远到不了 `ESCALATE_AFTER`，不会升级给 coder 或 deep。这与注释"`pytest -q tests/a.py` 与 `pytest tests/a.py -x` 同一检查"的意图不符。严重度较低。

UNSURE（没有算进上面 5 条）：
- 第 702 行 `turn.start` 没有按 `e.agentId` 过滤，而 `turn.complete` 和 `turn.step` 有。如果引擎对子代理也发 `turn.start`，守卫和 gate 的回合状态会在回合中途被清空。这取决于引擎事件定义，我没法在这些文件里确认。
- 第 1002 行和第 998、1008 行在子代理第一次 `turn.complete` 就结算并删除 `laneOfAgent` 和 `callOfAgent`。第 366 行的注释却说用量是"按其多个 `turn.complete` 累加"。如果子代理会多次发 `turn.complete`（例如被 SendMessage 续跑），后几次的用量会记到 'agent' 这个通用名下，并且丢失。

[Model: Sonnet 5.5 | Effort: medium]