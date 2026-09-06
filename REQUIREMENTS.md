# Claude 研发流程 Harness 需求介绍

文档状态：Draft 0.1  
更新时间：2026-09-06  
适用阶段：需求确认与架构设计  

## 1. 文档目的

本文档描述一个独立的、基于 Claude Code 的研发流程 Harness 项目需求基线。项目正式名称待定。本文档用于：

- 统一产品目标、系统边界和核心术语。
- 指导后续架构设计、任务拆分与验收。
- 区分已经确认的需求、建议需求和暂不实现的能力。
- 为项目演示、Benchmark 和简历材料提供一致依据。

本文档不表示所有设计已经最终冻结。标记为“建议”的内容需要在原型或评审后确认。

## 2. 背景

Claude Code 已经提供模型交互、Agent Loop、会话管理、文件操作、终端命令和扩展机制，但通用 Agent 并不了解特定开发者或团队长期形成的研发方法，也缺少从真实任务中系统提取失败案例、经验和可验证 Skill 的完整闭环。

在实际研发中，任务失败、修复过程、测试证据和成功方法通常分散在会话记录、终端输出、代码差异和个人记忆中。它们很难被稳定复用，也难以回答某项能力从何而来、经过哪些验证、是否仍然可靠。

本项目将研究如何把实际研发过程抽象为可监控、可验证、可持续演化的 Agent 工作机制。项目直接构建在 Claude Code 扩展能力之上，不以模型网关、多模型路由或其他已有项目作为前置依赖。

## 3. 工作定位

本系统作为 Claude Code 上层的研发流程 Harness，负责观察和约束研发任务的执行过程，并将任务结果沉淀为可以继续利用的资产。

当前工作定位不是最终市场定义，但需要满足以下边界：

- Claude Code 继续负责基础 Agent Loop、模型交互和本地工具。
- 本系统负责生命周期标记、流程状态、执行证据、结果评价和能力演化。
- 失败执行可以形成结构化测试案例。
- 成功执行可以形成候选经验，并进一步生成候选 Skill。
- 新 Skill 必须经过独立验证，只有完成状态的 Skill 才能参与真实任务。
- 所有案例、经验、Skill 和验证结论都必须能够追溯到原始执行证据。

## 4. 已确认的核心需求

以下内容已经作为当前设计基线确认：

1. 对任务执行进行全生命周期标记和监控。
2. 保存模型调用、工具调用、文件差异、测试结果、错误和状态变化等执行证据。
3. 对失败结果进行识别，并由专用 Agent 整理失败链路。
4. 将适合复现的失败任务转换为标准测试案例。
5. 对案例进行分类、打标、去重、脱敏和测试集划分。
6. 从经过验证的成功链路中抽象候选经验和候选 Skill。
7. Skill 建立明确生命周期，新生成的 Skill 处于测试状态。
8. 开发独立的 Skill 测试 Agent，对测试状态 Skill 进行验证。
9. 只有完成状态的 Skill 才能被生产任务发现和调用。
10. 新任务可以按任务、阶段和错误上下文召回适用经验和正式 Skill。

## 5. 非目标

第一阶段明确不以以下内容为目标：

- 重写一个 Claude Code 替代品。
- 自行实现完整 IDE 或通用聊天客户端。
- 把模型切换或模型路由作为核心产品能力。
- 支持大量模型供应商和模型市场。
- 让 Agent 无审核地生成并发布生产 Skill。
- 把每一次失败都强制转换成测试案例。
- 把每一次成功都直接转换成正式 Skill。
- 保存未经脱敏的密钥、完整认证头或公司私有信息。
- 复制实习项目中的私有代码、提示词、数据或内部文档。

## 6. 用户与使用场景

### 6.1 主要用户

- 使用 Claude Code 完成日常研发任务的个人开发者。
- 希望固化团队研发方法和质量门禁的工程团队。
- 负责维护研发 Agent 能力、案例库和 Skill 的平台开发者。

### 6.2 核心场景

#### 场景 A：普通研发任务

