# 任务成功/失败 → Skill 与测试案例映射

> 承接「递归任务树执行系统」设计。本文定义任务树的两个终点——**成功**与**失败**——分别如何沉淀为可复用资产与确定性校验。

## 一、背景与目的

任务树（根 = 任务、子节点 = 子步骤、递归聚合到根）是执行本体。但执行完就结束，价值只留在当次。本文要回答：**执行的结果如何反哺未来**。

核心命题一句话：

- **成功 → 提炼 Skill（怎么做对的）+ 正向测试案例（证明能复现）**
- **失败 → 提炼 Experience（为什么错）+ 回归测试案例（防止再错）**

## 二、设计基础（本文依赖的部分）

| 概念 | 内容 |
|---|---|
| 树 | 根 = 任务；子节点 = 子步骤；叶子 = 最小可执行单元；结果递归聚合到根 |
| 卡片三形态 | 存储卡(rich) / 根卡(lean, 分类用) / 节点卡(子节点, 一句话) |
| 状态 | `pending / in_progress / completed / failed / pruned` 为软状态、可解冻；`deleted` 唯一终态 |
| 归属判定链 | 显式 id → focused 指针 → 相似度(对 open+近期候选集) → 新开 |
| 现有组件 | `harness_recall`（取回 Experience/Skill）、`harness_record_recall_feedback`（记录采纳与否）、`harness_record_note` / `harness_record_observation`、`harness_evaluate_project`（确定性 typecheck/build/test 评测） |

## 三、「成功」与「失败」的判定

**成功**——一个任务树的终点，需同时满足：

1. 根节点 `completed`，且 `result_summary` 是聚合后的完整答案；
2. `harness_evaluate_project` 的确定性评测通过（typecheck + build + test 全绿）。

**失败**——任一触发：

1. 某叶子 `fail`（死路）；
2. 根 `fail`（聚合不出有效答案）；
3. `harness_evaluate_project` 失败（编译/测试红）；
4. 节点被 `prune`（重复 / 不必要 / 被策略阻塞）。

## 四、成功 → Skill 映射

### 4.1 从成功里提炼什么

值得沉淀为 Skill 的是**可复用过程**，不是结果本身：

| 提取项 | 来源 | 说明 |
|---|---|---|
| 步骤序列 | 树的关键节点序列 | INTAKE→COMPLETE 的关键动作，去噪后保留主干 |
| 工具与权限 | 实际调用的工具清单 | 最小权限声明，只列实际用到的 |
| 决策点 / 分支条件 | decompose 的拆分依据 | 什么条件下拆成哪些子步骤 |
| 关键中间产物 | 各节点 result_summary | 每步的 concrete outcome |
| 失败分支 | 曾 fail/prune 的节点 | 顺手把「哪里会踩坑」也记进 Skill |

### 4.2 Skill 字段结构（对齐卡片思想）

- `id`：短、稳定、可精确回显（如 `skill-7a`）
- `标题`：给人看，可重命名
- `description`：过程摘要（场景 / 目的 / 约束 / 边界，≤500 字）
- `工具权限声明`：最小权限列表（默认最小，只列实际用到）
- `步骤`：主干节点序列（懒加载）
- `状态`：`active` / `deprecated`

### 4.3 成功时生成什么测试案例

- **正向测试**：把成功路径固化成确定性测试（编译通过 + 关键断言），证明「照着 Skill 做能复现成功」。
- **回归测试**：成功的输出作为基线，防止后续改动破坏。

### 4.4 触发时机

根 `completed` 且 `harness_evaluate_project` 通过后触发。**默认不自动写**——由模型判断「这次成功有没有可复用价值」，避免把一次性操作也固化成 Skill（噪声）。

## 五、失败 → Experience 与测试案例映射

### 5.1 从失败里提炼什么

| 提取项 | 说明 |
|---|---|
| 失败模式 | 属于哪类（死路 / 聚合失败 / 编译红 / 被阻塞） |
| 根因 | 为什么错，回溯到第一个偏离正确路径的节点 |
| 教训 | 下次怎么避免（一句话） |
| 红action 后现场 | 去掉隐私 / 公司身份 / 非公开代码后的可复现信息 |

### 5.2 失败时生成什么测试案例

- **回归测试**：把「触发该失败的输入」固化成测试，断言它不再红——这是失败最有价值的下游产物。
- **负向测试**：验证错误路径被正确拦截（如破坏性命令被拒、非法输入报错）。

### 5.3 触发时机

节点 `fail` / `prune` 时先记轻量 note；**根 `fail` 或 `harness_evaluate_project` 失败**时才提炼 Experience + 回归测试。避免每个小死路都沉淀成资产（噪声）。

## 六、映射总表

| 终点 | 判定 | → 资产 | → 测试案例 | 触发时机 |
|---|---|---|---|---|
| 根 completed + 评测过 | 成功 | Skill（过程 + 权限 + 决策点） | 正向 + 回归 | 评测通过后 |
| 叶子 fail / prune | 局部失败 | 轻量 note | 通常不 | 即时时 |
| 根 fail / 评测红 | 失败 | Experience（模式 + 根因 + 教训） | 回归 + 负向 | 根失败 / 评测红后 |

## 七、红action 与安全边界（贯穿全部）

- 所有 Trace / Case / Experience / Skill 落库前做**字段级红action**。
- 禁止 API key / Authorization / Cookie / access token 进入模型上下文与资产库。
- 失败案例必须移除用户隐私、公司身份、非公开代码。
- Skill 必须声明工具权限，最小权限默认。

## 八、与 harness 组件的对应

- 提取 Skill/Experience 后，`harness_recall` 在后续任务的 RECALL 阶段取回；`harness_record_recall_feedback` 记录采纳与否，形成「取回 → 采纳/拒绝 → 反馈」闭环。
- 测试案例挂到 `harness_evaluate_project` 的确定性评测，成为下一次 REVIEW / COMPLETE 的门槛。
- 成功/失败判定都源于树的状态（根 completed / 根 fail）与评测结果，与卡片状态、解冻机制同源。
