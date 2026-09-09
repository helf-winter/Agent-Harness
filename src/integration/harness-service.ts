import { createEventId } from "../domain/events.js";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { Stage } from "../domain/lifecycle.js";
import { discoverEvaluationPlan } from "../evaluation/command-discovery.js";
import { ResultEvaluator, type EvaluationReport } from "../evaluation/result-evaluator.js";
import { ExperienceStore } from "../experiences/experience-store.js";
import { LifecycleController } from "../lifecycle/controller.js";
import { ProjectionStore } from "../projections/projection-store.js";
import { RecallEngine, type RecallResult } from "../recall/recall-engine.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { EventLedger } from "../storage/event-ledger.js";
import { TaskTreeService } from "../task-tree/task-tree-service.js";
import { selectNextTaskNode } from "../task-tree/traversal.js";
import type {
  TaskNodeInput,
  TaskNodeProjection,
  TaskTreeProjection,
  TraversalStrategy,
} from "../task-tree/types.js";

export interface HarnessContext {
  runtimeInstanceId: string;
  sessionId: string;
  taskId: string;
  taskTitle: string;
  traceId: string;
  currentStage: Stage;
  currentStageId: string;
  turnId?: string;
  recentEvidence: Array<{ eventId: string; eventType: string; occurredAt: string }>;
}

export class HarnessService {
  readonly #ledger: EventLedger;
  readonly #projection: ProjectionStore;
  readonly #experiences: ExperienceStore;
  readonly #skills: SkillRegistry;
  readonly #recall: RecallEngine;

