共 5 个缺陷,按严重度排序(行号来自 /private/tmp/claude-501/-Users-brulek-Documents-Developer/d15fe6ce-532d-4271-89ed-d39ed6c5f409/scratchpad/ab/r2/sonnet-bare/T9/run-3/work/mod/)。只读代码,未改文件,未跑测试。

1. 超时按"调用开始时间"算,不按"最后一次完成信号"算;超时后委派记账永久丢失(turn 记录 + gate)
   - 位置:register.tsx:401(`now - l.startedAt < STALE_MS`)、:403、:598(`onTimeout` 调 `settle(id,'failed',Date.now())`)、:992-995 与 :1004-1006(turn.complete 靠 `delegateOfCall.get(call)` 找记录)。
   - 触发:一个合法的长委派(前台或后台 deep/coder,运行超过 30 分钟)。`sweep` 在每个循环的每次 tool.call、turn.step 上都会跑,所以它还在干活就会被扫走。
   - 后果:
     - `settle` 把它标成 failed,并把它从 `delegateOfCall` 删掉。
     - 它之后正常结束时,turn.complete 里 `d` 为 undefined:用量不会累加进委派,也不会写 `lateLine`,状态也无法改回 completed。注释里"完成不会被收回"只适用于 completed,failed 改不回去。
     - gate 的 `roleDone`(gate.ts:32)认为 deep 既不是 completed 也不是 running,于是即使 deep 已经交付,gate 仍会误判"缺 deep"并把该 turn 打回一次。
     - turn 记录里该委派是 failed、成本为 null,与事实相反。
   - 附带::598 用 `Date.now()`,其余全用 `$.clock.now()`。时钟不一致时 `ms` 会被 `Math.max(0,…)` 截成 0 或异常大。

2. Bash 命令行里"检查"的退出码被后续命令掩盖,仍算 covers-turn(guard 误放行)
   - 位置:guard.ts:94(只排除 `parts[k+1]==='||'`)与 :85 的分隔符切分;register.tsx:890(`exitOk` 取整条 Bash 的结果)。
   - 触发:`pytest; echo done`、`pytest; true`、`npm test\nrm x`、`pytest &` 这类写法。`checkOf` 找到第一个 runner 就返回,只看它后面是不是 `||`。
   - 后果:工具结果的退出码是最后一条命令的,check 失败却 `exitOk=true`,`coversTurn` 为真,"改了源码但没跑过检查"的 Stop 拦截被绕过。文档注释只承认了管道这一个盲区,`;` 和后台 `&` 没有列入。
   - UNSURE:若 Bash 的 `run_in_background` 调用立即返回成功,同理会被当作通过。我没看到引擎对该字段的定义。

3. 编辑在执行前就记账,失败或被拒的编辑也占用名额并触发"未检查"
   - 位置:register.tsx:481-484(`mainEdits.add`、`sourceEdits.add`、`editCount++`),调用方在 :911-924 的 `deny` 判断之后才 `next(e)`。
   - 触发:Edit 的 old_string 找不到、权限被拒、Write 失败,或编辑被其他 hook 拒绝。
   - 后果:
     - 失败的编辑已占用 `EDIT_CAP=1`,之后对另一个文件的真实编辑被拒,并提示"already edited X itself",而 X 实际没变。
     - `sourceEdits` 非空,turn 结束时必须跑检查,否则被打回。
     - `editCount` 虚增,会让进行中的检查被判为"期间有编辑",`coversTurn` 变假。
   - 同类:`mainEdits` 按原始路径字符串去重(:473、:481),同一文件用 `./a.ts`、相对路径、绝对路径各写一次,会被算成两个文件而撞上上限。

4. 嵌套委派:子代理发起的 Agent 调用污染 `delegate`,且嵌套用量没有记到顶层委派上
   - 位置:register.tsx:780(`delegate = entry` 没有 `!e.agentId` 保护,而 CLI 路径 :855 有);:781(只给主循环建 `DelegateRec`);:991-995(用量只加到 `callOfAgent.get(e.agentId)` 对应的记录)。
   - 触发:deep 或 coder 子代理自己再派发一个 Agent(嵌套)。
   - 后果:
     - 主 turn 收尾时 `who = delegate`(:1031 附近)取到最后一个嵌套子代理的 lane,Turn 历史和 `last` 记在错误的 lane 下。
     - 嵌套那次调用的 `agentIndex` 也计入 `agentsThisTurn`,band 的 agents 数偏大。
     - 嵌套子代理的 token 与费用只进 `totals`。它没有 `DelegateRec`,所以 `delegateOfCall.get` 取不到,顶层委派的 `usage`/`costUsd` 少了这部分,turn 记录里的花费被低估。

5. 子代理多次 turn.complete 时,首次结算就清掉映射,后续用量与 lane 丢失;另有 turnId 为空串时 gate 永不触发
   - 位置:
     - register.tsx:998-1008(首个 turn.complete 就 `laneOfAgent.delete`、`settle`、`callOfAgent.delete`)。
     - register.tsx:552、:554、:946(`mainTurnId=''` 与 `gateAskedTurn=''` 初值相同)。
   - 触发:
     - 第一种:同一个 agentId 之后再产生 turn.complete。:995 的注释写的是"summed over its turn.complete events",但第一次之后映射已删。
     - 第二种:mod 在会话中途加载、没有收到 turn.start,`mainTurnId` 仍为 ''。
   - 后果:
     - 第一种:后续 turn 的用量按 lane `'agent'` 记入 totals,不进委派记录。
     - 第二种:`gateAskedTurn === mainTurnId` 恒真,Stop 直接放行,gate 和 guard 的打回都失效。这个情形我判断概率较低,严重度不高。
   - UNSURE:第一种取决于引擎是否真会对同一 agentId 发多次 turn.complete,我没法从这些文件确认。

另一个没列入的盲区:hook 只覆盖 Edit、Write、NotebookEdit(:911-924)。如果引擎还有 MultiEdit,它不受 cap 和"未检查"约束。Bash 的 `sed -i` 等写入不受约束是 format.ts:107 自己承认的。