用户通过 Claude Code 提交任务。本系统为任务创建生命周期标记，召回相关经验和正式 Skill，持续记录执行过程，并在任务结束后评价结果。

#### 场景 B：失败任务转测试案例

任务在计划、执行、工具调用或验证阶段失败。失败案例整理 Agent 分析 Trace，识别根因，生成可复现案例并完成分类和打标。通过质量检查的案例进入测试集。

#### 场景 C：成功任务形成候选 Skill

任务经过验证并成功完成。系统从完整成功链路中提取候选经验；多个相互支持的经验经过聚类和泛化后，可以生成测试状态的 Skill。

#### 场景 D：Skill 自动验证

Skill 测试 Agent 从案例库选择与候选 Skill 匹配的开发集、验证集、回归集和保留集，在隔离环境中执行测试，生成带证据的验证报告。

#### 场景 E：正式 Skill 参与新任务

Skill 通过质量门禁并进入完成状态后，才会注册到生产 Skill Registry。后续任务可以根据触发条件、项目环境和适用范围调用该 Skill。

#### 场景 F：正式 Skill 发生回归

正式 Skill 在真实任务中持续失败、产生危险副作用或性能明显退化时，系统将其隔离。隔离 Skill 不再参与新任务，修复后必须重新进入测试状态。

## 7. 总体业务链路

```text
用户任务
   |
   v
创建生命周期标记
   |
   v
初始上下文组装
   |-- 会话上下文
   |-- 项目知识
   |-- 适用经验
   `-- completed Skill
   |
   v
研发流程执行
需求理解 -> 计划 -> 执行 -> 验证 -> 审查 -> 结果
   |          |       |       |       |
   `----------全生命周期 Trace----------'
                          |
                          v
                       结果评价
                    /             \
                 失败               成功
                  |                  |
                  v                  v
       失败案例整理 Agent       经验提取与聚合
                  |                  |
        分类/打标/复现/Oracle         v
                  |             Skill Generator
                  v                  |
             Case Registry           v
                  |             testing Skill
                  |                  |
                  `-------> Skill Validation Agent
                                     |
                           选择隔离测试案例并执行
                                  /       \
                               通过         失败
                                |            |
                                v            v
                         completed Skill   修改/拒绝
                                |
                                v
                         参与新的真实任务
                                |
                                `------> 产生新 Trace
```

## 8. 概念与数据资产

### 8.1 Trace

一次任务执行的完整证据链。Trace 记录发生了什么，不负责证明某个结论正确。

### 8.2 Observation

阶段或步骤结束时形成的局部观察，包括执行动作、决策依据、结果和异常。Observation 尚未经过任务级验证，不能直接作为正式经验。

### 8.3 Case

从真实 Trace 整理出的标准任务案例。Case 必须包含输入、环境、可复现条件、期望结果和可执行或可审计的评价标准。

### 8.4 Knowledge

相对稳定的项目或领域事实，例如项目结构、编码规范、接口契约、构建命令和模块职责。

### 8.5 Experience

从一个或多个案例和 Trace 中提取的条件性结论，描述在什么环境和任务下，某种策略可能有效或无效。Experience 必须保留支持证据、反面证据、适用条件和置信度。

### 8.6 Skill

可被 Agent 发现并执行的程序化能力定义，至少包含触发条件、前置条件、步骤、工具约束、验证要求、失败策略、版本和状态。

### 8.7 Validation Run

Skill 测试 Agent 对指定 Skill 版本执行的一次独立验证。Validation Run 必须记录测试集版本、环境、结果、Token、耗时、失败详情和验证结论。

## 9. 全生命周期监控需求

### 9.1 标识层级

系统必须支持以下层级关系：

```text
runtimeInstanceId
`-- sessionId
    `-- taskId
        `-- turnId
            `-- stageId
                `-- stepId
                    `-- attemptId
                        |-- modelCallId
                        `-- toolCallId
