# Claude Code 集成覆盖矩阵

状态：待 M0 实机 Fixture 验证。

| Harness 证据 | 首选来源 | 处理方式 |
| --- | --- | --- |
| Session 创建/恢复 | `SessionStart` | 映射 Claude Session ID，区分 startup/resume |
| Session 结束 | `SessionEnd` | 记录原因，不自动等同 Task 完成 |
| Turn 开始 | `UserPromptSubmit` | 脱敏 Prompt，自动关联活动 Task |
| Turn 结束 | `Stop` / `StopFailure` | 记录最终消息摘要或 API 失败 |
| 工具请求 | `PreToolUse` | 记录脱敏输入；危险操作执行策略门禁 |
| 工具结果 | `PostToolUse` / `PostToolUseFailure` | 记录摘要、退出状态和 artifact 引用 |
| 权限 | `PermissionRequest` / `PermissionDenied` | 记录决定、原因和实际 policy 版本 |
| 文件变化 | Hook 事件及 Git Diff | Hook 仅作信号，Diff 由 Harness 独立采集 |
| 模型切换 | 模型切换事件或流式元数据 | capability 不足时降级为结果元数据 |
| 模型调用 | Claude 流式事件 | 仅保存模型、状态、Token、耗时等元数据 |
| Stage 转换 | Harness MCP | 不从自然语言或工具名称直接猜测 |
| 测试证据 | Shell 工具结果 + Grader | 保存命令、退出码和结构化报告 |
| Skill 发现 | Harness 投影器 | 只投影 `completed` 版本到生产目录 |

## 降级原则

- capability 缺失时明确标记字段为 `unavailable` 或 `inferred`。
- 观察性采集失败不得阻断 Claude Code；危险操作门禁可按策略 fail-closed。
- 不读取 Claude Code 私有内部数据库作为稳定协议，只使用公开 Hook、CLI/SDK 输出和 Harness 自有事件。
