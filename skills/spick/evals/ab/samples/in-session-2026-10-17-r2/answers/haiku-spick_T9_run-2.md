mod/ 三块逻辑的审查结果（只读，未运行测试）：共 5 个缺陷，按严重度排序。

1. 超时后，即使委派真的跑完，也永远记为 failed，gate 会据此误判（高）
   - 位置：register.tsx:598（onTimeout 调用 settle(id,'failed',…)）；register.tsx:538-545（settle 之后执行 delegateOfCall.delete(id)）；register.tsx:799、896、1001-1007（迟到的完成信号查不到记录）。
   - 触发条件：前台 Agent(deep) 或 CLI 委派运行超过 STALE_MS（30 分钟，format.ts:259）。sweep 在每次 tool.call 时执行（register.tsx:764），长跑中必然被扫到。
   - 后果：子代理随后正常返回，但记录已删，状态停在 failed。roleDone('deep')（gate.ts:32）返回 false，gate 以"no deep run completed"打回一个其实已交付结论的回合。后台 agent 的迟到用量也写不进去（register.tsx:1001-1007、994-995）。另外 endedAt 用 Date.now()、startedAt 用 $.clock.now()，两种时钟混用，假时钟下耗时会失真。

2. 检查判定只看整条命令的退出码，失败的检查会被记为通过（高）
   - 位置：guard.ts:85-97（只处理紧跟 || 的情况，见 guard.ts:94）；register.tsx:890（run.exitOk = … !r.isError）。
   - 触发条件：检查后接 ;、换行、&，或 && … || … 链，例如 npm test; echo done、pytest && echo ok || echo fail、pytest &、echo $(pytest)。
   - 后果：末段命令退出 0 则 isError 为假，coversTurn（register.tsx:380）和 isChecked（register.tsx:462）都成立。测试实际失败的回合不会被打回，escalation 的失败计数（register.tsx:875）也拿不到这次失败。guard.ts:66-69 的注释只承认了管道 | 这一盲区。

3. 编辑在执行前就计数，失败或被拒的编辑也算数（中）
   - 位置：register.tsx:481-484（mainEdits、sourceEdits、editCount++ 都在 next(e) 之前）；register.tsx:906-920 没有按结果回滚。
   - 触发条件：Edit 因 old_string 不匹配报错，或用户在权限提示中拒绝，或下层钩子 deny。
   - 后果：改 A 失败后再改 B 会被编辑上限（register.tsx:473）拒绝，而 A 实际未改。检查通过后若再有一次失败的 Edit，editCount 与检查时的 editsAtStart 不再相等（register.tsx:380），回合被判 unchecked，打回理由（register.tsx:966）还会列出根本没改动的文件。

4. 嵌套 Agent 调用覆盖本回合的 delegate 与 agent 计数，turn 记录挂错 lane（中）
   - 位置：register.tsx:778-780（agentIndex: ++agentsThisTurn 与 delegate = entry 未判断 e.agentId）。对照 register.tsx:781 与 849，DelegateRec 和 CLI 路径都排除了子代理发起的调用，这里没有。
   - 触发条件：主会话派出的子代理（如 deep、planner）再发起一次 Agent 调用。
   - 后果：register.tsx:1040 用 delegate 决定记在谁名下，last/turns 会记成孙代理的 lane、model、effort。band 的 agents 计数（register.tsx:786）也把嵌套调用算了进去，与 delegatesOfTurn 对不上。

5. 嵌套子代理的用量从 turn 记录中丢失（中低）
   - 位置：register.tsx:993-995（delegateOfCall.get(call) 只查得到主会话直接派出的调用）；register.tsx:781（嵌套调用不建 DelegateRec）。
   - 触发条件：任何嵌套委派，例如 deep 内部再派出 general-purpose。
   - 后果：孙代理的 token 与费用只进 totals（register.tsx:981-991），不计入父委派的 usage，turn 记录里的委派费用系统性偏低。

注意：以上结论均来自只读阅读，未经运行验证。第 2 条中后台 Bash 是否同样被记为通过，代码中看不到引擎是否传入相关字段，未单列。另有一处取决于引擎语义的疑点（Stop 打回后若换了 turnId，gate 结果可能不被记录），未计为缺陷。