```

### 9.2 标识要求

- 标识在所属作用域内必须唯一。
- 下级记录必须保存直接父级标识。
- 重试必须创建新的 `attemptId`，不得覆盖原尝试。
- 模型切换不得改变 `taskId` 和 `traceId`。
- Claude `/resume` 后应恢复原生 Claude Session 与 Harness Session 的绑定关系。
- Claude `/new` 或新建 Session 时，应创建新的 Harness Session 记录。

### 9.3 事件要求

事件日志必须追加写入，至少记录：

- 任务、阶段、步骤和尝试的开始与结束。
- 上下文召回请求及返回的资产 ID。
- 模型请求、完成、取消、超时和失败。
- 工具请求、审批、执行、完成和失败。
- 文件修改摘要与 Diff 引用。
- 测试命令、退出码和结果引用。
- 检查点创建、恢复和回退。
- 结果评价和状态变更。
- Case、Experience 和 Skill 的生成来源。
- Skill 验证、发布、隔离、替代和废弃。

### 9.4 证据不可变性

- 原始事件不得就地修改。
- 纠错通过新事件表达，并引用被纠正事件。
- Case、Experience 和 Skill 保存来源 Trace 与事件范围。
- 衍生资产删除后，原始脱敏 Trace 仍按保留策略保存。

## 10. 研发流程状态需求

建议的初始流程阶段如下：

```text
INTAKE -> RECALL -> PLAN -> EXECUTE -> VERIFY -> REVIEW -> COMPLETE
```

允许的主要回退路径：

```text
VERIFY  -> EXECUTE：实现存在可修复问题
VERIFY  -> PLAN：方案本身不成立
REVIEW  -> EXECUTE：审查发现实现缺陷
EXECUTE -> RECALL：出现新的错误或环境信息
任意阶段 -> HUMAN_REVIEW：缺少权限、需求歧义或风险过高
```

要求：

- 每个阶段定义输入、输出、完成条件和失败条件。
- 阶段切换必须写入事件，并记录切换理由。
- 未满足完成条件时不得仅凭模型声明进入下一阶段。
- 可由确定性程序验证的条件优先使用程序验证。
- 流程回退与运行恢复是两个不同机制，必须分别记录。

## 11. 结果评价需求

### 11.1 评价输入

- 用户目标与验收条件。
- 最终文件状态和 Diff。
- 构建、类型检查和测试结果。
- 工具执行结果。
- 阶段完成证据。
- 人工反馈或外部系统反馈。

### 11.2 评价结果

至少支持：

- `success`：目标和必要质量门禁均通过。
- `partial`：部分目标完成，但仍有明确缺口。
- `failure`：目标未完成或出现不可接受问题。
- `unknown`：缺少足够证据，不能可靠判断。

`partial` 和 `unknown` 不得作为成功 Skill 生成证据。

### 11.3 评价原则

- 测试、编译和结构化规则优先于模型主观判断。
- 模型评价必须保存使用的评价器版本和输入证据。
- 任务执行 Agent 不应作为唯一结果评价者。
- 对高风险变更保留人工确认入口。

## 12. 失败案例整理 Agent

### 12.1 职责

- 读取失败或部分失败任务的脱敏 Trace。
- 提取最小必要任务描述、环境和失败步骤。
- 区分表面错误与可能根因。
- 判断失败是否适合转换为测试案例。
- 生成复现步骤、环境夹具和评价 Oracle。
- 对案例进行分类、打标、去重和敏感信息检查。
- 向 Case Registry 提交候选案例和证据。

### 12.2 失败分类

至少支持：

- `capability`：推理、理解或实现错误。
- `workflow`：跳过必要步骤或错误阶段切换。
- `tool`：工具选择、参数、顺序或副作用错误。
- `infrastructure`：网络、限流、认证或服务不可用。
- `environment`：依赖、操作系统或运行环境差异。
- `requirement`：需求歧义或信息不足。
- `unknown`：暂无足够证据确定根因。

不同类型进入不同案例集合。基础设施错误主要用于恢复和降级测试，不应直接评价业务 Skill 的解决能力。

### 12.3 案例质量门禁

候选案例进入正式测试集前必须满足：

- 可以稳定复现，或明确标记为非确定性案例。
- 不依赖已经失效或不可获得的私有环境。
- 包含明确的预期结果或人工评价规范。
- 已完成密钥、用户数据、绝对私有路径和公司信息脱敏。
- 与现有案例不存在无法解释的重复。
- 能够定位到来源 Trace，但测试运行不依赖原始敏感内容。

### 12.4 Case 生命周期

```text
raw -> triaged -> reproducible -> approved -> active -> deprecated
```

只有 `active` Case 可以进入正式 Skill 验证。

### 12.5 测试集划分

- `development`：用于开发和修订 Skill。
- `validation`：用于阶段性验证候选 Skill。
- `regression`：用于防止历史问题重新出现。
- `holdout`：生成和修订阶段不可见，用于最终晋升验证。
- `resilience`：用于网络、鉴权、限流和进程中断等恢复能力验证。

同一问题的高度相似变体不得同时出现在生成数据和 `holdout` 中。

## 13. 经验提取与召回需求

### 13.1 提取时机

经验处理分为三个时机：

1. 阶段结束时只记录 Observation，不生成正式经验。
2. 任务经过结果评价后，从完整 Trace 中生成候选经验。
3. 累积多个候选经验后，进行聚类、去重、冲突检测和泛化。

### 13.2 正向与负向经验

- 成功任务可以产生正向经验。
- 失败任务可以产生负向经验和失败案例。
- 同一个任务可能同时产生多个正向和负向经验。
- 经验必须描述适用条件，不允许只保存脱离环境的结论。

### 13.3 Experience 内容

至少包括：

- 经验 ID 和版本。
- 来源 Trace、Case 和证据范围。
- 任务类型、项目类型和技术栈。
- 适用条件和不适用条件。
- 建议策略或应避免策略。
- 成功证据、失败证据和冲突证据。
- 置信度、使用次数和最后验证时间。
- 当前状态和替代关系。

### 13.4 召回时机

至少在以下时机执行召回：

- 任务开始时进行初始召回。
- 进入新的流程阶段时进行阶段召回。
- 工具、测试或模型调用失败时进行错误召回。
- 计划发生实质变化或出现新环境信息时重新召回。

### 13.5 召回约束

- 召回必须受 Token 预算限制。
- 优先返回适用范围明确、证据充分且近期有效的经验。
- 冲突经验必须同时暴露冲突关系，不得随机选择并隐藏另一方。
- 默认不把完整历史 Trace 注入模型。
- 生产任务只能使用允许状态的 Experience 和 `completed` Skill。

### 13.6 召回反馈

执行 Agent 必须记录：

- 召回了哪些 Experience 和 Skill。
- 是否实际采用。
- 采用在哪个阶段或步骤。
- 拒绝或忽略的原因。
- 应用后的任务结果。

反馈用于调整置信度、适用范围和后续召回排序，但不得覆盖原始证据。

## 14. Skill 生成需求

### 14.1 生成前提

Skill 不应由单次成功直接发布。生成候选 Skill 至少需要：

- 一个或多个经过结果验证的成功 Trace。
- 已抽象的候选或稳定 Experience。
- 明确的任务触发条件和适用范围。
- 可以执行的步骤和工具约束。
- 可以验证的完成条件。
- 明确的失败策略。

支持证据数量和最低置信度应配置化，不在初始文档中写死。

### 14.2 Skill 内容

至少包括：

- 名称、唯一 ID、版本和描述。
- 当前状态。
- 来源 Experience、Trace 和 Case。
- 触发条件与排除条件。
- 前置条件。
- 输入与输出契约。
- 执行步骤。
- 可用工具和权限要求。
- 质量门禁。
- 失败处理和人工介入条件。
- 适用技术栈和环境限制。
- 创建者、生成模型和生成时间。
- 测试结果和当前性能基线。

### 14.3 Skill 状态

```text
testing
   |-- 验证通过 -----------------> completed
   |-- 修订后 -------------------> testing
   `-- 不适合继续 ----------------> rejected

completed
   |-- 线上异常 -----------------> quarantined
   `-- 被新版本替代 -------------> deprecated

