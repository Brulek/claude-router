共找到 5 个缺陷,按严重度排序。均为只读代码审查,未运行测试。

**1. 超时的委派之后正常完成,仍被永久记为 failed,用量丢失,gate 误触发(turn 记账 + gate,高)**
- 位置:`register.tsx:598`(`onTimeout` 调 `settle(id,'failed',Date.now())`),`register.tsx:538-545`(`settle` 末尾 `delegateOfCall.delete(id)`),`register.tsx:994-1002`(`turn.complete` 里 `delegateOfCall.get(call)`),`gate.ts:31-35`(`roleDone`)。
- 触发条件:一个 deep/coder 子代理(后台代理尤其常见)运行超过 `STALE_MS`(30 分钟)。`sweepStale` 把它移出 `inFlight`,`onTimeout` 把记录定为 failed 并从 `delegateOfCall` 删除。它之后正常结束时:
  - `turn.complete` 里 `d` 为 undefined,`d.usage` 不累加。
  - `settle` 是空操作,状态不会改回 completed。
  - `d?.isRecorded` 为假,不写迟到行。
- 后果:
  - turn 记录里这个委派永远是 failed,用量和费用丢失,`spend.py` 和 `audit.py` 的数字偏低。
  - 同一轮若尚未 Stop,`roleDone('deep')` 为假。deep 其实交了结果,gate 仍会把这一轮打回。
  - `timedOut` 里那一行被删,界面没有任何痕迹说明它完成了。

**2. 嵌套委派(子代理再调 Agent)的记账不一致,用量和归属丢失(turn 记账,中高)**
- 位置:`register.tsx:778-780`(`++agentsThisTurn`、`inFlight.set`、`delegate = entry` 对嵌套调用也执行),`register.tsx:781`(`if (!e.agentId)` 只保护 `delegatesOfTurn` 和 `delegateOfCall`),`register.tsx:994-995`。
- 触发条件:子代理(带 `agentId`)自己调用 Agent。
- 后果:
  - 嵌套调用占用 `inFlight` 和 `agentsThisTurn`,还覆盖了 `delegate`。本轮最终记在嵌套代理的 lane 名下,而不是主会话直接派的委派(`register.tsx:1030` 附近的 `who = delegate ?? mainLane()`)。
  - 它不在 `delegatesOfTurn` 里,`turn.complete` 时 `delegateOfCall.get(call)` 为 undefined。嵌套代理的 token 和费用既不进自己的条目,也不汇入父委派的 `usage`,turn 行的 `delegates` 少记了这部分成本。
  - 对比 CLI 路径(`register.tsx:850` 附近)整体用 `!e.agentId` 排除嵌套,Agent 路径只排除了一半。

**3. 失败或被拒的后台 Agent 调用会在 inFlight 里残留 30 分钟,最后变成"超时"(嵌套/超时记账,中)**
- 位置:`register.tsx:798`(第一处 `isBackground` 带 `&& status === 'completed'`)对比 `register.tsx:804`(第二处不带)。
- 触发条件:`run_in_background === true` 或 `backgroundCalls` 含此 id 的 Agent 调用,自身报错或被拒(`status` 为 failed 或 refused)。
- 后果:
  - 第一处判定"不是后台",`settle` 为 failed 或 refused,这一步正确。
  - 第二处判定"是后台",不执行 `inFlight.delete(id)`,而且这个调用没有子代理,永远不会有 `turn.complete` 来清理。
  - 条幅上挂着一个幽灵代理 30 分钟,期间 `dropFinishedCalls` 也删不掉它(`isRunningAgentCall` 为假时才会被删,但它只在下一次 turn.start/complete 时清理,轮内会一直显示)。
  - 之后它又被 `sweepStale` 当作"超时"列出,并再次触发 `onTimeout`(此时是空操作)。
  - 应让两处共用同一个 `isBackground` 判定。

