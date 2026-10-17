## 1. 总体判断

**核心主张是合理假设，但当前实现与证据不足以支持“省钱而不丢质量”。** spick 已经具备可用的分流提示、委派约定和运行记录；目前更适合定位为实验性的路由辅助层。它尚未形成从任务理解、委派、执行到验收的可靠闭环。

最大的三个风险是：

1. **质量瓶颈仍留在小模型。** Haiku 要识别任务、提取全部约束、编写 brief、选择 effort、判断返回结果是否合格；最终验收却主要检查格式、测试输出是否存在、链接是否可访问。这不足以发现理解偏差、错误结论或遗漏约束。[SKILL.md:84–106](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:84)
2. **分流可能增加总成本，尚无对照证据。** “任何未决定的设计选择先找 planner”“不确定就 deep”“effort 犹豫就提高”，再叠加 coder、review 和重试，可能让普通任务变成多次昂贵调用。现有 smoke 没有 baseline，且漏计嵌套 deep 的 tokens。[SKILL.md:20–22、59–76](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:20)；[smoke:3–14](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/evals/smoke-2026-10-16.md:3)
3. **控制机制容易产生错误的安全感。** gate 判断“是否调用过代理”，guard 判断“命令里是否出现检查关键词”，数据等级超限则仅警告后继续发送；它们不能证明正确委派、有效验证或数据边界得到执行。[register.tsx:697–837](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.tsx:697)；[invoke.py:229–232](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/invoke.py:229)

**验证范围：**本次只读审查了当前工作树的说明、规则、assets、脚本、dashboard hooks 和测试，没有访问网络。41 个不需要写盘的现有 Python 测试通过，并用内存 mock、Node 直接调用复现了下述若干缺陷。全量 unittest 受只读沙箱的临时目录等限制，不能据其结果判断产品测试是否通过；没有运行真实 Claude Code mod 集成测试。

## 2. 架构问题

### P1：强模型处理任务，小模型承担最终质量判断，职责没有闭环

委派确实能提高执行能力，但 brief 的完整性与最终语义判断仍由 Haiku 决定。规则把“来源存在”近似为事实检查，把“测试输出存在”近似为验证；失败两次后还允许主模型自己接手。此外，“删除关于 samples 或 production 的说明”可能删除必要的适用范围和限制。[SKILL.md:84–106](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:84)

**后果：**上游遗漏会被强模型忠实执行，下游错误可能被格式正确的输出掩盖。这是设计风险；现有评测没有测出其发生率。

**改法：**原始请求和硬约束作为不可改写字段传递；代理返回结构化的结果、证据、未完成项和不确定性。主模型负责机械校验，高风险结论由强模型复核。禁止自动删除实质限制；复杂任务失败后升级或明确报告失败，不能默认降回 Haiku 解决。

### P1：gate 的通过条件是“发生调用”，不是“需要的工作完成”

Agent 调用在 `next(e)` 返回前就设置 `delegate`；CLI 同样如此。Stop 只检查 `delegate !== null`，不验证代理角色、调用是否成功、结果是否返回、是否覆盖任务。一次搜索调用就足以让需要 deep 判断的混合任务避开 gate。[register.tsx:697–738、748–765、821](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.tsx:697)

gate 和 guard 还共用一次阻断额度：gate 先触发后，第二次 Stop 不再检查未验证的源码修改；测试明确把这种行为作为预期。[register.tsx:817–837](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.tsx:817)；[register.test.ts:1156–1163](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.test.ts:1156)

**改法：**为任务记录所需角色及其 `started/completed/failed/verified` 状态。一次返回可以合并所有待处理问题，避免无限循环，但不能用“提醒过一次”替代完成条件。明确区分“软提醒已结束”和“验证通过”。

### P1：数据等级是规则承诺，却不是调用边界

SKILL 和 checklist 都规定不能发送超过 lane 数据等级的内容；`invoke.py` 即使明确收到 `--contains code`、目标仅允许 `public`，仍只是输出 warning，随后读取并发送内容。没有提供 `--contains` 时更不会检查。[SKILL.md:41](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:41)；[checklist.ts:26](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/checklist.ts:26)；[invoke.py:222–253](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/invoke.py:222)

**后果：**模型一旦选错 lane，执行层不会阻止已声明的数据越界。这是确定的实现行为，不代表本次观察到了实际泄露。

