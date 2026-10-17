已执行指定两条 Git 命令，并核对指定源码及测试 diff。以下“已验证”指源码确认或离线函数复现；未运行完整测试套件或真实 Claude 集成。

路径缩写：`M`＝`mod/spick-dashboard/hooks`，`S`＝`skills/spick/scripts`，`A`＝`skills/spick/evals/ab`。

**1．逐项复核**

| 项目 | 判定 | 已验证证据 |
|---|---|---|
| N1 检查误放行 | **部分** | 已绑定完成修改及进行中修改，新增并发测试（`M/register.tsx:509,541,1007`；`M/register.test.ts:1369`）。但仍不判断检查范围，且新增重定向解析存在绕过，见下文（`M/register.tsx:388`；`M/guard.ts:79`）。 |
| N2 委派完成证据 | **部分** | CLI 增加单命令、help 排除和输出长度门槛（`M/register.tsx:978`；`M/gate.ts:50`）。前台 deep 仍仅凭非空工具返回标 completed，gate 不检查 `confirmedBy`；测试明确允许该路径（`M/register.tsx:910`；`M/gate.ts:48`；`M/register.test.ts:1015`）。 |
| N3 嵌套／超时日志 | **已修原缺陷** | 嵌套调用记录 parent 和所属主 turn；timeout 保留索引，迟到完成可补 usage／late，读取端按 delegate ID 合并（`M/register.tsx:638,649,1110`；`S/spend.py:94`）。已有嵌套及超时完成测试（`M/register.test.ts:1610,1646`）。 |
| N4 禁用 lane／冷缓存 | **部分** | 有 registry 时可从配置恢复启用状态；但**没有 `lane_registry`、只有旧 `lanes:false`** 时提前返回 `registry:false`，仍进入默认推荐；离线复现确认，测试也固定了此结果（`M/quotaline.ts:118`；`M/checklist.ts:89`；`M/quotaline.test.ts:95`）。配置也仍排在已有缓存之后（`M/register.tsx:81`）。 |
| N5 A/B 机制验收 | **部分** | 新增启动探针及失败中止，但只检查 schema 2 记录存在，没有验证加载版本或 gate／guard 行为（`A/run.py:103,145,155,274`）。仍继承用户环境，free 基线污染仅被声明，没有隔离（`A/run.py:261`；`A/report.py:119`）。 |
| N6 评测指标 | **部分** | 非零退出、缺失主成本、Explore 模型绑定已修，相关测试已补（`A/grade.py:231,276`；`A/report.py:35`；`A/test_grade.py:123`；`A/test_report.py:42`）。但委派记录缺失时，`outside_calls=None`／`unpriced_delegates=None` 仍按零处理；离线确认主成本 0.1 会显示为非下界（`A/report.py:32`）。 |
| N7 quoted lane | **已修** | lane 与 model 一样恢复引号占位符，并覆盖单双引号及 review tag 匹配（`M/format.ts:73,76`；`M/format.test.ts:38`；`M/register.test.ts:1076`）。 |
| N8 升级一致性 | **部分** | 旧 hook 路径更新、保留文件清单及配置目录说明已补（`S/setup.sh:291,349,355`；`skills/spick/SKILL.md:16`）。但旧 agent 仍原样保留并写入当前 `installed_version`，未区分受管理旧版与用户修改；测试明确保留该行为（`S/setup.sh:209,348`；`S/test_setup.py:396`）。 |
| 数据等级审计 | **部分** | invoke 已记录声明等级、推定发送等级、override、退出码和用量，audit 可列出 override（`S/invoke.py:317,379,393`；`S/audit.py:95`）。但写日志失败不改变调用结果，override 仍只要求非空理由，内置 CLI 仍可直调，尚未形成统一执行／授权边界（`S/invoke.py:282,315`；`skills/spick/SKILL.md:101`）。 |

**2．本轮新引入的问题**

1. **P1：重定向解析吞掉控制运算符，检查仍可误放行。**  
   **已验证：**实际加载当前 `guard.ts`，`checkOf('pytest >/dev/null||true')` 和 `checkOf('pytest >/dev/null;true')` 均非空；新正则的 `\S+` 把 `||true`／`;true` 当作重定向目标删除了（`M/guard.ts:79,111,117`）。**推断：**测试失败后整体 Bash 成功，会再次被算作检查通过（`M/register.tsx:1012`）。

2. **P2：200 字符门槛误拒绝有效短 review。**  
   **已验证：**completed review 的输出为 40 字符时，`roleDone` 返回 false；测试只验证长度边界（`M/gate.ts:27,50`；`M/gate.test.ts:19`）。**推断：**简短的“无发现”报告会触发不必要的再次委派，长度也不能证明 review 完成。

3. **P2：新探针结果会覆盖旧实验的来源信息。**  
   **已验证：**每次运行都覆盖全局 `_probe.json`，但已有 `result.json` 默认跳过；报告直接采用最新探针标记 verified（`A/run.py:175,183,270`；`A/report.py:130,135`）。**推断：**同一输出目录续跑时，旧 checkout 或未验证运行的结果可能被新探针“背书”；应把探针／版本绑定到每次 run。

**3．结论：现在不建议合并 main；至少须关闭 N1 重定向绕过、N2 工具返回兜底和 N4 禁用失效，并补齐 N5／N6 的实验有效性与缺失成本处理，不能只差一条来描述当前状态（上述对应源码位置）。**
