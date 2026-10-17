共找到 5 个真实缺陷，按严重度从高到低排列。只读代码，未修改文件，未运行测试。文件均在 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/haiku-spick/T9/run-1/work/mod/ 下。主会话抽查了其中关键行（register.tsx:598、537-545、481-484；guard.ts:94；format.ts:259），与引用一致。

1. 【高】运行超过 30 分钟的委派被永久记为 failed，之后真正完成也无法改回。
 - register.tsx:598 的超时回调直接 settle(id,'failed')；register.tsx:538-545 的 settle 在改状态后把记录从 delegateOfCall 删除；register.tsx:764 的任意 tool.call 都会触发 sweep（子代理自己的调用也算）；register.tsx:993-1007 后续的 turn.complete 查 delegateOfCall 得到 undefined；gate.ts:32 只认 completed 或 running。
 - 触发：deep 子代理或 CLI review 运行超过 STALE_MS（format.ts:259，30 分钟），且期间有工具调用（前台 deep 的工具调用同样触发）。
 - 后果：gate 误判，roleDone('deep') 为 false，Stop 时发回并诱导再派一次 Opus；后台子代理超时后不写 late line，主行停在 running、ms 为 null；之后的 usage 挂不到记录上，spend 少算；超时用 Date.now() 而非 $.clock.now()。

2. 【高】guard 把整条命令的退出码当成检查的退出码，只排除了 ||。
 - guard.ts:94 只判断 parts[k+1] === '||'；guard.ts:85 按 ; & 换行切分后，后随分隔符一律不管；register.tsx:890 的 run.exitOk = !r.isError 取的是整条 Bash 结果；register.tsx:836-846 未读取 run_in_background。
 - 触发：`npm test; echo "exit $?"`、`pytest > out.txt; tail out.txt`、`pytest; true`、`cargo test &`，或 Bash 设 run_in_background: true。
 - 后果：测试失败也被记为 exitOk: true，coversTurn 为真，guard 放行。guard.ts:66-69 的注释只承认了管道这一盲区，与代码矛盾。
 - 未完全确认：run_in_background 那半条依赖 Bash 事件信封带该字段（目录内无 engine 类型定义，Agent 处理器 804 行读了同名字段，故较可能）。; 与 & 那半条不依赖此前提。

3. 【中】编辑在执行前就计数，被拒或失败的编辑也占名额。
 - register.tsx:481-484 的 mainEdits.add、sourceEdits.add、editCount++ 在 next(e) 之前；906-909 的 Edit/Write 与 917-921 的 NotebookEdit 同样。
 - 触发：Edit 被用户拒绝、被其他钩子 deny，或 old_string 未匹配。
 - 后果：失败的编辑占满 EDIT_CAP=1 的名额，改真正目标文件会被拦（理由是“已改过 A”，而 A 并未改动）；sourceEdits 多出未改动的文件，guard 因此发回；若发生在通过的检查之后，editCount 变化使该检查失效（register.tsx:380），已验证的一轮被要求重跑。

4. 【中低】嵌套委派改写主轮记账。
 - register.tsx:778-780 的 agentIndex: ++agentsThisTurn 与 delegate = entry 未判断 !e.agentId；只有 781 行建 DelegateRec 时排除了子代理。
 - 触发：子代理（如 deep）自己再调 Agent，或上一轮遗留的后台子代理在本轮发起嵌套调用。
 - 后果：主轮 agents 计数混入嵌套调用；1040 行用 delegate 定归属，本轮可能被记在嵌套子代理的 lane 与模型下；嵌套子代理无 DelegateRec，993-995 行的 usage 挂不上。
 - 未完全确认：“嵌套 usage 丢失”依赖父子 turn.complete 的 usage 不含子代理部分，代码内无法核实；计数与归属被改写一条是确定的。

5. 【低】检查识别用子串 test，误把 latest 之类名字当检查。
 - guard.ts:61 的 isTestScript 只看 /test/i.test(base)；guard.ts:21 的 \S*tests?\.py；guard.ts:24 的 (?:bash|sh|zsh)\s+\S*test。
 - 触发：./scripts/latest-release.sh、python3 latest.py、bash deploy-latest.sh、/usr/bin/test -d dir。
 - 后果：一条与测试无关、退出码为 0 的命令即可满足 guard，源码已改却未跑真正检查。