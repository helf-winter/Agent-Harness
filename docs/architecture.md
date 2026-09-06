# Agent Harness 架构基线

状态：M0 初稿  
需求来源：[REQUIREMENTS.md](../REQUIREMENTS.md)

## 1. 已冻结的产品决策

- Harness 采用 managed 模式控制关键阶段和完成门禁。
- 一个 Session 可以包含多个交叉进行的 Task。
- Turn 属于 Session，通过 `turn_task_links` 与 Task 建立多对多关系。
- Task 表示稳定目标；Trace 表示该目标的一次独立执行。
- `/resume` 和崩溃恢复继续原 Trace；从头重跑、基线对照或更换初始环境创建新 Trace。
- Case、Experience 和 Skill 存入全局 Registry，但召回仍受适用范围、技术栈和安全策略过滤。
- 首个纵向场景是 TypeScript 项目中的可复现测试失败修复。
- Skill 满足确定性门禁后自动从 `testing` 晋升为 `completed`。
- 第一版使用 Bash 与 Git worktree；Linux、macOS 和 WSL2 为目标环境。
- 删除 Session 不级联删除 Trace、Case、Experience、Skill 或 Validation Run。

## 2. 系统边界

```text
Claude Code
  |-- plugin hooks: 采集和关键工具门禁
  |-- harness MCP: 阶段转换、召回、结果提交
  `-- completed skill projection
             |
             v
Harness Core
  |-- Lifecycle Controller
  |-- Event Ledger / Trace Projector
  |-- Result Evaluator / Policy Engine
  |-- Global Registries and Recall
  `-- Artifact Store
             |
             v
Workers
  |-- Failure Case Curator
  |-- Experience Curator / Skill Generator
  `-- Validation Runner / Deterministic Graders
```

Harness 不重写 Claude Code Agent Loop。普通模型和工具选择仍由 Claude Code 完成；Harness 只控制阶段状态、完成条件、危险工具边界和 Skill 生命周期。

## 3. 标识与关联

```text
runtimeInstanceId
`-- sessionId
    |-- turnId
    `-- taskId
        `-- traceId
            `-- stageId
                `-- stepId
                    `-- attemptId
                        |-- modelCallId
                        `-- toolCallId
```

Turn 不直接置于 Task 层级下。`turn_task_links` 保存一个主 Task 和零到多个关联 Task。Step 和 Attempt 必须有唯一主 Task；跨任务影响通过 `relatedTaskIds` 表达。

## 4. 事件和投影

事件账本只追加。每个事件包含：

- Schema 版本、事件 ID、墙钟时间和记录时间。
- 完整作用域 ID、相关 Task、因果事件和关联 ID。
- 产生事件的 actor、adapter 版本和 policy 版本。
- 已脱敏 payload 或内容寻址的 artifact 引用。
- 前一事件哈希和当前事件哈希。

查询模型由投影器生成。首批投影包括 Session、Task、Task-Turn、Trace、Stage 和 Result。Case、Experience、Skill 与 Validation Run 在后续里程碑加入。

重复消费使用 `eventId` 幂等；同一 ID 对应不同内容时视为数据损坏。

## 5. 数据安全

“原始事件”指采集后立即完成字段级脱敏、但尚未进行语义加工的事件。未脱敏内容不得先写入事件账本。

Session 删除采用非级联策略：删除 Session 元数据和原始对话后，事件及衍生资产保留不可反查的墓碑关联。该操作称为“删除会话记录”，不表示删除该会话产生的全部证据。

## 6. 自动晋升

MVP 中 Skill 自动晋升要求：

- development、validation、regression 和 holdout 必选 Case 全部通过。
- 每项运行三次且结果稳定。
- 确定性 Grader 全部通过。
- 没有新增回归、安全违规或未解释副作用。
- Validation Report 完整且证据可追溯。

申请白名单外危险工具的 Skill 不进入人工审批，而是直接验证失败。线上回归达到策略阈值后自动进入 `quarantined`。

## 7. M0/M1 交付顺序

1. 冻结事件信封、状态机和 ID 语义。
2. 建立追加事件账本、脱敏器、哈希链和幂等写入。
3. 建立 Claude Code capability/版本检查。
4. 实现 Session、Task、Trace 和 Stage 的基础投影。
5. 实现 Hook 到事件类型的覆盖矩阵和契约 Fixture。
6. 接入 managed runner 与 Harness MCP。
