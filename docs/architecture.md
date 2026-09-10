# Agent Harness 架构基线

状态：纵向 MVP 实现基线
需求来源：[REQUIREMENTS.md](../REQUIREMENTS.md)

## 1. 已冻结的产品决策

- Harness 采用 managed 模式控制关键阶段和完成门禁。
- 一个 Session 可以包含多个交叉进行的 Task。
- Turn 属于 Session，通过 `turn_task_links` 与 Task 建立多对多关系。
- Task 表示稳定目标；Trace 表示该目标的一次独立执行。
- Trace 内可记录递归 TaskNode 树；DFS/BFS 决定子任务遍历顺序，不改变 Task 的稳定目标语义。
- `/resume` 和崩溃恢复继续原 Trace；从头重跑、基线对照或更换初始环境创建新 Trace。
- Case、Experience 和 Skill 存入全局 Registry，但召回仍受适用范围、技术栈和安全策略过滤。
- 首个纵向场景是 TypeScript 项目中的可复现测试失败修复。
- Skill 满足确定性门禁后自动从 `testing` 晋升为 `completed`。
- 第一版使用 Bash 与 Git worktree；Linux、macOS 和 WSL2 为目标环境。
- 删除 Session 不级联删除 Trace、Case、Experience、Skill 或 Validation Run。

## 2. 系统边界

```text
User / CLI shortcuts
             |
             v
Harness Core
  |-- Lifecycle Controller
  |-- Event Ledger / Trace Projector
  |-- Result Evaluator / Policy Engine
  |-- Global Registries and Recall
  |-- TaskNode recursive traversal
  `-- Artifact Store
             |
             v
Claude Code
  |-- plugin hooks: 采集和关键工具门禁
  |-- harness MCP: 阶段转换、TaskNode、召回、结果提交
  `-- completed skill projection
             |
             v
Workers
  |-- Failure Case Curator
  |-- Experience Curator / Skill Generator
  `-- Validation Runner / Deterministic Graders
```

Harness 是用户入口和管理层，负责启动 Claude Code managed mode。Harness 不重写 Claude Code Agent Loop；普通模型推理和工具选择仍由 Claude Code 完成，Harness 负责阶段状态、完成条件、危险工具边界、TaskNode 递归遍历建议和 Skill 生命周期。

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

Turn 不直接置于 Task 层级下。`turn_task_links` 保存一个主 Task 和零到多个关联 Task。Step 和 Attempt 必须有唯一主 Task；跨任务影响通过 `relatedTaskIds` 表达。递归子任务不创建新的 Task，使用 Trace 内的 TaskNode 树表示；TaskNode 可以通过 DFS 或 BFS 策略选择下一个可执行节点。

## 4. 事件和投影

事件账本只追加。每个事件包含：

- Schema 版本、事件 ID、墙钟时间和记录时间。
- 完整作用域 ID、相关 Task、因果事件和关联 ID。
- 产生事件的 actor、adapter 版本和 policy 版本。
- 已脱敏 payload 或内容寻址的 artifact 引用。
- 前一事件哈希和当前事件哈希。

查询模型由投影器生成，包括 Session、Task、Task-Turn、Trace、Stage、Result、Case、Experience、Skill 与 Validation Run。各投影保存独立消费 offset，可由追加事件账本重放。

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

## 7. 已实现的纵向闭环

1. Claude Code Hook 和 MCP 形成 managed 生命周期，确定性 Result Evaluator 控制完成门禁。
2. 失败结果经 Curator、Schema、指纹去重和独立 worktree 复现进入 active Case。
3. 成功结果生成带作用域和证据的 usable Experience，再生成 `testing` Skill。
4. Validation Agent 对四类 active Case 各运行三次，先确认无 Skill 失败基线，再执行候选 Skill 和 solution Oracle。
5. Lifecycle Controller 只接受完整、通过的 Validation Report，将 Skill 自动晋升为 `completed`。
6. Recall Engine 仅暴露 usable Experience 和 completed Skill，并记录排序、预算和采用反馈。
7. completed Skill 连续两次高严重度生产失败后自动进入 `quarantined`，随即退出生产召回。

所有关键状态改变都由不可变事件驱动。Agent 提供不存在、越界或不满足策略的证据 ID 时，Lifecycle Controller 会拒绝转换。

## 8. 独立验证边界

Validation Runner 使用临时 Git worktree，继承的是白名单环境变量，不读取用户 Claude 登录。真实 Claude 验证使用单独的 `HARNESS_VALIDATION_API_KEY`，并以 `--bare` 模式运行；工具范围限制为读取、编辑、测试、构建、类型检查和 `git diff`。worktree 解决代码状态隔离，不等价于容器级 OS 隔离，因此网络和系统调用的更强硬隔离属于下一阶段。