**改法：**所有外部调用经过统一入口；要求声明内容等级，超限直接拒绝。自动判断内容等级可以不完美，但不能忽略调用者已经明确声明的超限事实。

### P2：同一策略有多份来源，优先级和配置路径已经分裂

SKILL 的 first-match 顺序先列 search、X、image、long-context、cheap draft，再列 deep/planner/coder；每轮 checklist 却明确把 deep/planner/coder 放在外部能力前面。相同任务可能被两份规则导向不同路径。[SKILL.md:20–43](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:20)；[checklist.ts:19–31](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/checklist.ts:19)

配置也不统一：bash 使用 `CLAUDE_CONFIG_DIR`，SKILL 要求读取 `~/.claude/spick.json`，mod 从 HOME 下固定路径读取 quota/lanes。[triage-hook.sh:15–18](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/triage-hook.sh:15)；[SKILL.md:16](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:16)；[register.tsx:54–68](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.tsx:54)

**改法：**用一个结构化策略源生成 SKILL 表格、snippet 和两种 checklist；配置快照携带路径、版本及 registry 是否存在。测试比较实际路由决策，不能只检查 bash 与 TS 的字符串一致。

### P2：“省钱”和“避免耗尽配额”没有可执行的决策标准

“选哪个文件”也必须先找 planner；effort 不确定就提高；quota 不设阈值，由小模型自行权衡。这些是保守升级规则，并非经过验证的成本策略。[SKILL.md:22、59、80](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:22)

**后果：**可能减少 Haiku 自行犯错，却增加转交上下文、串行等待、重复阅读和强模型额度消耗；当前不能量化净收益。

**改法：**允许 coder 自行作出局部、可逆、符合项目惯例的实现决定；仅把架构、外部接口和高风险权衡交给 planner。引入每任务调用预算、配额保留量和明确的失败升级策略，通过评测校准，而不是持续增加“必须升级”的规则。

## 3. 正确性缺陷

以下区分直接复现与静态确认；严重度针对实际影响。

### ① P1：当前这类 worktree 中的源码被 guard 全部排除——已复现

`isSourcePath()` 遇到路径任意位置的 `/.claude/` 就返回 false。当前仓库正位于 `.claude/worktrees/...`，因此正常源码的绝对路径也不计入修改额度和停止前检查。无扩展名的 `Dockerfile` 同样返回 false。[format.ts:87–91](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/format.ts:87)

**修复：**先转成仓库相对路径，只排除仓库内真正的 Claude 配置目录；用项目文件类型规则覆盖 Dockerfile 等文件。补上本仓库实际路径的回归用例。

### ② P1：没有执行检查也会标记为已检查——已复现

`echo pytest`、`grep pytest README.md`、`false && npm test` 都被 `isCheckCommand()` 判为 true。更关键的是，`checkRan` 在 Bash 执行前即置 true，既不看返回结果，也不要求检查发生在最后一次修改之后。[guard.ts:12–47](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/guard.ts:12)；[register.tsx:741–743](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.tsx:741)

此外，修改跟踪只挂在 Edit/Write/NotebookEdit 上，Bash 或外部 CLI 的写入不在这些拦截器覆盖范围。[register.tsx:776–793](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.tsx:776)

**修复：**记录实际检查执行结果，区分“尝试”“失败”“通过”；将结果关联到被检查的工作树版本，后续修改使其失效。至少用修改前后 diff 补充工具级修改记录。

### ③ P1：全部关闭的 lane 列表会恢复为默认推荐——已复现

`lanesFromCache('{"lanes":[]}')` 返回 null；checklist 又用数组是否非空判断 registry 是否存在，结果重新推荐 Gemini/Grok，并认为 Codex 可用。测试甚至断言空数组与未配置完全相同。[quotaline.ts:70–80](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/quotaline.ts:70)；[checklist.ts:88–96](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/checklist.ts:88)；[checklist.test.ts:188–190](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/checklist.test.ts:188)

**修复：**区分“没有 registry”“registry 存在但没有可用 lane”“缓存读取失败”。空集合必须保留为空。这里已确认的是错误推荐；不能据此断言 `invoke.py` 的 disabled 检查也失效。

### ④ P1：API 返回内容会被静默截断——已复现

`_text_of()` 对多个 text block 只返回第一个，输入 A、B 两段得到 A。OpenAI 的 `finish_reason=length` 也被忽略，非空残缺答案按成功处理；Anthropic 的 `stop_reason` 同样没有检查。[invoke.py:114–150、256–267](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/invoke.py:114)