quarantined
   |-- 修复 ---------------------> testing
   `-- 放弃 ---------------------> rejected
```

要求：

- 新 Skill 首次持久化时状态必须是 `testing`。
- 只有 `completed` Skill 可以注册到生产环境。
- `testing` Skill 只能在隔离验证环境中使用。
- `quarantined`、`deprecated` 和 `rejected` Skill 不得参与新任务。
- 状态变化必须生成不可变事件并附带依据。
- Agent 只能提交状态变更建议，Lifecycle Controller 负责执行规则检查和状态更新。

## 15. Skill 测试 Agent

### 15.1 职责

- 查询处于 `testing` 状态的 Skill 版本。
- 根据 Skill 标签和适用范围从 Case Registry 选取案例。
- 在隔离工作区执行 Skill 和对照基线。
- 采集任务正确率、Token、耗时、工具调用和副作用。
- 生成结构化 Validation Report。
- 提交通过、修订或拒绝建议。
- 对 `completed` Skill 定期执行回归测试。

### 15.2 独立性要求

- 最终验证必须包含 Skill 生成过程不可见的 `holdout` Case。
- 验证结果不能只由生成 Skill 的同一个模型主观判定。
- 可程序化验证的目标必须由测试、规则或确定性 Grader 判定。
- 验证 Agent 不得直接修改生产 Skill 状态。
- 验证环境不得访问真实用户密钥和非必要项目数据。

