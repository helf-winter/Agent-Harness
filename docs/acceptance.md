# Agent Harness 纵向 MVP 验收

## 一键离线验收

```bash
npm install
npm run doctor
npm run demo
npm run typecheck
npm test
npm run build
```

`npm run demo` 覆盖两个端到端场景：

1. 确定性失败 Trace 经过去重、独立 Git worktree 复现和自动策略晋升，形成 active Case。
2. 确定性成功 Trace 形成 usable Experience 和 testing Skill；testing Skill 不可被生产发现；Validation Agent 对 development、validation、regression、holdout Case 各执行三次无 Skill/有 Skill 配对验证；Controller 将通过者晋升为 completed；召回返回该 Skill；连续两次高严重度回归后 Skill 被自动 quarantined 并退出生产 Registry。

测试使用临时 Git 仓库和独立 worktree，不修改当前仓库内容，也不需要模型账号或网络。

## 真实 Claude Code 验收

```bash
npm run build
npm run dev -- run
```

主执行 Agent 使用用户已登录的 Claude Code。后台独立 Skill 验证不复用该登录；如需启用真实自动验证，单独提供短期、限额的验证凭据：

```bash
export HARNESS_VALIDATION_API_KEY=...
```

未提供验证凭据或四类 active Case 不完整时，系统保留 `testing` Skill 并记录未调度原因，不会降级绕过门禁。

## 安全断言

- 账本事件只追加，并由数据库触发器阻止更新和删除。
- 所有 payload 在持久化前脱敏，不保存底层模型完整请求/响应。
- 生产召回只读取 usable Experience 和 completed Skill。
- testing、quarantined、deprecated、rejected Skill 均不会导出到生产。
- Session 删除不级联删除 Trace、Case、Experience、Skill 或 Validation Run。
- Case 与 Validation 使用精确的临时 worktree 路径并在运行后清理。