**4. 编辑在真正执行前就被计数,失败的编辑也会让"检查"失效(guard,中)**
- 位置:`register.tsx:481-484`(`guardEdit` 里 `mainEdits/sourceEdits.add` 和 `editCount++`),`register.tsx:905-920`(`await guardEdit` 之后才 `next(e)`),`register.tsx:891` 与 `register.tsx:462`(`editsDuring` 与 `isChecked` 依赖 `editCount`)。
- 触发条件:Edit/Write 在 `next` 阶段失败(例如 `old_string` 没匹配上、文件不存在、被后续 hook 拒绝),或模型对同一文件反复试错。
- 后果:
  - 没有落盘的编辑也让 `editCount++`。先跑过且通过的检查,其 `editsAtStart !== editCount`,`coversTurn` 变假。
  - `isUnchecked` 为真,Stop 被打回一次,要求重跑检查。
  - 一个纯失败的 Edit 也会让 `sourceEdits.size > 0`,对一个其实没改动任何源码的轮次触发"未验证"。
  - `uncheckedReason` 里列出的文件也不是真被改过的文件。
  - 应在 `next` 成功返回后再计数。
- 另外两个同源的小问题:
  - 路径未规范化(`register.tsx:481` 的 `path` 直接入 Set),`./a.ts`、`a.ts`、绝对路径会被当成两个文件。这会误触发编辑上限(`EDIT_CAP=1`),把同一个文件的第二次编辑拒掉。
  - `NotebookEdit`(`register.tsx:917-921`)没有调 `noteEdit`,与 Edit/Write 不一致,影响很小。

**5. `checkOf` 的 key 把带值的 flag 的值当成 target,同一个检查被拆成不同 key,升级计数失效(guard,低)**
- 位置:`guard.ts:97`(`args.filter(a => !a.startsWith('-'))`),消费方在 `register.tsx:876-877`(`failures` 按 `run.key` 计数)。
- 触发条件:`pytest -k foo tests/a.py` 失败一次,再 `pytest tests/a.py` 或 `pytest -k bar tests/a.py` 失败一次。flag 被丢掉,但它的值(`foo`、`bar`)留在 key 里。
- 后果:同一组测试因改了 `-k`、`--maxfail 1`、`-n 4` 等带值参数就算"另一个检查"。`ESCALATE_AFTER=2` 迟迟不触发,模型会多修几轮才被要求升级。
- 附带的同类漏判:
  - `guard.ts:36-39` 的前缀表不认 `timeout 60 pytest` 和 `sudo -u user pytest`。检查被漏识别,只会让 Stop 多打回一次,影响不大。
  - 带 `-version` 的 `xcodebuild` 不在 `NOT_A_RUN` 里,会被当成检查。

补充说明:
- gate 的判定本身(`gate.ts` 的 `roleDone`、`gateFiring`、`gateOutcome`)逻辑自洽。`running` 的 deep 视为完成是文档化的设计,不算缺陷。上面第 1 条是 gate 受 register.tsx 记账影响出错,而不是 gate.ts 自身的错。
- UNSURE:第 1 条里"后台代理超过 30 分钟是否算正常"取决于产品意图。若 `STALE_MS` 本意就是"超过即失败",那至少"完成后不改回状态、丢用量"仍是缺陷。
- UNSURE:`register.tsx:994-1002` 注释说用量是"summed over its turn.complete events",但第一次 `turn.complete` 就 `settle` 并 `callOfAgent.delete`,同一子代理(例如被 SendMessage 续跑)后续的 `turn.complete` 用量会丢。我没有引擎文档,无法确认续跑是否会产生多次 `turn.complete`,所以没有单独列为缺陷。

审查的文件:`/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/sonnet-bare/T9/run-1/work/mod/` 下的 `guard.ts`、`gate.ts`、`register.tsx`。`format.ts`、`checklist.ts`、`quotaline.ts` 未读(与这三块逻辑无直接关系)。没有修改任何文件。