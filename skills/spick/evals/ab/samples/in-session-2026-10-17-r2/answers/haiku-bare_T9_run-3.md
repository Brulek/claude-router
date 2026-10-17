共找到 5 处缺陷，按严重度排序（只读审查，未改文件、未跑测试）。注：register.tsx 实际 1,423 行，不是约 1,100 行。

1. guard 误判通过：`;` 或换行后接的命令会让失败的检查被记为通过。
- 位置：register.tsx:890-891（exitOk 取整条 Bash 结果的状态），guard.ts:85-98（checkOf 只返回第一个命中的检查，且只在 `||` 时跳过）。
- 触发：`pytest -q; echo done`，或 `tsc; pytest` 其中 tsc 失败而 pytest 通过。shell 的退出码是最后一条命令的，所以整条结果 `!r.isError`，CheckRun 记为 exitOk=true 且 coversTurn 成立。
- 后果：测试或类型检查实际失败，但 isChecked 为真，guard 不会把回合退回去，编辑过的源码可以带着失败的检查结束回合。注释（guard.ts:67-69）只说明了管道和 `||` 的盲点，没有覆盖 `;`。

2. 跑满 30 分钟的委派被记为失败，之后即使完成也改不回来。
- 位置：register.tsx:397-404（sweepStale 调 onTimeout）、598（onTimeout = settle(id,'failed')）、538-545（settle 设置 status 后 delegateOfCall.delete）、1002（turn.complete 时 settle 找不到记录，直接返回）、1004-1006（后记行仍写 failed）；gate.ts:31-32（roleDone 只认 completed 或 running）。
- 触发：一个 deep 子代理（或 CLI 调用）运行超过 STALE_MS（format.ts:259，30 分钟），之后正常完成。
- 后果：该委派在回合记录里一直是 failed，后记行也是 failed；回合结束时 roleDone('deep') 为假，gate 会误退回一次，并写出「no deep run completed」的错误说明。

3. 被拒绝或失败的后台 Agent 调用一直留在 inFlight 里。
- 位置：register.tsx:798（后台且 completed 才不 settle）与 804（isBackground 不看 status）、821（deny 时不加入 backgroundCalls）。
- 触发：Agent 调用带 run_in_background:true 且被 deny（或报错）。
- 后果：798 行把它 settle 成 refused/failed，但 804 行判为后台，不从 inFlight 删除。band 的 lane 仍显示它，运行列表里也保留它，直到 30 分钟后被 sweep 挪进 timedOut，显示成一个超时的运行中代理。

4. 嵌套委派覆盖了主回合的 delegate（UNSURE：是否为设计意图需要作者确认）。
- 位置：register.tsx:778-780（`delegate = entry` 对子代理发起的嵌套 Agent 调用也执行，没有 `!e.agentId` 判断，而 CLI 分支在 853-855 有判断）；1040（回合记在 `delegate ?? mainLane()` 下）。
- 触发：子代理自己再调用一次 Agent（嵌套委派），且主回合之后没有新的委派。
- 后果：回合记录的 lane/model 写成嵌套子代理的，而不是主会话的。嵌套调用也会计入 agentsThisTurn（778），使 band 的 agents 数偏大。

5. guard 把非检查命令认作检查（低严重度）。
- 位置：guard.ts:18（xcodebuild 正则不限子命令）、guard.ts:41（NOT_A_RUN 只认 `--version`，不认 `-version`）、guard.ts:61（isTestScript 用 /test/i 匹配基名）。
- 触发：`xcodebuild -version`，或 `./scripts/update-latest.sh`（"latest" 含 "test"）。
- 后果：这些命令退出码为 0，会被记为通过的检查，覆盖掉本该要求的检查。