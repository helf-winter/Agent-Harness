# Agent Harness

基于 Claude Code 的研发流程 Harness。项目目标是把研发任务执行记录为可追溯 Trace，将失败沉淀为可复现 Case，将经过验证的成功模式演化为可自动验证、晋升和隔离的 Skill。

当前状态：首个 TypeScript 测试失败修复场景已形成端到端闭环；失败可沉淀为 Case，成功可演化为 Experience 和 Skill，Skill 经独立验证后自动晋升，并能在生产回归后自动隔离。

## 当前已实现

- Session、Task、Trace、Turn、Stage、Step 和 Attempt 的标识约束。
- Turn 与 Task 多对多关联的架构定义。
- Task 内递归 TaskNode 树、DFS/BFS 遍历选择和 CLI 查询。
- 确定性研发阶段状态机。
- 写入前字段及内联凭据脱敏。
- SQLite WAL 追加事件账本。
- 事件幂等写入、ID 冲突检测和哈希链校验。
- 数据库级事件更新和删除保护。
- Claude Code、Node、Git 与 Bash 环境诊断。
- Session、Task、Turn、Trace 的可重放查询投影。
- Claude Code Session、Prompt、工具和 Stop Hook Adapter。
- `harness run` 启动入口和 `harness trace` 查询命令。
- Harness MCP 上下文、Task 创建/切换、Observation 和阶段转换工具。
- Harness MCP 递归 TaskNode 创建、分解、DFS/BFS 选择和节点状态回写工具。
- 自动发现 TypeScript 项目的 typecheck、build 和 test 命令。
- 确定性 Result Evaluator；没有成功评价时不能进入 `COMPLETE`。
- 版本化 Failure Case Schema、指纹去重和全局 Case Registry。
- 仅接收确定性测试失败的 Failure Case Curator。
- 使用临时 Git worktree 和可选工作区补丁进行隔离复现。
- `raw → triaged → reproducible → approved → active` 自动晋升状态机。
- 复现记录与生命周期变更均写入不可变事件账本。
- 成功 Trace 的 Experience 提取、去重、证据关联和三态生命周期。
- 成功 Trace 中的递归 TaskNode 路径可沉淀进 Experience，并继续进入 Skill 策略。
- 版本化 Skill Schema、Claude Skill Markdown 投影和最小权限声明。
- `testing → completed → quarantined/deprecated` 生产过滤状态机。
- development、validation、regression、holdout 四类 Case 的独立验证。
- 每个 Case 三次隔离执行、无 Skill 失败基线和确定性 solution Oracle。
- Validation Report 的运行次数、耗时、Token、工具调用和证据关联。
- 任务、阶段和错误上下文召回，含 Token 预算、排序、冲突和采用反馈事件。
- completed Skill 连续两次高严重度失败后的自动隔离。
- Stop Hook 后台触发 Trace 演化；设置 `HARNESS_AUTO_EVOLVE=0` 可关闭。

## 环境要求

- Node.js 22+
- Claude Code 2.1.220+
- Git
- Bash
- Linux、macOS 或 WSL2；原生 PowerShell 不是第一阶段目标环境

## 开发命令

```bash
npm install
npm run doctor
npm run demo
npm run typecheck
npm test
npm run build
npm run dev -- run
npm run dev -- trace list
npm run dev -- task tree <task-id|trace-id>
npm run dev -- task node <node-id>
npm run dev -- case list
npm run dev -- case curate <trace-id>
npm run dev -- case reproduce <case-id>
npm run dev -- experience curate <trace-id>
npm run dev -- skill generate <experience-id>
npm run dev -- skill validate <skill-id>
npm run dev -- skill export <skill-id>
npm run dev -- evolve <trace-id>
```

## Claude Code 模型供应商

Claude Code 使用 Anthropic 协议，因此火山方舟在 Claude Code 中的 Base URL 是
`https://ark.cn-beijing.volces.com/api/coding`。带 `/v3` 的地址是 OpenAI 协议入口，
不能直接配置给 Claude Code。

先在 WSL Bash 中创建只属于当前用户的密钥文件：

