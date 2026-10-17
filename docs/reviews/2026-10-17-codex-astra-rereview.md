**不建议现在合并 main。** 阻塞项主要是：检查和 review 可误放行、委派记录漏计、禁用 lane 在冷启动时失效，以及 A/B 把失败或未知成本报告成成功或零成本。

下文区分：**已验证**＝源码确认或离线复现；**推断**＝实际运行中的可能后果，未连接真实 Claude 验证。路径简写：`S`＝`skills/spick/scripts`，`M`＝`mod/spick-dashboard/hooks`，`A`＝`skills/spick/evals/ab`。

执行结果：

| 要求的命令 | 实际结果 |
|---|---|
| `cd skills/spick/scripts && python3 -m unittest -q` | 运行 217 项，158 errors；归因复查为 149 个临时目录错误、9 个 `setUpClass` 权限错误，没有 assertion failure。**不能算通过。** |
| `python3 skills/spick/scripts/render_rules.py --check` | **通过，exit 0。** |
| `python3 -m unittest discover -s skills/spick/evals/ab -p 'test_*.py'` | 31 项：26 通过、2 errors、3 skipped。错误来自临时目录不可写；跳过项缺测试 venv。 |

上述测试受只读环境限制，涉及临时文件和本地 HTTPServer，不能把这些错误当作产品缺陷，也不能据此宣布回归通过。测试依赖见 [test_invoke.py:89](skills/spick/scripts/test_invoke.py#L89)、[test_grade.py:95](skills/spick/evals/ab/test_grade.py#L95)、[test_grade.py:117](skills/spick/evals/ab/test_grade.py#L117)、[test_report.py:46](skills/spick/evals/ab/test_report.py#L46)。另做了不落盘的 Python 函数测试和实际 TS handler 内存事件复现；未运行网络请求、登录 Claude 或真实 mod 集成。

**1．昨天的 8 个正确性缺陷和 3 个 P1 架构问题**

| 原问题 | 判定 | 已验证证据及剩余问题 |
|---|---|---|
| ① worktree 被 `.claude` 排除；漏掉 Dockerfile | **已修** | 改为相对项目路径判断，并覆盖 Dockerfile；当前 worktree 下 `src/a.ts` 和 Dockerfile 的函数测试均返回 source。见 [M/format.ts:97](mod/spick-dashboard/hooks/format.ts#L97)。 |
| ② 检查按名称、调用次数放行，无结果及最新修改绑定 | **部分** | 已记录完成结果和 edit counter；但复合 shell、作用域、进行中的修改仍可误通过，详见 N1。[M/register.tsx:378](mod/spick-dashboard/hooks/register.tsx#L378)、[M/register.tsx:888](mod/spick-dashboard/hooks/register.tsx#L888)。 |
| ③ 空 lane 列表回退默认外部服务 | **部分** | 显式空数组已保留；但 cache 缺失时仍回退默认服务，即使配置禁用了全部 lane，详见 N4。[M/quotaline.ts:77](mod/spick-dashboard/hooks/quotaline.ts#L77)、[M/checklist.ts:87](mod/spick-dashboard/hooks/checklist.ts#L87)。 |
| ④ 多文本块只取首块；截断仍成功 | **已修** | 文本块拼接；OpenAI length／Anthropic max_tokens 标记 incomplete，主入口退出码 7。函数级 stub 验证通过，未验证真实服务。[S/invoke.py:127](skills/spick/scripts/invoke.py#L127)、[S/invoke.py:174](skills/spick/scripts/invoke.py#L174)、[S/invoke.py:319](skills/spick/scripts/invoke.py#L319)。 |
| ⑤ quota 把读取时间当采样时间，忽略 reset／`limits[]` | **已修原缺陷** | 已解析 `limits[]`、reset、采样时间，展示使用 sampledAt。不过 mod 原始 quota 读取与 Python cache 仍是两条数据路径。[M/quota.ts:23](mod/spick-dashboard/hooks/quota.ts#L23)、[M/format.ts:445](mod/spick-dashboard/hooks/format.ts#L445)、[M/quota.ts:143](mod/spick-dashboard/hooks/quota.ts#L143)。 |
| ⑥ 全局 marker 静音其他 session | **已修** | mod 写 session marker，hook 按 session 查找并检查时效；源码闭环成立，未做真实多会话运行。[M/register.tsx:270](mod/spick-dashboard/hooks/register.tsx#L270)、[S/triage-hook.sh:23](skills/spick/scripts/triage-hook.sh#L23)。 |
| ⑦ setup 中间失败仍报 done | **已修** | 安装前校验 JSON，关键写入及 Python 步骤显式 `fail`，done 位于成功路径末尾。安装测试受环境限制，未实际安装。[S/setup.sh:195](skills/spick/scripts/setup.sh#L195)、[S/setup.sh:289](skills/spick/scripts/setup.sh#L289)、[S/setup.sh:322](skills/spick/scripts/setup.sh#L322)。 |
| ⑧ 带引号 model 被记成 `"0"` | **已修原缺陷** | model／effort 已恢复引号占位符，函数复现正确；相同错误仍出现在新增的 `--lane` 解析，见 N7。[M/format.ts:71](mod/spick-dashboard/hooks/format.ts#L71)。 |

| 原 P1 架构问题 | 判定 | 已验证证据及边界 |
|---|---|---|
| 小主模型承担最终质量裁决、弱 Evidence 校验、失败后接管 | **部分** | 已保留限制和 Evidence，约束复述及二次失败处理更明确；但“来源存在／测试输出通过”仍不足以验证结论成立。追踪表也把质量问题交给 A/B 测量，而当前 A/B 尚不足以支持质量结论。[SKILL.md:89](skills/spick/SKILL.md#L89)、[SKILL.md:105](skills/spick/SKILL.md#L105)、[traceability.md:33](docs/reviews/traceability.md#L33)。 |
| gate 把调用发生当角色完成，gate／guard 重复阻塞 | **部分** | 已按角色／状态判定，Stop 合并理由；但前台 Agent 仍可仅凭工具返回判 completed，CLI review 也可误认，见 N2。[M/gate.ts:31](mod/spick-dashboard/hooks/gate.ts#L31)、[M/register.tsx:933](mod/spick-dashboard/hooks/register.tsx#L933)、[M/register.tsx:795](mod/spick-dashboard/hooks/register.tsx#L795)。 |
| 数据级别只是提示，没有执行边界 | **部分** | `invoke.py` 默认 code，检查 prompt＋system 并拒绝超限；但内置外部 CLI 仍可直接调用，override 任意非空理由即可放行，仅打印 stderr，没有结构化审计字段。[S/invoke.py:154](skills/spick/scripts/invoke.py#L154)、[S/invoke.py:281](skills/spick/scripts/invoke.py#L281)、[SKILL.md:101](skills/spick/SKILL.md#L101)、[M/turnlog.ts:15](mod/spick-dashboard/hooks/turnlog.ts#L15)。 |

**2．规格评审的 8 条建议**

判定对象是[规格评审列出的八项](docs/reviews/2026-10-17-codex-astra-spec-review.md#L51)，并考虑设计 §13 修订。

| 建议 | 判定 | 证据 |
|---|---|---|
| 1. 隔离 arm，断言当前 checkout mod／gate／guard 生效 | **部分** | 有当前 checkout `--plugin-dir` 和插件禁用设置；仍继承全局环境，没有启动断言，缺 turn record 被接受为正常。[A/run.py:65](skills/spick/evals/ab/run.py#L65)、[A/run.py:132](skills/spick/evals/ab/run.py#L132)、[A/run.py:182](skills/spick/evals/ab/run.py#L182)。 |
| 2. 冻结生命周期、后台归属、成本和并发记录契约 | **部分** | 有 session 文件、schema、late 合并；嵌套委派和超时后完成仍漏记，见 N3。[M/paths.ts:49](mod/spick-dashboard/hooks/paths.ts#L49)、[M/turnlog.ts:112](mod/spick-dashboard/hooks/turnlog.ts#L112)、[S/spend.py:57](skills/spick/scripts/spend.py#L57)。 |
| 3. 成功角色交付＋workspace revision／scope 检查 | **部分** | 状态和 edit counter 已加入；没有检查作用域，编辑计数时点也不等于修改完成。前台完成仍存在返回值兜底。[M/register.tsx:380](mod/spick-dashboard/hooks/register.tsx#L380)、[M/register.tsx:481](mod/spick-dashboard/hooks/register.tsx#L481)、[M/register.tsx:799](mod/spick-dashboard/hooks/register.tsx#L799)。 |
| 4. 统一保守数据声明，覆盖 system，限定 override | **部分** | 保守默认和 system 检查落实；统一出口、override 授权约束及持久审计未闭合。[S/invoke.py:159](skills/spick/scripts/invoke.py#L159)、[S/invoke.py:168](skills/spick/scripts/invoke.py#L168)、[SKILL.md:101](skills/spick/SKILL.md#L101)。 |
| 5. 修复所有权重叠、共享接口优先、同步 headless 规则 | **部分** | headless proceed 已写入；§11 分工仍有重叠，追踪表以“合并无冲突”代替共享接口先行的证据。[SKILL.md:54](skills/spick/SKILL.md#L54)、[design.md:127](docs/superpowers/specs/2026-10-17-spick-v2-design.md#L127)、[traceability.md:42](docs/reviews/traceability.md#L42)。 |
| 6. 公平强模型基线、消融、完整成本、预注册非劣检验 | **部分** | 增加 free 基线、消融和成本／完成率报表；free arm 仍可能读入 spick 指令，未知成本处理错误；当前只提供探索性报告，未交付非劣检验。[A/common.py:21](skills/spick/evals/ab/common.py#L21)、[A/README.md:66](skills/spick/evals/ab/README.md#L66)、[A/report.py:53](skills/spick/evals/ab/report.py#L53)、[A/README.md:71](skills/spick/evals/ab/README.md#L71)。 |
| 7. 明确权限边界，以绕过及失败事件验收 | **部分** | Explore 提示词边界已明说，第二次失败立即提示升级；但 Explore 模型验收没有绑定角色，见 N6。[Explore.md:13](skills/spick/assets/agents/Explore.md#L13)、[M/register.tsx:875](mod/spick-dashboard/hooks/register.tsx#L875)、[A/grade.py:182](skills/spick/evals/ab/grade.py#L182)。 |
| 8. 真实委派／后台／升级／迁移／并发集成验收及追踪表 | **部分** | 追踪表和模拟事件测试已增加；提交的样例明确是未执行模型的 stub，不是实跑证据，§12 仍以 T1/T2 为主要运行验收。[traceability.md:38](docs/reviews/traceability.md#L38)、[A/samples/README.md:5](skills/spick/evals/ab/samples/README.md#L5)、[design.md:135](docs/superpowers/specs/2026-10-17-spick-v2-design.md#L135)。 |

**3．新代码中的缺陷、契约不一致与回归风险**

以下按严重度排序；其中 N1、N2、N4 是旧缺陷未彻底修复后留下的新路径。

**N1 — P1：未执行的检查、过期检查和局部检查均可覆盖整轮修改。**

- **已验证：** `checkOf("true || pytest")` 返回检查；整条 Bash 成功后被写为 `exitOk:true, coversTurn:true`，Stop 放行。`pytest; true`、`pytest | cat` 同样只看整体结果。解析仅排除检查后面的 `||`，不判断前面的控制流。[M/guard.ts:85](mod/spick-dashboard/hooks/guard.ts#L85)、[M/register.tsx:888](mod/spick-dashboard/hooks/register.tsx#L888)。
- **已验证：** edit counter 在 `next(Edit)` 前递增。内存事件复现中，让 Edit 尚未完成时跑测试，再完成 Edit，仍得到 `coversTurn:true`；此外 coversTurn 不比较测试目标与修改文件。[M/register.tsx:481](mod/spick-dashboard/hooks/register.tsx#L481)、[M/register.tsx:905](mod/spick-dashboard/hooks/register.tsx#L905)、[M/register.tsx:380](mod/spick-dashboard/hooks/register.tsx#L380)。
- **测试问题：** 测试把 `npm test ... | tail -5` 锁定为有效检查，但没有证明测试进程自身成功。[M/guard.test.ts:15](mod/spick-dashboard/hooks/guard.test.ts#L15)。

**N2 — P1：review／deep 完成状态仍可被工具返回值伪造。**

- **已验证：** `codex exec --help "review"`、`true || codex exec "review the diff"` 的成功 Bash 结果都会生成 completed review，并使 gate 放行；未实际运行 Codex。原因是 review 来自任意引号参数中的单词，完成来自整条 Bash 的结果。[M/format.ts:81](mod/spick-dashboard/hooks/format.ts#L81)、[M/register.tsx:896](mod/spick-dashboard/hooks/register.tsx#L896)。
- **已验证：** 前台 deep 没有 `agent.spawn`／`turn.complete` 事件，仅成功返回也会被记为 completed；这是对 §13“前台成功 turn.complete”的契约偏离。[M/register.tsx:795](mod/spick-dashboard/hooks/register.tsx#L795)、[design.md:142](docs/superpowers/specs/2026-10-17-spick-v2-design.md#L142)。
- **边界：** 真实 Claude 是否会产生缺少完成事件的成功返回，尚未验证。后台 RUNNING 可满足 gate 是 §13 明确允许的行为，本报告不将其列为缺陷。

**N3 — P1：持久日志遗漏嵌套委派，超时后也不能补记完成和费用。**

- **已验证：** 只有 `!e.agentId` 的 Agent／CLI 建立 delegate record。复现中嵌套 deep 出现在 dashboard totals，却不在 turn JSONL 中，`spend`／`audit` 因而读不到它。[M/register.tsx:781](mod/spick-dashboard/hooks/register.tsx#L781)、[M/register.tsx:849](mod/spick-dashboard/hooks/register.tsx#L849)、[M/register.tsx:980](mod/spick-dashboard/hooks/register.tsx#L980)、[S/spend.py:97](skills/spick/scripts/spend.py#L97)。
- **已验证：** timeout 调用 settle 后删除索引；后来完成无法找到 delegate，不能写 late。复现留下的唯一记录仍是 running，后续 usage 丢失。[M/register.tsx:538](mod/spick-dashboard/hooks/register.tsx#L538)、[M/register.tsx:598](mod/spick-dashboard/hooks/register.tsx#L598)、[M/register.tsx:993](mod/spick-dashboard/hooks/register.tsx#L993)。
- **推断：** 真实嵌套／长后台任务会造成成本低估、状态长期失真；发生频率尚未实测。

**N4 — P1：cache 缺失时，显式禁用 lane 的配置失效。**

- **已验证：** mod 从 quota cache 读取 lane 权限；读取失败返回 null，checklist 将 null 解释为默认内置服务。内存复现：配置禁用全部 lane、cache 不存在，仍推荐 Grok／Gemini／Codex。[M/register.tsx:72](mod/spick-dashboard/hooks/register.tsx#L72)、[M/checklist.ts:87](mod/spick-dashboard/hooks/checklist.ts#L87)。
- **推断：** 这可能诱导使用已禁用服务；本次只验证了错误推荐，未观察到实际外发。

**N5 — P1：A/B 无法证明测到的是目标机制，基线也未隔离。**

- **已验证：** `--plugin-dir` 只是启动参数；没有当前版本、gate、guard 的探针断言，缺少 turn record 仍接受。README 明确承认全局指令污染、旧 hook 干扰及插件加载关系未验证。[A/run.py:76](skills/spick/evals/ab/run.py#L76)、[A/run.py:132](skills/spick/evals/ab/run.py#L132)、[A/README.md:66](skills/spick/evals/ab/README.md#L66)。
- **推断：** 即使矩阵全部跑完，也可能比较的是旧安装、未加载 mod 或受 spick 指令影响的 free 基线，不能据此归因“v2 省钱且不降质”。

**N6 — P1：A/B 可将退出失败计为通过，将未知成本计为零，并误验收 Explore。**

- **已验证：** `meta.exit_code` 被保存却不进入 error 判断。构造 exit 1、正确答案、`is_error:false`，得到 pass。[A/run.py:128](skills/spick/evals/ab/run.py#L128)、[A/grade.py:190](skills/spick/evals/ab/grade.py#L190)。
- **已验证：** 成本全部为 None 时 `sum([])=0`；缺失委派记录也被当作没有外部调用。相同样本报 `cost_total=0`、`cost_per_success=0`、`cost_floor=false`。[A/report.py:53](skills/spick/evals/ab/report.py#L53)。
- **已验证：** “出现 Explore”＋“任意模型账单含 Haiku”就算 Explore Haiku。Haiku 主会话＋Sonnet Explore 同样满足；现有测试固定了这种未绑定角色的语义。[A/grade.py:182](skills/spick/evals/ab/grade.py#L182)、[A/test_grade.py:108](skills/spick/evals/ab/test_grade.py#L108)。

**N7 — P2：带引号的 registry lane 被记成 `"0"`，破坏 review 标签匹配。**

- **已验证：** `invoke.py --lane "reviewer" ...` 的 parseCli 输出 lane 为 `"0"`。model／effort 恢复占位符，lane 没恢复；随后无法匹配 registry 中的 review tag。[M/format.ts:71](mod/spick-dashboard/hooks/format.ts#L71)、[M/register.tsx:857](mod/spick-dashboard/hooks/register.tsx#L857)。

**N8 — P2：v2 升级版本标记与实际安装内容可能不一致。**

- **已验证：** 普通 setup 保留已有 agent 文件，已有 hook 即使指向另一 checkout 也不更新，却无条件写当前 `installed_version`。[S/setup.sh:203](skills/spick/scripts/setup.sh#L203)、[S/setup.sh:254](skills/spick/scripts/setup.sh#L254)、[S/setup.sh:280](skills/spick/scripts/setup.sh#L280)。
- **推断：** 用户按普通升级流程执行后，可能显示已安装 v2，实际继续使用旧 agent／旧 hook。本次未执行安装。
- **文档契约不符：** Python／mod 支持配置目录解析，但 SKILL 的首步仍硬编码 `~/.claude/spick.json`；自定义目录下会读错配置或误判未安装。[S/paths.py:49](skills/spick/scripts/paths.py#L49)、[M/paths.ts:24](mod/spick-dashboard/hooks/paths.ts#L24)、[SKILL.md:16](skills/spick/SKILL.md#L16)。

**4．合并前必须修复，按价值排序，最多 8 条**

1. **关闭检查误放行路径：** 验证实际执行的 runner 退出状态；保守处理复合 shell；绑定已完成修改及测试作用域。覆盖 N1 的三个反例。
2. **修正 gate 的交付证据：** 前台以成功 completion 事件为准；CLI review 必须确实执行并成功，不能由 help、短路分支或尾随成功命令满足。对应 N2。
3. **补全委派生命周期：** 持久记录完整父子委派关系；timeout 后保留可对账身份，后续完成仍可补写 usage／late。对应 N3。
4. **将配置作为 lane 启用状态的权威来源：** quota cache 缺失不能恢复默认授权；回归覆盖全部禁用＋冷 cache。对应 N4。
5. **使 A/B 启动可验收：** 隔离用户配置，断言当前 checkout 和各 arm 机制状态；不满足就判无效运行。补真实委派、后台和双失败的集成证据。对应 N5、建议 8。
6. **修复评测指标：** 非零退出失败；未知成本保持未知并报告覆盖率；Explore 模型绑定具体代理。对应 N6。
7. **闭合外部调用契约：** 修复 quoted lane；统一声明检查入口，override 保存授权依据与结构化审计记录。对应 N7、原 P1 数据边界。
8. **修复升级一致性：** 区分受管理旧文件与用户修改，更新旧 hook 路径，验证实际安装内容后再标版本；统一配置目录说明。对应 N8。

修复后仍需在允许临时文件和本地测试服务的环境重跑要求的测试。**当前能确认的是代码存在上述可复现缺口；尚不能确认该分支通过完整回归或真实 Claude 集成验收。**