  constructor(
    databasePath: string,
    private readonly runtimeInstanceId: string,
  ) {
    this.#ledger = new EventLedger(databasePath);
    this.#projection = new ProjectionStore(databasePath);
    this.#experiences = new ExperienceStore(databasePath, this.#ledger, runtimeInstanceId);
    this.#skills = new SkillRegistry(databasePath, this.#ledger, runtimeInstanceId);
    this.#recall = new RecallEngine(
      this.#ledger,
      this.#experiences,
      this.#skills,
      runtimeInstanceId,
    );
    this.#projection.projectPending(this.#ledger);
  }

  getContext(): HarnessContext {
    this.#projection.projectPending(this.#ledger);
    const session = this.#projection.findActiveSessionForRuntime(this.runtimeInstanceId);
    if (!session) throw new Error("No active Harness Session exists for this runtime.");
    const task = this.#projection.getFocusedTask(session.sessionId);
    if (!task) throw new Error("No focused Task exists for this Session.");
    const trace = this.#projection.getActiveTrace(task.taskId);
    if (!trace) throw new Error("No active Trace exists for the focused Task.");
    const turn = this.#projection.getOpenTurn(session.sessionId);
    const evidence = this.#ledger
      .listTraceEvidence(trace.traceId, task.taskId, session.sessionId)
      .slice(-20)
      .map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
      }));

    return {
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: session.sessionId,
      taskId: task.taskId,
      taskTitle: task.title,
      traceId: trace.traceId,
      currentStage: trace.currentStage,
      currentStageId: trace.currentStageId,
      ...(turn ? { turnId: turn.turnId } : {}),
      recentEvidence: evidence,
    };
  }

  listTasks(): Array<{
    taskId: string;
    title: string;
    status: string;
    focused: boolean;
    currentStage?: Stage;
  }> {
    this.#projection.projectPending(this.#ledger);
    const session = this.#projection.findActiveSessionForRuntime(this.runtimeInstanceId);
    if (!session) throw new Error("No active Harness Session exists for this runtime.");
    const focused = this.#projection.getFocusedTask(session.sessionId);
    return this.#projection.listTasksForSession(session.sessionId).map((task) => {
      const trace = this.#projection.getActiveTraceForSessionTask(session.sessionId, task.taskId);
      return {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        focused: task.taskId === focused?.taskId,
        ...(trace ? { currentStage: trace.currentStage } : {}),
      };
    });
  }

  createAndFocusTask(title: string, reason: string): HarnessContext {
    if (!title.trim() || !reason.trim()) throw new Error("Task title and reason are required.");
    const current = this.getContext();
    if (!current.turnId) throw new Error("A Task can only be created during an active Turn.");
    const taskId = createEventId("task");
    const traceId = createEventId("trace");
    this.#ledger.append({
      eventType: EVENT_TYPES.TASK_CREATED,
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: current.sessionId,
      taskId,
      correlationId: taskId,
      actor: { type: "agent", id: "claude-code" },
      source: { adapter: "harness-mcp", adapterVersion: "0.1.0" },
      policyVersion: "default-1",
      payload: { title, reason },
    });
    const controller = this.#controller();
    controller.startTrace(
      { sessionId: current.sessionId, taskId, traceId },
      "First execution of a newly classified Task",
    );
    this.#ledger.append({
      eventType: EVENT_TYPES.TURN_LINKED_TO_TASK,
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: current.sessionId,
      taskId,
      relatedTaskIds: [current.taskId],
      traceId,
      turnId: current.turnId,
      correlationId: traceId,
      actor: { type: "agent", id: "claude-code" },
      source: { adapter: "harness-mcp", adapterVersion: "0.1.0" },
      policyVersion: "default-1",
      payload: { relation: "primary", confidence: 1, method: "agent-classification", reason },
    });
    this.#projection.projectPending(this.#ledger);
    return this.getContext();
  }

  focusTask(taskId: string, reason: string): HarnessContext {
    if (!reason.trim()) throw new Error("A focus reason is required.");
    const current = this.getContext();
    if (!current.turnId) throw new Error("Task focus can only change during an active Turn.");
    if (taskId === current.taskId) return current;
    const trace = this.#projection.getActiveTraceForSessionTask(current.sessionId, taskId);
    if (!trace) throw new Error("The requested Task is not active in this Session.");
    this.#ledger.append({
      eventType: EVENT_TYPES.TURN_LINKED_TO_TASK,
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: current.sessionId,
      taskId,
      relatedTaskIds: [current.taskId],
      traceId: trace.traceId,
      turnId: current.turnId,
      correlationId: trace.traceId,
      actor: { type: "agent", id: "claude-code" },
      source: { adapter: "harness-mcp", adapterVersion: "0.1.0" },
      policyVersion: "default-1",
      payload: { relation: "primary", confidence: 1, method: "agent-switch", reason },
    });
    this.#projection.projectPending(this.#ledger);
    return this.getContext();
  }

  recordObservation(summary: string, evidenceEventIds: string[]): { eventId: string } {
    if (!summary.trim()) throw new Error("Observation summary is required.");
    const context = this.getContext();
    const evidence = this.#ledger.getByIds(evidenceEventIds);
    if (evidence.length !== new Set(evidenceEventIds).size) {
      throw new Error("One or more evidence events do not exist.");
    }
    if (evidenceEventIds.length === 0) {
      throw new Error("At least one evidence event is required.");
    }
    if (
      evidence.some((event) => {
        const inTrace = event.traceId === context.traceId || event.correlationId === context.traceId;
        const atTaskScope = event.taskId === context.taskId && !event.traceId;
        const atSessionScope = event.sessionId === context.sessionId && !event.taskId;
        return !inTrace && !atTaskScope && !atSessionScope;
      })
    ) {
      throw new Error("Evidence belongs to a different Trace scope.");
    }
    const causationId = evidenceEventIds.at(-1);
    const result = this.#ledger.append({
      eventType: "observation.recorded",
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      traceId: context.traceId,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      stageId: context.currentStageId,
      correlationId: context.traceId,
      ...(causationId ? { causationId } : {}),
      actor: { type: "agent", id: "claude-code" },
      source: { adapter: "harness-mcp", adapterVersion: "0.1.0" },
      policyVersion: "default-1",
      payload: { summary, evidenceEventIds },
    });
    this.#projection.projectPending(this.#ledger);
    return { eventId: result.event.eventId };
  }

  transitionStage(
    to: Stage,
    reason: string,
    evidenceEventIds: string[],
  ): HarnessContext {
    const context = this.getContext();
    const controller = this.#controller();
    controller.transition({
      sessionId: context.sessionId,
      taskId: context.taskId,
      traceId: context.traceId,
      to,
      reason,
      evidenceEventIds,
    });
    this.#projection.projectPending(this.#ledger);
    return this.getContext();
  }

  getTaskTree(): TaskTreeProjection & {
    next: Record<TraversalStrategy, TaskNodeProjection | null>;
  } {
    const context = this.getContext();
    const tree = this.#projection.getTaskTree({ traceId: context.traceId });
    return {
      ...tree,
      next: {
        dfs: selectNextTaskNode(tree.nodes, "dfs"),
        bfs: selectNextTaskNode(tree.nodes, "bfs"),
      },
    };
  }

  createTaskNodeRoot(input: TaskNodeInput): TaskTreeProjection {
    const context = this.getContext();
    const existing = this.#projection.getTaskTree({ traceId: context.traceId });
    if (existing.root) throw new Error("The focused Trace already has a root TaskNode.");
    this.#taskTreeService(context).createRoot(input);
    this.#projection.projectPending(this.#ledger);
    return this.#projection.getTaskTree({ traceId: context.traceId });
  }

  decomposeTaskNode(nodeId: string, children: TaskNodeInput[]): TaskTreeProjection {
    const context = this.getContext();
    this.#assertFocusedNode(nodeId, context.traceId);
    this.#taskTreeService(context).decompose(nodeId, children);
    this.#projection.projectPending(this.#ledger);
    return this.#projection.getTaskTree({ traceId: context.traceId });
  }

  selectNextTaskNode(strategy: TraversalStrategy, reason: string): TaskNodeProjection | null {
    if (!reason.trim()) throw new Error("A selection reason is required.");
    const context = this.getContext();
    const tree = this.#projection.getTaskTree({ traceId: context.traceId });
    const node = selectNextTaskNode(tree.nodes, strategy);
    if (!node) return null;
    this.#taskTreeService(context).select(node.nodeId, reason);
    this.#projection.projectPending(this.#ledger);
    return this.#projection.getTaskNode(node.nodeId) ?? node;
  }

  startTaskNode(nodeId: string, reason: string): TaskTreeProjection {
    if (!reason.trim()) throw new Error("A start reason is required.");
    const context = this.getContext();
    this.#assertFocusedNode(nodeId, context.traceId);
    this.#taskTreeService(context).start(nodeId, reason);
    this.#projection.projectPending(this.#ledger);
    return this.#projection.getTaskTree({ traceId: context.traceId });
  }

  completeTaskNode(nodeId: string, resultSummary: string): TaskTreeProjection {
    if (!resultSummary.trim()) throw new Error("A result summary is required.");
    const context = this.getContext();
    this.#assertFocusedNode(nodeId, context.traceId);
    this.#taskTreeService(context).complete(nodeId, resultSummary);
    this.#projection.projectPending(this.#ledger);
    return this.#projection.getTaskTree({ traceId: context.traceId });
  }

  failTaskNode(nodeId: string, resultSummary: string): TaskTreeProjection {
    if (!resultSummary.trim()) throw new Error("A result summary is required.");
    const context = this.getContext();
    this.#assertFocusedNode(nodeId, context.traceId);
    this.#taskTreeService(context).fail(nodeId, resultSummary);
    this.#projection.projectPending(this.#ledger);
    return this.#projection.getTaskTree({ traceId: context.traceId });
  }

  pruneTaskNode(nodeId: string, resultSummary: string): TaskTreeProjection {
    if (!resultSummary.trim()) throw new Error("A result summary is required.");
    const context = this.getContext();
    this.#assertFocusedNode(nodeId, context.traceId);
    this.#taskTreeService(context).prune(nodeId, resultSummary);
    this.#projection.projectPending(this.#ledger);
    return this.#projection.getTaskTree({ traceId: context.traceId });
  }

  #controller(): LifecycleController {
    return new LifecycleController(this.#ledger, {
      runtimeInstanceId: this.runtimeInstanceId,
      actor: { type: "controller", id: "lifecycle-controller" },
      source: { adapter: "harness-mcp", adapterVersion: "0.1.0" },
      policyVersion: "default-1",
    });
  }

  #taskTreeService(context: HarnessContext): TaskTreeService {
    return new TaskTreeService(this.#ledger, {
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      traceId: context.traceId,
      actor: { type: "agent", id: "claude-code" },
      source: { adapter: "harness-mcp", adapterVersion: "0.1.0" },
      policyVersion: "default-1",
    });
  }

  #assertFocusedNode(nodeId: string, traceId: string): void {
    const node = this.#projection.getTaskNode(nodeId);
    if (!node) throw new Error(`TaskNode not found: ${nodeId}`);
    if (node.traceId !== traceId) throw new Error("TaskNode belongs to a different Trace scope.");
  }

  evaluateProject(projectDirectory: string): EvaluationReport {
    const context = this.getContext();
    if (context.currentStage !== "VERIFY" && context.currentStage !== "REVIEW") {
      throw new Error("Result evaluation is only allowed in VERIFY or REVIEW.");
    }
    const evaluator = new ResultEvaluator(this.#ledger, this.runtimeInstanceId);
    const report = evaluator.evaluate(context, discoverEvaluationPlan(projectDirectory));
    this.#projection.projectPending(this.#ledger);
    return report;
  }

  recall(input: {
    technologies: string[];
    errorContext?: string;
    tokenBudget: number;
    disabled?: boolean;
  }): RecallResult {
    const context = this.getContext();
    return this.#recall.recall(context, {
      taskType: "typescript-reproducible-test-repair",
      technologies: input.technologies,
      stage: context.currentStage,
      taskSummary: context.taskTitle,
      tokenBudget: input.tokenBudget,
      ...(input.errorContext ? { errorContext: input.errorContext } : {}),
      ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
    });
  }

  recordRecallFeedback(
    recallEventId: string,
    assetId: string,
    adopted: boolean,
    reason: string,
  ): { eventId: string } {
    const context = this.getContext();
    return {
      eventId: this.#recall.recordFeedback(
        context,
        recallEventId,
        assetId,
        adopted,
        reason,
      ),
    };
  }

  close(): void {
    this.#skills.close();
    this.#experiences.close();
    this.#projection.close();
    this.#ledger.close();
  }
}
