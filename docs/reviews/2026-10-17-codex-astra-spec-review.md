**结论：合并前应先冻结事件、记录和评测契约。当前规格不能保证测到完整 v2，也不能支撑“更便宜且不降质”。**

下文 D 指[设计规格](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/docs/superpowers/specs/2026-10-17-spick-v2-design.md)，R 指[调研](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/docs/research/2026-10-17-landscape.md)。代码事实来自当前工作树的静态核对，未运行真实 Claude 会话；推断单独标明。工作树内未找到两份原始评审，不能把 D 对它们的转述当作完整覆盖清单。

**1．会导致实现失败或互相冲突的规格**

- **文件归属重叠，且接口修改无人明确负责。** D §11：S1 拥有 `checklist/hint/quotaline` 的测试，S2 的排除项却只排除实现文件；S1 对 `skills/spick/**` 的排除也没有排除 S2 的 `test_spend.py/test_audit.py`；S3 的 README Evaluation 仍落在 S1 所有范围内。另据[checklist.ts:84](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/mod/spick-dashboard/hooks/checklist.ts:84)，当前接口以数组长度判断 registry，§5 的显式空 registry 必须修改标记区外的函数。**改为逐文件唯一所有者，明确该接口由 S1 修改、S2 调用；先提交共享类型和测试 fixture，再并行实现。**

- **评测没有明确启动被评测的 mod。** D §10 只规定 `arm.json` 加 shell hook，却要求读取 §6 的 mod turn record；[spend.py:2](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/skills/spick/scripts/spend.py:2) 明确说明没有 mod 就没有 usage 文件。**规定从当前 checkout 加载 mod，并在每次运行前断言版本、gate/guard 状态和事件探针；hook-only 应作为独立 arm。** 此外，现行 [SKILL Step 1b](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/skills/spick/SKILL.md:45) 对三文件任务要求 plan mode，headless 默认停止编辑，正好覆盖 T8；§3 只缩窄 planner 阈值，没有同步解除该阻塞。必须规定明确授权的 headless 实现任务如何继续。

- **“Agent 调用返回＝角色完成”与后台代理冲突。** D §5 如此定义完成；但[register.tsx:705](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/mod/spick-dashboard/hooks/register.tsx:705) 已明确处理“后台调用立即返回、代理仍运行”。**以关联 `tool_use_id/agentId/parentTurnId` 的成功完成事件及交付物验收为准，拒绝、超时、后台句柄不得满足 gate。** 同时规定后台代理晚于主 turn 完成时如何归账，否则 §6 的一次性写入必然漏记或提前宣告完成。

- **§6 的数据结构表达不了 §6 承诺的报表。** 单个 `gate.outcome` 保存不了“sent-back 后 kept”；汇总 `agentUsage` 无法分摊多个 lane 的成本；`hint` 只是词匹配，不等于真实任务种类；单个 `check` 丢失两次失败及覆盖范围。**补 `gateEvents[]`、逐 delegate usage/cost/status、`checks[]`、实际 route/keep reason 和 schemaVersion。** §8 又把旧文件移走，必须同时规定迁移后的 legacy 读取路径及去重键。

- **共享 JSONL 没有并发写入契约。** 已核实旧 gate 日志使用读整文件再写回，[register.tsx:242](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/mod/spick-dashboard/hooks/register.tsx:242) 的 Promise 队列只在本进程内串行化；若沿用到 §6，共享写入会丢记录，§10 的 `--parallel 2` 就能触发。**采用每 session 独立文件再聚合，或明确带跨进程锁的追加机制，并测试并发、崩溃和重复事件。**

**2．仍然站不住的机制**

- **“fail-closed”实际上是格式猜测。** D §5 的三行代码启发式会把单行源码、无缩进代码、敏感自然语言判为 text；只检查 prompt 又遗漏 `system-file`，而当前 [invoke.py](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/skills/spick/scripts/invoke.py:270) 确实支持该输入。模型还能自行声明 `--contains public` 或填写 override。**替代：明确这是“声明约束”，不是敏感数据识别；未知默认最高级或拒绝，合并所有发送内容的级别，限定 override 的授权来源，并保证外部调用都经过同一入口。**

- **一文件 cap 不等于控制修改规模。** 已核实只拦截 Edit/Write/NotebookEdit，[register.tsx:776](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/mod/spick-dashboard/hooks/register.tsx:776) 没有覆盖 Bash 写文件；[format.ts:87](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/mod/spick-dashboard/hooks/format.ts:87) 还把 YAML/JSON/TOML 全排除，CI 和关键配置变化因此不计。一个文件也可能是大规模重写。**替代：将其明确标为工具级软约束；结合变更 diff、配置文件和实际权限边界判断，不能宣称完整强制执行。** 同理，Explore 的工具表写着 Bash、“read-only”写在提示词里，不构成只读权限。

- **检查时间晚于修改，不代表验证了修改。** D §5 没定义比较检查开始还是结束：测试先启动、文件随后修改、测试最后返回，按完成时间会误判；`pytest --version`、`pytest || true` 也说明 runner 名字和外层成功不足以证明检查通过。**替代：检查开始时绑定 workspace/edit revision，结束时确认没有新修改，记录实际退出状态和检查范围；区分 test/lint/build，检查不覆盖的修改仍标未验证。**