### 15.3 验证维度

- 正确性：是否满足案例目标和 Oracle。
- 泛化性：是否能够处理未参与生成的案例。
- 安全性：是否发生越权、泄密或危险副作用。
- 稳定性：重复运行结果是否可接受。
- 效率性：Token、耗时和工具调用是否明显退化。
- 可解释性：关键步骤和失败原因是否能够追踪。

### 15.4 晋升要求

Lifecycle Controller 根据配置化门禁判断是否晋升，包括但不限于：

- 必选 Case 全部通过。
- `holdout` 达到最低成功率。
- 无高严重度安全问题。
- 无未解释的破坏性副作用。
- 相比无 Skill 基线没有超过上限的效率退化。
- Validation Report 完整并能追溯全部执行证据。

## 16. 生产 Skill 调用需求

- 生产 Registry 只暴露 `completed` Skill。
- Skill 选择必须检查触发条件、排除条件、技术栈、权限和版本兼容性。
- 同时匹配多个 Skill 时，应记录候选、排序分数和最终选择原因。
- 调用前应进行 Token 和上下文预算检查。
- 调用过程必须记录 Skill ID、版本、步骤和实际结果。
- 用户可以显式禁用 Skill 或要求不使用历史经验。
- 高风险 Skill 可以要求人工审批后才能执行工具。
- 正式 Skill 的真实运行结果必须反馈到回归与隔离机制。

## 17. 可观测性需求

### 17.1 Trace 查询

用户或开发者应能够按以下字段查询：

- Session、Task、Trace、Case、Experience、Skill 和 Validation Run ID。
- 时间、项目、模型、工具、结果和失败分类。
- Skill 状态和版本。
- Case 标签和测试集类型。

### 17.2 链路展示

系统应能够回答：

- 本次任务召回了哪些经验和 Skill。
- Agent 为什么采用或拒绝它们。
- 失败发生在哪个阶段、步骤和尝试。
- 哪个 Trace 生成了某个 Case 或 Skill。
- 某个 Skill 通过了哪些 Case 和 Validation Run。
- 某个正式 Skill 为什么被隔离或废弃。

### 17.3 指标

至少统计：

- 任务成功、失败、部分成功和未知比例。
- 各阶段失败率和平均重试次数。
- Case 生成率、复现率、去重率和审批通过率。
- Experience 召回率、采用率和采用后成功率。
- Skill 生成量、验证通过率、回归失败率和隔离率。
- 使用 Skill 与不使用 Skill 的正确率、Token、耗时和工具调用差异。

