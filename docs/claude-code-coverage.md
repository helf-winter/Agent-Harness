# Claude Code 集成覆盖矩阵

状态：核心 Hook 与 MCP 已在 Claude Code 2.1.220 实机验证；供应商配置支持火山方舟和 DeepSeek 官方 Anthropic 兼容接口，真实模型连通性需在用户填写 API Key 后验证。

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
| Stage 转换 | Harness MCP | 已实现；Harness Agent 请求转换，Controller 校验转换图及证据作用域 |
| 测试证据 | Shell 工具结果 + Grader | 保存命令、退出码和结构化报告 |
| Skill 发现 | Harness 投影器 | 只投影 `completed` 版本到生产目录 |

## 降级原则

- capability 缺失时明确标记字段为 `unavailable` 或 `inferred`。
- 观察性采集失败不得阻断 Claude Code；危险操作门禁可按策略 fail-closed。
- 不读取 Claude Code 私有内部数据库作为稳定协议，只使用公开 Hook、CLI/SDK 输出和 Harness 自有事件。

## 2026-09-06 实机结论

- inline plugin 加载成功。
- Harness MCP 状态为 `connected`。
- 上下文、轻量 Note、Task、Observation、阶段转换和结果评价工具均进入 Claude Code 工具表。
- SessionStart、UserPromptSubmit、StopFailure 和 SessionEnd 事件成功写入事件账本。
- 当时的未登录错误被记录为 `authentication_failed`，哈希链验证通过。
- 用户环境中的第三方 ACE 插件存在独立的 `${ACE_ROOT}` Session Hook 路径问题；该错误不来自 Agent Harness。

## 2026-09-07 供应商迁移

- 淘汰旧的本地 `127.0.0.1:3456` 网关配置。
- 火山方舟 Claude Code 配置使用入口 `https://ark.cn-beijing.volces.com/api/coding/v3`。
- 方舟配置提供 `glm-5.3-flash`、`kimi-k2.7-code` 和 `kimi-k3` 三个启动档位。
- DeepSeek 使用官方 Anthropic 协议入口 `https://api.deepseek.com/anthropic`，提供 `deepseek-v4-flash` 和 `deepseek-v4-pro` 两个启动档位。
- API Key 不写入仓库；用户私有密钥文件权限固定为 `0600`。