- **两次失败只是提醒，不是升级上限。** D §3 向“下一次 Bash”附上下文，模型第二次失败后直接回复就可能看不到；改命令参数可绕过“相同命令”，不同 cwd 的同名命令又会被误合并；§5 一次 send-back 后放行也允许无视升级。**替代：在第二次结果返回时立即更新任务级失败状态，按 cwd、检查目标及失败类别关联，在下一模型步可见，并记录升级是否实际完成；若只做建议，就删除“上限/强制”含义。**

**3．§10 能证明什么，不能证明什么**

当前最多证明：**这些固定题目、这些机器配置下，几个组合方案的观察结果不同。** §12 只要求 T1/T2 各一次，连 coder、planner、review、guard 都没覆盖。

需要补：

- **干净且公平的对照。** bare 仍读 spick 指令，却禁止 Agent，是互相矛盾的配置；仅禁止 Agent 也没禁止 Bash 调用外部 CLI。隔离配置、指令、插件、记忆及工具权限，并验证实际加载内容。保留禁止委派的“单模型”基线，另加正常可委派的 Sonnet/Opus 基线，否则不能外推到真实强主会话。
- **机制消融。** 至少比较 Haiku bare、仅 skill/hook、完整 mod；另加固定委派策略，才能区分“调用更强模型”的收益与“按交付物路由”的收益。
- **完整成本与失败口径。** 已核实外部 CLI 在[register.tsx:755](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/mod/spick-dashboard/hooks/register.tsx:755) 记为未知成本；不能把 Claude `total_cost_usd` 当系统总成本。纳入重试、失败、review、外部调用，未知保持未知；裁判费用单列。报告质量、完成率、总成本、成功交付成本及延迟分位数。
- **独立质量判据。** T6 格式通过不能证明内容正确或可用；T5/T7 单裁判可能偏好文风，删除标签也不能保证真正盲评。补事实/需求覆盖 rubric、隐藏边界用例、人工抽检及裁判一致性；hidden tests 必须放在被测代理不可读写的位置，不能只要求 visible tests 不变。
- **任务多样性和统计设计。** 八题重复 N 次只增加对八题的估计精度，不增加任务覆盖。加入多轮长会话、跨文件复杂修改、检查失败升级、混合意图、外部 lane 不可用等独立任务；先用 pilot 估计方差，再按预设质量非劣界限和最小节省幅度确定样本量，按任务配对并报告置信区间，不能给一个万能 N。

**无论把这八题重复多少次，都不能据此得出：**一般开发任务“不降质”、真实周/月账单下降、长会话缓存收益、数据不会外泄、gate 提高正确率，或收益来自某一具体机制；分别缺任务外推、真实计费与长会话、攻击性验证及消融依据。

**4．遗漏**

- **产物验证仍弱于调研承诺。** R“Ten principles”第 7 条要求对真实产物验证；D §3 主要修复 Evidence 保留。现行 [SKILL Step 6](/Users/brulek/dev/spick/.claude/worktrees/spick-v2/skills/spick/SKILL.md:100) 仍把“有测试输出”“URL 可访问”作为检查，无法证明输出对应当前代码、来源支持结论。
- **没有形成日志→修订路由的闭环。** R“Comparable projects”及 Addendum 要求用实际 outcome 调整策略；D §6 只统计 hint 和调用，缺人工确认的任务类型、路由错误、交付质量及策略版本，无法评价路由准确率或安全调参。
- **上下文隔离缺返回预算。** R 原则 3、6 强调小主会话；D §3 要保留 Evidence，§9 却只限静态文字，没有限制 delegate 返回内容和原始日志。大段 Evidence 仍会把主上下文撑大，应保存完整 artifact、主会话接收摘要与定位信息。
- **默认 Explore 替换仍是待验证前提。** D §3 允许发现用户级覆盖无效后仅记录说明，但这意味着该收益没有交付；应将运行时确认实际模型、权限列为功能验收，而不只是 `claude agents` 列表检查。
- **两份评审缺可追踪覆盖表。** D §1 声称修复所有已验证缺陷，§7 仅列摘要；应保存原评审或稳定引用，逐项关联规格、实现、回归测试、明确延期理由，否则“全部覆盖”不可审计。

**5．按价值排序的修改建议，最多八条**

1. **重写 §10 的 arm 启动契约，隔离配置并验证当前 checkout 的 mod 确实运行，避免测到旧安装或仅 hook。**
2. **冻结 §6 的事件与记录 schema，补后台代理归属、gate 历史、逐 lane 成本及并发写入语义，否则核心审计数据不可信。**
3. **把 §5 的“返回即完成”和时间戳检查改成成功交付状态及 workspace revision 验证，避免未完成代理、过期测试放行。**
4. **把数据级别改成统一出口上的保守声明约束，覆盖 system 输入并限定 override，停止把代码格式识别称为 fail-closed。**
5. **修正 §11 的重叠所有权并先交付共享接口，同时同步 headless plan-mode 规则，防止三组实现集成时互相阻塞。**
6. **为 §10 增加公平强模型基线、机制消融、完整成本和预注册非劣检验，使结论能对应“省钱且不降质”。**
7. **明确 edit cap、Explore 只读和失败升级各自的实际权限边界，并以绕过路径及失败事件做验收，避免提示词被当成强制机制。**
8. **将 §12 扩展到真实委派、后台完成、双失败升级、迁移与并发日志的集成场景，并补原评审逐项追踪表，避免两道 chore 通过即宣布 v2 完成。**