## 18. 安全与治理需求

- 所有 Trace、Case、Experience 和 Skill 写入前执行字段级脱敏。
- API Key、Authorization、Cookie 和访问令牌禁止进入模型上下文和资产库。
- 失败案例必须移除用户隐私、公司标识和不可公开代码。
- Skill 必须声明工具权限，默认使用最小权限。
- 破坏性工具操作必须支持审批、模拟或隔离环境。
- Skill 生成、验证、晋升和隔离必须保留审计记录。
- 用户必须能够删除指定 Session 及其可识别衍生资产。
- 引用删除源数据的衍生资产应重新检查是否仍可合法使用。

## 19. 配置需求

建议支持以下策略配置：

- 生命周期事件和内容记录级别。
- Trace、Case 和验证产物保留时间。
- Experience 召回数量和 Token 预算。
- Experience 稳定化所需证据门槛。
- Skill 生成门槛。
- Skill 验证案例数量、重复次数和通过标准。
- 是否要求人工审批 Skill 晋升。
- 高风险工具和项目目录限制。
- 自动隔离和回归测试策略。

所有策略变更必须版本化。Validation Run 和生产调用必须记录实际使用的策略版本。

## 20. 非功能需求

### 20.1 可靠性

- Harness 记录失败不得阻断 Claude Code 的基础使用。
- Agent 或验证进程崩溃后，不应破坏已持久化事件。
- 重复消费事件不得重复发布 Case 或 Skill。
- 工具副作用必须通过幂等控制和恢复机制保护。

### 20.2 性能

- 生命周期标记和结构化日志不应显著增加交互延迟。
- 经验召回应具有明确时间和 Token 上限。
- Skill 验证任务默认在后台或独立进程执行。
- 大型 Trace 应通过引用和摘要访问，不直接整体注入模型。

### 20.3 可扩展性

- Agent、资产存储、Grader 和召回器应通过明确接口解耦。
- Case 和 Skill Schema 必须版本化。
- 允许未来接入其他 Agent 客户端，但不作为第一阶段要求。
- Claude Code 集成必须通过适配层隔离，后续接入其他 Agent 客户端时不应重写核心资产模型。

### 20.4 可测试性

- 核心状态机和 Lifecycle Controller 必须支持确定性单元测试。
- Agent 输出必须经过 Schema 校验。
- 案例整理和 Skill 验证支持离线 Fixture。
- 关键链路必须支持故障注入和重放。

## 21. 主要系统组件建议

```text
Claude Code Integration
|-- Session Hook
|-- Lifecycle Hook
`-- Skill Exposure Adapter

Execution Observation
|-- Lifecycle Marker
|-- Event Ledger
|-- Trace Projector
`-- Result Evaluator

Knowledge Evolution
|-- Observation Extractor
|-- Experience Curator
|-- Experience Store
`-- Recall Engine

Case System
|-- Failure Case Curator Agent
|-- Case Normalizer
|-- Tagging and Deduplication
|-- Reproduction Runner
`-- Case Registry

Skill System
|-- Skill Generator
|-- Skill Registry
|-- Skill Validation Agent
|-- Validation Runner
`-- Lifecycle Controller

Governance and Evaluation
|-- Policy Store
|-- Deterministic Graders
|-- Audit Log
`-- Metrics and Benchmark
```

不要求每个组件都实现为独立进程或独立 Agent。确定性转换、状态更新、权限和门禁优先由普通程序完成；只有需要语义分析、归纳或复杂判断的环节使用 Agent。

## 22. MVP 范围

第一版 MVP 应形成一条真实可演示的纵向链路：

```text
Claude Code 执行任务
-> 生成完整 Trace
-> 一个失败任务形成 active Case
-> 一个成功任务形成 testing Skill
-> Skill Validation Agent 使用 Case 完成验证
-> Lifecycle Controller 将通过的 Skill 更新为 completed
-> 新任务成功召回并执行该 Skill
-> 展示完整来源和验证证据
```

