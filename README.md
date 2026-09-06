# Agent Harness

基于 Claude Code 的研发流程 Harness。项目目标是把研发任务执行记录为可追溯 Trace，将失败沉淀为可复现 Case，将经过验证的成功模式演化为可自动验证、晋升和隔离的 Skill。

当前状态：M1 生命周期采集、投影和确定性结果评价已形成可运行闭环。

## 当前已实现

- Session、Task、Trace、Turn、Stage、Step 和 Attempt 的标识约束。
- Turn 与 Task 多对多关联的架构定义。
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
- 自动发现 TypeScript 项目的 typecheck、build 和 test 命令。
- 确定性 Result Evaluator；没有成功评价时不能进入 `COMPLETE`。

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
npm run typecheck
npm test
npm run build
npm run dev -- run
npm run dev -- trace list
```

## 主要文档

- [需求基线](./REQUIREMENTS.md)
- [架构基线](./docs/architecture.md)
- [Claude Code 集成覆盖矩阵](./docs/claude-code-coverage.md)
- [配置示例](./harness.example.yaml)

## 当前里程碑

下一步进入 M2：定义 Case Schema、Failure Case Curator 和 Git worktree Reproduction Runner，将失败 Trace 转换为第一个可复现 Case。

## 当前限制

- Claude Code CLI 必须先完成 `/login` 才能执行真实模型任务。
- Task 的语义分类由 Claude 通过 Harness MCP 完成，确定性投影和作用域检查由 Harness Core 完成。
- 第一阶段验证环境以 Bash 为基准；原生 PowerShell 仅用于本项目开发，不属于正式运行目标。
