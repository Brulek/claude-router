# claude-router

给 Claude Code 装一层统一分诊：决定用哪档 Claude 模型、什么推理强度，以及什么时候把活交给你已经订阅的其它 AI 命令行。

[English](README.md)

## 做什么

主会话用便宜的小模型（Haiku）跑，每条请求分诊一次：

| 任务 | 交给谁 |
|---|---|
| 日常杂活（问答、查文件、摘要、跑脚本） | 主会话自己 |
| 改代码 | `coder` 子代理，钉死 Sonnet |
| 规划设计 | `planner` 子代理，钉死 Opus |
| 高难推理、关键决策、正式写作 | `deep` 子代理，钉死 Opus |
| 联网搜索、事实核查、长视频音频、超长文档 | Gemini（`agy`，Antigravity CLI） |
| X / Twitter 数据 | Grok（`grok`，Grok Build） |
| 独立代码审核、生图 | Codex（`codex`，ChatGPT 订阅） |

每个被委派方还会按任务拿到一个推理强度。额度闸门只读各家 CLI 自己缓存在本地的用量（不依赖第三方工具），某家用到 80% 就沿降级链换下家。Codex 审核不是每次都做，而是按一张清单触发（碰钱碰权限碰定时任务、改动大、没测试、报告里带"不确定"）。每条回复末尾有一行标注，例如 `[Model: Haiku 5.5 → coder Sonnet 5.5 | Effort: High | Review: skipped]`，一眼看出这轮谁干的。

Claude 是工作的默认承担者，外家只在确实更强或更省的地方上。没装的 CLI 自动跳过；只装了 Claude 也能用，退化成纯 Claude 内部分层。

## 安装

```bash
npx skills add Brulek/claude-router
```

然后开一个 Claude Code 会话，说 `claude-router setup`。引导会探测装了哪些 CLI、登录没有，问你启用哪几家、主会话用什么模型，把三个子代理装进 `~/.claude/agents/`，往 `~/.claude/CLAUDE.md` 写一段速查表，并可选地把默认模型和推理强度写进 `~/.claude/settings.json`。

手动等价命令：

```bash
bash ~/.claude/skills/claude-router/scripts/setup.sh --check
bash ~/.claude/skills/claude-router/scripts/setup.sh --install --lanes gemini,grok,codex --model haiku --effort medium
```

桌面 app 用户：在输入框旁的模型菜单里选一次 Haiku。app 会记住自己的选择，并覆盖 `settings.json`。

## 口令

| 对 Claude 说 | 效果 |
|---|---|
| `claude-router setup` | 首次引导，可重复运行 |
| `claude-router doctor` | 探测表：装没装、登没登录、版本 |
| `claude-router quota` | Claude 与 Codex 的本地用量；Grok 与 Gemini 显示 unknown |

## 要求

- Claude Code 2.1 以上（子代理支持 `model` / `effort` frontmatter）。
- 两个脚本需要 bash 和 python3（Windows 用 Git Bash 或 WSL）。
- 可选：已登录订阅的 `codex`、`grok`、`agy`；生图需要 Claude Code 的 `codex-image` 插件。

## 目录

```
skills/claude-router/
├── SKILL.md                 分诊规则
├── references/providers.md  各家咒语、参数、模型名、额度来源、坑
├── references/onboarding.md 首次引导流程
├── scripts/quota.sh         本地额度读取
├── scripts/setup.sh         探测与安装
└── assets/                  子代理定义、CLAUDE.md 片段
```

## 已知限制

- Claude Code 会话不能改自己的模型和强度，只能给被委派方定价。所以主会话用便宜的，其余全部钉死。
- Grok 和 Gemini 本地查不到额度，这两条线靠"报配额错误即视为吃紧"。
- 云端 agent（Codex Cloud、ChatGPT agent mode、Grok 网页任务）不在范围内。

MIT 协议。
