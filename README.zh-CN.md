# Spick

<p align="center"><img src="docs/images/hero.svg" alt="Spick 首图：coder 子代理工作时的仪表盘状态带" width="880"></p>

**Stop picking, just start.** Spick 是 Claude Code 的分诊层。它为每个任务选模型和推理强度，并把部分任务交给你已订阅的 CLI。

[English](README.md)

## 30 秒看懂

- 主会话（Haiku）读每条请求，只决定一次谁来做。
- 子代理（`coder`、`planner`、`deep`）用固定的模型。外部 CLI（Gemini、Grok、Codex）做各自擅长的事。
- 每次回复都标明谁做的，用标注行或状态带。

## 一条请求怎么走

```mermaid
flowchart TD
    IN["你的请求"]
    HOOK["清单钩子：计划模式？<br/>谁来做？有无通过检查？"]
    QUOTA["额度信息"]
    TRIAGE{"主会话（Haiku）<br/>只决定一次"}
    PLAN["计划模式：planner<br/>写方案，你批准"]
    GOAL["现成的 /goal"]
    SELF["Haiku 来做"]
    SUB["子代理<br/>coder · planner · deep"]
    CLI["外部 CLI<br/>Gemini · Grok · Codex"]
    NEXT["降级链下一个 CLI"]
    REV{"命中审核条件？"}
    CODEX["Codex 审核，<br/>修改一轮"]
    CHECK["主会话检查，<br/>不过关重做一次"]
    BAND{"状态带<br/>在显示吗？"}
    LABEL["标注行"]
    SHOWN["状态带显示谁做的"]

    IN --> HOOK --> TRIAGE
    QUOTA -.-> TRIAGE
    TRIAGE -->|"范围大、有风险或有歧义"| PLAN
    TRIAGE -->|"有明确的通过检查"| GOAL
    TRIAGE -->|"简单任务"| SELF
    TRIAGE -->|"写代码、做方案、难判断"| SUB
    TRIAGE -->|"搜索、X 数据、生图、长媒体"| CLI
    PLAN -->|"批准"| SUB
    CLI -.->|"不可用或额度用完"| NEXT
    SUB --> REV
    REV -->|"是"| CODEX --> CHECK
    REV -->|"否"| CHECK
    CLI --> CHECK
    SELF --> BAND
    CHECK --> BAND
    BAND -->|"否"| LABEL
    BAND -->|"是"| SHOWN
```

- 降级链：`skills/spick/references/providers.md`。审核条件：`skills/spick/SKILL.md`。
- 标注行：`[Model: Haiku 5.5 (medium) → coder Sonnet 5.5 (high) | Review: skipped]`

## 谁干什么

| 任务 | 谁来做 |
|---|---|
| 简单任务：问答、查文件、摘要 | 主会话（Haiku） |
| 改代码 | `coder` 子代理（Sonnet） |
| 规划设计 | `planner` 子代理（Opus） |
| 难推理、关键决策、正式写作 | `deep` 子代理（Opus） |
| 联网搜索、事实核查、长媒体 | Gemini（`agy`） |
| X / Twitter 数据 | Grok（`grok`） |
| 独立代码审核、生图 | Codex（`codex`） |

默认推理强度：`coder` medium，`planner` high，`deep` high。

## 仪表盘（可选）

![Spick 状态带的六种状态](docs/images/band-states.svg)

状态带是提示框上方的一行状态栏，显示谁在做事。

![Spick 面板](docs/images/pane.svg)

`/spick` 打开面板：带快捷键的开关和最近几轮。Haiku 每条请求读一行简短的额度信息，面板显示 Claude 与 Codex 的本机额度条。

## 安装

```bash
npx skills add Brulek/spick
```

然后在 Claude Code 里说 `spick setup`。它会探测已装的 CLI，装好三个子代理，并注册分诊清单钩子。

手动安装：

```bash
bash ~/.claude/skills/spick/scripts/setup.sh --check
bash ~/.claude/skills/spick/scripts/setup.sh --install --lanes gemini,grok,codex --model haiku --effort medium
```

桌面 app 里，在模型菜单选一次 Haiku。

### 仪表盘 Mod（可选）

在终端执行：

    /plugin install spick-dashboard --marketplace Brulek/spick

状态带显示时，回复没有标注行。

## 口令

| 说 | 效果 |
|---|---|
| `spick setup` | 首次引导 |
| `spick doctor` | 已装和已登录的 CLI |
| `spick quota` | 显示额度信息 |
| `/spick on\|off\|auto` | 分流开关 |
| `/spick review on\|off` | Codex 审核步骤 |
| `/spick lane <gemini\|grok\|codex> on\|off` | 单个外部 CLI |
| `/spick hide` / `show` | 状态带，仅本会话 |
| `/spick quota` | 刷新额度信息 |

面板快捷键：`r` 分流，`v` 审核，`g` `k` `c` 对应 Gemini / Grok / Codex，`b` 状态带，`q` 刷新额度，`x` 关闭。

## 要求

- Claude Code 2.1 或更新，bash 和 python3。
- 可选：已登录的 `codex`、`grok`、`agy`。

## 目录

`skills/spick/` 放规则。`mod/spick-dashboard/` 放状态带和面板。

## 搭配使用

[alexei-led/claude-router](https://github.com/alexei-led/claude-router) 逐轮切换主会话的模型，可以一起用。Spick 不做这件事，两者可以一起用。

## 已知限制

会话不能改自己的模型和强度，所以主会话用便宜的模型。

## 许可

MIT。