MVP 必须具备：

- 生命周期标识和追加事件日志。
- 基础研发阶段状态。
- 结果评价接口。
- 失败 Case Schema、标签和 Registry。
- 一个可工作的失败案例整理 Agent。
- Experience 和 Skill Schema。
- Skill 状态机和生产过滤。
- 一个可工作的 Skill 测试 Agent。
- 至少一种确定性 Grader。
- 端到端 Trace 查询或报告。

MVP 可以暂缓：

- Web 管理界面。
- 多团队权限系统。
- 大规模向量检索。
- 自动生成复杂环境容器。
- 多 Agent 并发协作。
- 对所有编程语言的通用支持。
- 自动无人工审批地晋升高风险 Skill。

## 23. 分阶段开发计划

### M0：需求与协议冻结

- 确认术语、边界、状态和核心事件。
- 定义 Trace、Case、Experience、Skill、Validation Run Schema。
- 定义 Claude Code 集成边界和安全要求。

验收：核心 Schema 和状态转换通过设计评审。

### M1：生命周期与结果评价

- 实现 Session、Trace 和追加事件日志基础。
- 增加 Task、Stage、Step、Attempt 标识。
- 实现阶段事件和基础 Result Evaluator。
- 提供端到端 Trace 报告。

验收：任一测试任务可以还原完整阶段和工具链路。

### M2：失败案例系统

- 实现 Failure Case Curator Agent。
- 实现 Case Schema、Registry、标签和生命周期。
- 实现脱敏、去重、复现和测试集划分。
- 实现可复用的案例执行与 Benchmark Runner。

验收：真实失败 Trace 可以生成并复现一个 active Case。

### M3：经验系统

- 实现 Observation 和候选 Experience 提取。
- 实现 Experience 聚类、冲突关系和证据关联。
- 实现任务、阶段和错误触发的召回。
- 记录采用、拒绝和结果反馈。

验收：新任务能够召回相关经验，并能追踪经验的实际效果。

### M4：Skill 生成与生命周期

- 实现 Skill Generator 和 Skill Schema。
- 实现 testing、completed、quarantined、deprecated、rejected 状态。
- 实现 Lifecycle Controller 和生产 Registry 过滤。
- 建立 Skill 版本和来源关系。

验收：testing Skill 无法进入生产调用，completed Skill 可以被安全发现。

### M5：Skill 测试 Agent

- 实现案例选择和隔离 Validation Runner。
- 实现确定性 Grader、基线对照和验证报告。
- 实现 `holdout` 隔离和晋升门禁。
- 实现 completed Skill 回归测试和自动隔离建议。

验收：Skill 可以从 testing 经独立验证晋升为 completed，并在回归失败后被隔离。

### M6：效果评估与演示

- 建立有 Skill、无 Skill 的配对 Benchmark。
- 统计正确率、Token、耗时、工具调用和恢复情况。
- 制作失败转案例、成功转 Skill、Skill 晋升和线上隔离演示。
- 根据结果调整召回和晋升策略。

验收：所有项目结论均由可重复实验和可追溯数据支持。

## 24. MVP 验收场景

### 场景 1：失败形成案例

1. Claude Code 执行一个包含可复现缺陷的任务。
2. 验证阶段判定失败。
3. Failure Case Curator 生成带标签和 Oracle 的候选 Case。
4. Reproduction Runner 在隔离环境稳定复现。
5. Case 进入 `active` 状态和 `regression` 测试集。

### 场景 2：成功形成候选 Skill

1. 一个或多个相似任务成功完成并通过验证。
2. 系统生成候选 Experience。
3. Skill Generator 生成 `testing` Skill。
4. 生产 Registry 查询不到该 Skill。

### 场景 3：Skill 晋升

1. Skill Validation Agent 选择匹配 Case。
2. Skill 在开发集和验证集上完成修订。
3. Skill 在隔离的 `holdout` 上达到门禁。
4. Lifecycle Controller 将状态更新为 `completed`。
5. 后续真实任务可以召回该 Skill。