**修复：**按顺序拼接全部文本块，解析停止原因；截断返回明确的 incomplete 状态，不能作为正常交付。增加多块输出、长度终止及非文本响应测试。

### ⑤ P2：dashboard 把旧配额重新读入的时间当作新鲜度——解析缺陷已复现

TS quota parser 不处理样本时间或 reset；过期的 Codex `resets_at` 仍返回使用比例。`readQuota()` 最后直接把 `readAt` 设为当前时间。Claude 的 `limits[]` 形式在此也解析不到，虽然 Python collector 已支持。[quota.ts:4–46、97–108](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/quota.ts:4)；[quota.py:121–165](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/quota.py:121)

**修复：**dashboard 与路由 checklist 共用规范化 quota cache，分别显示采样时间和读取时间；过期窗口不能继续表现为当前配额。

### ⑥ P2：一个加载 mod 的会话会静默其他会话的 bash checklist——静态确认

只要全局 `.spick-mod-active` 文件在 24 小时内，hook 就退出；判断没有 session ID，也不确认当前会话是否加载 mod。因此同一用户另开的无 mod 会话可能没有每轮清单，退出 mod 后也不会立即恢复。[triage-hook.sh:8–24](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/triage-hook.sh:8)；[register.tsx:285–289](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.tsx:285)

**修复：**使用会话级握手和明确生命周期；无法确认本会话已注入时，不应因其他会话的 marker 抑制 hook。本次未做多会话现场复现。

### ⑦ P2：安装中的关键失败仍可能报告 done——静态确认

安装脚本只有 `set -u`；读写 settings 的 Python 命令失败后没有显式退出，函数最后仍打印 done。例如损坏的 `settings.json` 会在 `json.load()` 失败，安装继续走到成功提示。[setup.sh:7](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/setup.sh:7)；[setup.sh:203–254](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/setup.sh:203)

**修复：**关键步骤检查返回码，安装前验证配置，失败返回非零并列出已经完成的变更；仅在安装后检查成功时报告 done。本次未运行安装或修改用户配置。

### ⑧ P3：带引号的 CLI model 被记录为占位符——已复现

`codex exec -m "some-model" ...` 的 model 被解析为 `"0"`。原因是先遮蔽引号字符串，再提取 model，却没有恢复它。[format.ts:64–77](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/format.ts:64)

**修复：**统一解析、恢复参数值，并测试带引号的 model、effort 和 lane；否则“实际使用什么模型”的审计信息不可信。

## 4. 提示词与规则设计

**有效之处，是将隐含要求变成可见步骤。** 每轮注入降低了对模型记住长文档的依赖；brief 明确包含 Goal、Inputs、Hard constraints、Done when；coder 被要求返回文件和检查输出；`Kept:` 为关键词误报提供了出口。这些设计有合理作用，但现有 smoke 只能说明少数样本能遵守，不能证明稳定有效。[triage-hook.sh:26–54](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/triage-hook.sh:26)；[SKILL.md:84–96](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:84)；[coder.md:13–18](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/assets/agents/coder.md:13)

主要问题有四个：

- **“识别交付物”仍然是语义判断。** “对比两个文件的行数”和“对比两个实现的可靠性”共享关键词，工作性质完全不同。Hint 扫描整个 prompt，不识别路径、引用或否定。本次复现：路径中的 `review-round` 命中 review；“不要分析，只把 why 翻译成中文”命中 judgement；“看看 X 上最近的讨论热度”没有 Hint。应把 Hint 降为候选信号，先排除路径/代码，再结合请求动词和预期产物判断。[triage_hint.py:48–70](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/scripts/triage_hint.py:48)；[hint.ts:9–60](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/hint.ts:9)
- **规则要求过多，且彼此拉扯。** “永不自行设计”甚至覆盖选文件；“不能判断难度”与自行选择 effort、quota、验收事实并存。建议缩短成几个可操作边界：直接查找、局部实现、架构决策、外部事实获取、高风险判断；让代理承担其职责范围内的细节。[SKILL.md:20–22、59–80、105](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:20)
- **输出协议不应牺牲证据。** 一方面要求 Report 包含测试、来源和不确定性，另一方面要求“only deliverable”、删除 production 说明、无额外内容。应明确“验证结果与实质限制属于交付物”，把风格清理与证据保留分开。[SKILL.md:92–108](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:92)
- **gate/guard 可以纠偏，但当前更容易奖励形式合规。** `Kept:`、`Unchecked:` 只识别行前缀，不验证理由；少于 400 字符且无工具的回复免于 gate；review 修复后固定不再复核。应允许显式豁免，但将其记录为“豁免/未验证”，不能混入成功率；修复是否需要复核应取决于风险和 diff。[gatelog.ts:9](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/gatelog.ts:9)；[guard.ts:73](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/guard.ts:73)；[register.tsx:821](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.tsx:821)；[SKILL.md:76](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/SKILL.md:76)

