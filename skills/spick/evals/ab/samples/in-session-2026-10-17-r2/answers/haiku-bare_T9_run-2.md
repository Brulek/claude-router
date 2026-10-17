共找到 5 个缺陷，按严重度排序。只读审查，未修改文件，未运行测试。

1. [高] guard.ts:94-97，checkOf 只跳过 `||` 后接的检查。
文件：/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/haiku-bare/T9/run-2/work/mod/guard.ts
触发：Bash 命令 `pytest; echo done`、`(pytest) || true`、`npm test; true`。pytest 失败，但行末命令退出 0，工具结果不是 isError。
后果：checkOf 返回 pytest，register.tsx:890 置 exitOk 为 true，isChecked（register.tsx:462）成立，classic.Stop（register.tsx:952）不把回合退回，源码改动未经检查即结束。guard.ts:66-69 的注释只说明了 `||` 与管道两种情况。

2. [高] register.tsx:397-408、538-545、997-1007，超时后才完成的委派，用量和 late 行丢失，并被门禁按失败计。
文件：/private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/haiku-bare/T9/run-2/work/mod/register.tsx
触发：某个 Agent 调用的子代理 30 分钟内无完成信号。sweepStale 调 onTimeout，即 settle(id,'failed')，并从 delegateOfCall 删除该记录（544 行）。之后子代理才结束。
后果：turn.complete 中 d 为 undefined（1001 行），usage 不写入（995 行），late 行也不写（1004 行）。回合记录中该委派 ok:false、costUsd:null，实际花费却漏计，spend 偏低。gate.ts:32 的 roleDone 也把它当作失败，所以即使 deep 已交出结论，回合仍可能被门禁退回。

3. [中] register.tsx:798 与 804-807，被拒或报错的后台 Agent 调用，其车道滞留在 inFlight。
文件：同上 register.tsx
触发：Agent 调用带 run_in_background: true，结果为 deny（agent.spawn 因 821 行的 `!r.deny` 不记入 backgroundCalls）或 isError。
后果：798 行对 status 做了判断，settle 已执行；但 804 行的 isBackground 不看 status，为 true，于是 806-807 行的 inFlight.delete 被跳过。该车道在本回合剩余时间内留在频带与 Running 列表中，showing（581-584 行）也会选中它。回合结束时 dropFinishedCalls（1022 行）才清掉。

4. [中] guard.ts:18，`ruff`、`eslint`、`tsc` 等只匹配命令词，不看子命令。UNSURE: 是否有意把格式化计为检查，需要确认。
文件：同上 guard.ts
触发：编辑源码后执行 `ruff format src/`、`eslint --fix .` 或 `tsc --init`，三者退出码均为 0。
后果：checkOf 计为通过的检查，guard 不要求真正的测试或构建。guard.ts:12-13 的注释称检查为测试、构建、linter 或类型检查器，与此不符。

5. [低] register.tsx:780，嵌套子代理的 Agent 调用也改写 delegate。UNSURE: 注释（532 行）对"最新委派"的含义有歧义，需要确认。
文件：同上 register.tsx
触发：子代理自己调用 Agent（e.agentId 有值）。780 行的 `delegate = entry` 不受 `!e.agentId` 限制，而 782-783 行的 delegatesOfTurn 记录却受其限制。
后果：回合结束时 1040 行的 who = delegate 把回合记录（last、turns）的 lane/model 写成嵌套子代理的车道，而 delegatesOfTurn 中并无此委派，两者不一致。