### 场景 4：Skill 隔离

1. completed Skill 在真实任务中连续产生高严重度失败。
2. 失败 Trace 形成回归 Case。
3. Lifecycle Controller 将 Skill 更新为 `quarantined`。
4. 新任务不再发现该 Skill。
5. 修复版本重新进入 `testing`。

## 25. 成功指标

第一阶段不预设系统必须节省 Token，而是用以下指标评价：

- Trace 完整率和父子标识关联正确率。
- 失败 Case 的可复现率和 Oracle 有效率。
- Experience 召回准确率、采用率和实际贡献率。
- testing Skill 的验证通过率和平均修订次数。
- completed Skill 相比无 Skill 基线的任务成功率变化。
- completed Skill 的回归率、隔离准确率和恢复时间。
- 用户定位一次失败所需时间变化。
- 敏感信息泄漏和未经授权的生产 Skill 调用次数，目标为零。

所有指标必须同时报告样本量、任务类型和测试集版本，避免只展示有利结果。

## 26. 风险与约束

### 26.1 错误经验污染

风险：模型从偶然成功中总结出错误经验。  
约束：保留候选状态、正反证据和多案例验证，不允许单次成功直接发布。

### 26.2 Skill 过拟合

风险：Skill 只会解决生成时见过的案例。  
约束：隔离 `holdout`、相似案例去重、基线对照和泛化测试。

### 26.3 自我评价偏差

风险：同一个 Agent 生成、测试并宣布自己的 Skill 成功。  
约束：生成、执行、评价和状态更新分离；优先使用确定性 Grader。

### 26.4 Agent 数量膨胀

风险：每个环节都拆成 Agent，增加成本和不确定性。  
约束：确定性处理使用普通代码，Agent 只处理语义整理、归纳和复杂判断。

### 26.5 数据安全

风险：真实 Trace 和失败案例包含私有代码或凭据。  
约束：采集最小化、写入前脱敏、隔离存储、保留策略和删除传播检查。

### 26.6 与 Claude Code 强耦合

风险：Claude Code Hook 或 Session 行为变化导致集成失效。  
约束：通过适配层隔离 Claude Code，保留契约测试和回滚路径。

## 27. 待确认问题

以下问题需要在实现前继续评审：

1. Experience 是否也需要完整状态机，还是先使用候选、可用和废弃三个状态。
2. Skill 晋升是否默认需要人工审批，以及哪些低风险 Skill 可以自动晋升。
3. 第一个 MVP 聚焦哪一种任务类型，例如 TypeScript 错误修复、测试失败修复或代码审查。
4. Case 复现环境使用 Git 工作树、目录快照还是容器。
5. 如何定义 Experience 和 Skill 的相似度、冲突和替代关系。
6. Skill 使用 Claude 原生 Skill 格式，还是维护独立 Schema 后生成 Claude Skill 投影。
7. Result Evaluator 在缺少自动化测试时如何组合规则、模型和人工评价。
8. 哪些运行内容默认采集，哪些必须由用户显式启用。
9. 项目正式名称、仓库位置和对外表述。

## 28. 简历与演示输出要求

项目展示必须基于已经实现并验证的能力，不使用规划中的功能作为完成成果。建议最终输出：

- 一张生命周期、案例和 Skill 演化架构图。
- 一次失败任务转为可复现测试案例的完整 Trace。
- 一次成功链路生成 testing Skill 的记录。
- 一份 Skill Validation Report。
- 一次 testing 到 completed 的状态变化审计记录。
- 一组有 Skill 与无 Skill 的配对 Benchmark。
- 一次 completed Skill 发生回归并被隔离的故障演示。

完成 MVP 后，可以基于真实数据形成简历描述：

> 基于 Claude Code 设计研发流程 Harness，通过全生命周期 Trace 将失败执行沉淀为可复现测试案例，将成功模式抽象为候选 Skill，并由独立验证 Agent 完成测试、晋升和回归隔离；构建可追溯的 Experience-to-Skill 能力演化闭环。