## 5. 评测与证据

**现有 evals 主要证明规则服从，不能证明端到端质量或经济性。**

14 个 eval 的主要预期是路由对象、effort、标签和是否保留在主会话。smoke 只运行三个，各一次，无 baseline；用 Haiku 子代理模拟主会话，手动提供 checklist，没有覆盖真实 UserPromptSubmit、gate、guard 或安装后的默认代理配置。[evals.json:3–17](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/evals/evals.json:3)；[smoke:3–27](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/evals/smoke-2026-10-16.md:3)

报告诚实记录了局限，这是优点。但其中“问时间”14.5 秒、93,648 main tokens，以及 verdict 未计 deep tokens，既不能直接当作实际部署成本，也不能用来证明节省。拟议的全量命令仍以子代理运行，不能替代真实主会话集成实验。[smoke:8–22、31–40](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/skills/spick/evals/smoke-2026-10-16.md:8)

成本记录也不完整：外部 CLI 的 tokens 为 0、cost 为 null，子代理内的 Bash CLI 在统计前返回；UI 的 total 汇总已知费用，不能理解为完整任务成本。[register.tsx:741–761](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.tsx:741)；[format.ts:316–324](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/format.ts:316)

可信评测至少应包含：

| 维度 | 建议 |
|---|---|
| 对照组 | Haiku 直接执行、Sonnet 直接执行、必要时 Opus 直接执行、spick skill-only、spick+mod；权限和输入相同 |
| 任务集 | 真实查找、局部修改、多文件缺陷、架构、研究判断、混合任务；加入路径关键词、否定句、全部禁用、配额过期、调用失败等边界 |
| 质量判定 | 代码用隐藏测试及缺陷审查；研究用事实与来源支持度；计划用可执行性和约束满足度。盲评，不以“调用了 deep”计质量成功 |
| 成本与体验 | 记录整个任务树的输入、输出、缓存、重试、外部调用、延迟、用户额外操作；区分 API 等价费用、实际付费和订阅额度消耗 |
| 统计设计 | 预先规定质量非劣界限与成本目标；每题多次运行，报告置信区间、失败尾部和各任务类别结果 |
| 集成与消融 | 在真实新主会话测试 hook/mod；分别移除 Hint、gate、guard、planner 强制规则，测其净收益；保留独立未见测试集 |

现有单元测试仍有价值，但部分是在锁定错误语义，例如空 lane 列表恢复默认、gate 消耗 guard 唯一机会。应先修订不变量，再增加测试数量。[checklist.test.ts:188–190](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/checklist.test.ts:188)；[register.test.ts:1156–1163](/Users/brulek/dev/spick/.claude/worktrees/review-round-1-b8e17b/mod/spick-dashboard/hooks/register.test.ts:1156)

## 6. 建议的优先级清单

按投入产出排序：

1. **修复静默丢内容：**拼接 API text blocks、识别截断和失败状态；补最小回归测试。
2. **兑现配置边界：**空 lane 集合不回退默认；明确数据超限直接拒绝。
3. **修复 guard 的基本真实性：**worktree 路径、检查命令误判、执行结果及最后一次修改后的有效性。
4. **统一路由策略源：**消除 SKILL/snippet/bash/mod 的顺序差异，统一配置目录和 registry 状态。
5. **统一 quota 数据源并修复全局 marker：**避免过期数据看似新鲜，以及不同会话互相静默。
6. **修订输出契约：**保留验证证据、限制和不确定性；明确失败升级，停止自动删除实质说明。
7. **让 gate 跟踪完成状态：**按任务所需角色记录成功、失败和验收；合并提示但独立保留未满足条件。
8. **补安装失败检测与真实主会话集成测试：**覆盖损坏配置、独立配置目录、多会话和工作树。
9. **完成任务树计量，再跑对照评测：**首先回答哪些任务真正省钱、哪些退化；据结果缩减 planner、Hint 和 effort 升级规则。