```bash
mkdir -p ~/.config/agent-harness
cp config/claude-providers.env.example ~/.config/agent-harness/claude-providers.env
chmod 600 ~/.config/agent-harness/claude-providers.env
nano ~/.config/agent-harness/claude-providers.env
```

填入 `ARK_API_KEY` 和 `DEEPSEEK_API_KEY` 后，普通 `claude` 默认使用方舟
`glm-5.3-flash`。推荐用菜单选择供应商和模型：

```bash
npm run cc
```

菜单会显示完整模型名：

```text
1) glm   Volcano Ark / glm-5.3-flash
2) kimi  Volcano Ark / kimi-k2.7-code
3) ds    DeepSeek official / deepseek-v4-flash
4) dsp   DeepSeek official / deepseek-v4-pro
```

也可以用以下短命令直接进入指定模型：

```bash
npm run glm
npm run kimi
npm run ds
npm run dsp
```

对应关系为：`glm` 使用方舟 `glm-5.3-flash`，`kimi` 使用方舟
`kimi-k2.7-code`，`ds` 使用 DeepSeek `deepseek-v4-flash`，`dsp` 使用
DeepSeek `deepseek-v4-pro`。

如果想在任意目录直接输入 `cc`、`kimi`、`glm`、`ds`、`dsp`，可以安装本机 Bash
快捷命令：

```bash
bash scripts/install-claude-shortcuts.sh
```

安装后推荐只记一个命令：

```bash
cc
```

原来的完整命令仍然保留：

```bash
npm run claude:ark:glm
npm run claude:ark:kimi
npm run claude:deepseek:flash
npm run claude:deepseek:pro
```

方舟模型分别为 `glm-5.3-flash`、`kimi-k2.7-code`；DeepSeek 使用官方 Anthropic
兼容地址与当前模型 `deepseek-v4-flash`、`deepseek-v4-pro`。命令行环境变量优先于密钥文件。

独立 Skill 验证可使用相同供应商，但必须提供单独的隔离验证密钥：

```bash
export HARNESS_VALIDATION_BASE_URL=https://ark.cn-beijing.volces.com/api/coding
export HARNESS_VALIDATION_AUTH_TOKEN="$ARK_API_KEY"
export HARNESS_VALIDATION_MODEL=glm-5.3-flash
```

## 主要文档

- [需求基线](./REQUIREMENTS.md)
- [架构基线](./docs/architecture.md)
- [Claude Code 集成覆盖矩阵](./docs/claude-code-coverage.md)
- [配置示例](./harness.example.yaml)

## 当前里程碑

当前纵向 MVP 已完成。下一阶段应扩充真实、去相似的 holdout 数据集，接入后台队列，并开展多项目配对 Benchmark。

## 当前限制

- Claude Code CLI 执行真实模型任务前必须具备一种有效凭据：Anthropic 登录，或所选兼容供应商的 API Key。使用本项目的供应商启动命令时不需要再执行 `/login`。
- 独立 Skill 验证刻意不读取用户 Claude 登录或系统钥匙串；真实验证需单独设置仅用于隔离验证的 `HARNESS_VALIDATION_AUTH_TOKEN`。第三方供应商还需设置 `HARNESS_VALIDATION_BASE_URL` 和 `HARNESS_VALIDATION_MODEL`；旧的 `HARNESS_VALIDATION_API_KEY` 仍向后兼容。未设置时 Skill 保持 `testing`。
- Task 的语义分类由 Claude 通过 Harness MCP 完成，确定性投影和作用域检查由 Harness Core 完成。
- TaskNode 树已可通过 MCP 记录和查询；当前版本提供 DFS/BFS 下一节点建议，但不强制 Claude Code 调度。
- 第一阶段验证环境以 Bash 为基准；原生 PowerShell 仅用于本项目开发，不属于正式运行目标。
- Git worktree 隔离文件状态，但不是完整 OS/网络沙箱；验证器因此只开放读取、编辑和受限的 npm/git Bash 命令。高风险 Skill 会直接验证失败。
