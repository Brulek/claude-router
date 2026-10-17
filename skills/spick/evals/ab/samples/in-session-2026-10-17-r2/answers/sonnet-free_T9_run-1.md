1. **register.tsx:397-408, 538-545, 598, 799, 994-1002 (超时记账)。超时会把仍在运行或随后正常完成的委派永久记成 `failed`。**
   - 触发条件:一个 Agent 调用(前台或后台的 deep)超过 `STALE_MS`(30 分钟)没有完成信号,又在同一主回合内正常结束。
   - 过程:`sweepStale` 把它移出 `inFlight`,`onTimeout` 调 `settle(id,'failed')`。`settle` 同时执行 `delegateOfCall.delete(id)`。
   - 之后真正完成时,`turn.complete`(994、1001)和 `finally`(799)再调 `settle`,都因查不到记录而无效。注释写着"completion is never taken back",代码实际是把失败固化了。
   - 后果:
     - 门:`roleDone` 只认 `completed` 或 `running`,这个 deep 已是 `failed`,所以 stop 时门会误触发,把已交付的回合打回。
     - 记账:`d` 为 undefined,usage 和成本永远记不上(995)。`isRecorded` 的迟到行也不再写(1004)。
     - 回合记录:这条委派的 `ok=false`。
   - 同处还有一个小问题:598 行的 `Date.now()` 与其余处用的 `$.clock.now()` 混用。时钟不一致时 `ms` 会被 `Math.max(0,…)` 钳成 0。

2. **guard.ts:85-97(行 94 是唯一的退出码判断),配合 register.tsx:890。`checkOf` 只排除后面跟 `||` 的检查。检查后接 `;`、`&` 或后台运行时,退出码被丢掉,仍判为"检查通过"。**
   - 触发条件:`pytest; echo done`、`tsc ; true`、`pytest &`。
   - 过程:这些都解析为检查,但工具结果的退出状态是最后一条命令的,所以 `exitOk=true`。
   - 后果:
     - 失败的测试被当作"编辑后已通过检查",`isChecked` 为真,stop 不再被打回。
     - 连续两次失败也不会累计到 `ESCALATE_AFTER`,因为 `r.isError` 为 false。
   - 文档注释只承认管道 `|` 是已知盲区,实际 `;` 和 `&` 同样漏。

3. **register.tsx:778-786 (嵌套委派)。子代理再起的 Agent 调用被当成主回合的委派来记。**
   - 触发条件:coder 或 deep 子代理内部又调了 Agent(例如 Explore)。
   - 具体缺陷:
     - 780 行 `delegate = entry` 没有 `if (!e.agentId)` 保护,而旁边的 `DelegateRec`(781 行)和 CLI 分支(849 行)都有这个保护。
     - 777 行的 `++agentsThisTurn` 同样把嵌套调用计入。
   - 后果:
     - 1040 行用 `delegate` 决定整个回合记在哪个 lane,于是整回合会被记在嵌套的 Explore 名下,而不是主会话真正委派的 coder 或 deep。
     - 横幅上的 `agents` 数和 `agentIndex` 被虚增。
   - 相关遗漏:嵌套子代理自己的 `turn.complete` 找不到 `DelegateRec`(994 行 `d` 为 undefined),它的 usage 只进 lane 总计,不进父委派。回合记录里该委派的成本和 token 偏低。

4. **guard.ts:61。`isTestScript` 只判断"首词含 `/` 且文件名含 `test`"。**
   - 触发条件:`./scripts/latest.sh`、`/usr/bin/attest`、`./fastest`、`./contest.sh`。"latest"、"attest"、"fastest"、"protest" 里都含 `test`,而 `/test/i` 没有词边界。
   - 过程:这类命令被当成检查,并绕过 `RUNNERS` 和 `declared`。
   - 后果:只要退出码为 0,就算"编辑后已通过检查",未验证的源码编辑会漏过 stop 时的 guard。
   - 同类的小问题:`make test-data`、`make check-deps` 因为 `\b` 在 `-` 前成立而被误判为检查。

5. **register.tsx:471-486 与 905-916。编辑在 `tool.call` 阶段就记入 `mainEdits`、`sourceEdits` 并 `editCount++`,此时 `next(e)` 还没执行。**
   - 触发条件:Edit 之后实际失败,例如 `old_string` 不唯一或找不到,或后面的钩子拒绝。
   - 后果:
     - 失败的编辑也占用 `EDIT_CAP=1` 的名额,同回合改第二个文件会被误拒。
     - `sourceEdits` 非空且 `editCount` 增加,让之前已通过的检查失去 `coversTurn`,回合被要求重跑检查,而文件其实没改。
     - `agentFiles` 和 `files` 也会列出实际没改动的文件。
   - 同函数还有一个小问题:`mainEdits` 按原始路径字符串比较(473 行),`./a.ts` 与绝对路径指向同一个文件时,会被当作两个文件而误触发上限。

按要求未修改任何文件,也未运行测试。

[Model: Sonnet 5.5 | Effort: medium]