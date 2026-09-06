# Agent Harness

基于 Claude Code 的研发流程 Harness。项目目标是把研发任务执行记录为可追溯 Trace，将失败沉淀为可复现 Case，将经过验证的成功模式演化为可自动验证、晋升和隔离的 Skill。

当前状态：M0/M1 基础协议与事件内核开发中。

## 当前已实现

- Session、Task、Trace、Turn、Stage、Step 和 Attempt 的标识约束。
- Turn 与 Task 多对多关联的架构定义。
- 确定性研发阶段状态机。
- 写入前字段及内联凭据脱敏。
- SQLite WAL 追加事件账本。
- 事件幂等写入、ID 冲突检测和哈希链校验。
- 数据库级事件更新和删除保护。
- Claude Code、Node、Git 与 Bash 环境诊断。

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
```

## 主要文档

- [需求基线](./REQUIREMENTS.md)
- [架构基线](./docs/architecture.md)
- [Claude Code 集成覆盖矩阵](./docs/claude-code-coverage.md)
- [配置示例](./harness.example.yaml)

## 当前里程碑

下一步是实现 Session/Task/Turn/Trace 投影、Claude Code Hook Fixture，以及由 `harness run` 启动的 managed runner。
