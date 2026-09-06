import { createEventId, type Actor, type EventSource } from "../domain/events.js";
import { EVENT_TYPES } from "../domain/event-types.js";
import { STAGES, decideTransition, type Stage } from "../domain/lifecycle.js";
import { EventLedger, type AppendResult } from "../storage/event-ledger.js";

export interface ControllerIdentity {
  runtimeInstanceId: string;
  actor: Actor;
  source: EventSource;
  policyVersion: string;
}

export interface TraceScope {
  sessionId: string;
  taskId: string;
  traceId: string;
}

export interface TraceState extends TraceScope {
  currentStage: Stage;
  currentStageId: string;
  suspendedStage?: Exclude<Stage, "HUMAN_REVIEW">;
}

export interface TransitionInput extends TraceScope {
  to: Stage;
  reason: string;
  evidenceEventIds: string[];
}

export class LifecycleController {
  constructor(
    private readonly ledger: EventLedger,
    private readonly identity: ControllerIdentity,
  ) {}

  startTrace(scope: TraceScope, reason: string): AppendResult {
    if (!reason.trim()) {
      throw new Error("A trace start reason is required.");
    }
    if (this.ledger.listByTrace(scope.traceId).length > 0) {
      throw new Error(`Trace already exists: ${scope.traceId}`);
    }

    const stageId = createEventId("stage");
    return this.ledger.append({
      eventType: EVENT_TYPES.TRACE_STARTED,
      ...scope,
      stageId,
      runtimeInstanceId: this.identity.runtimeInstanceId,
      correlationId: scope.traceId,
      actor: this.identity.actor,
      source: this.identity.source,
      policyVersion: this.identity.policyVersion,
      payload: {
        initialStage: "INTAKE",
        reason,
      },
    });
  }

  getTraceState(traceId: string): TraceState {
    const events = this.ledger.listByTrace(traceId);
    const start = events.find((event) => event.eventType === EVENT_TYPES.TRACE_STARTED);
    if (!start?.sessionId || !start.taskId || !start.traceId || !start.stageId) {
      throw new Error(`Trace not found or malformed: ${traceId}`);
    }

    const initialStage = start.payload.initialStage;
    if (initialStage !== "INTAKE") {
      throw new Error(`Unsupported initial stage for trace ${traceId}`);
    }

    let currentStage: Stage = initialStage;
    let currentStageId = start.stageId;
    let suspendedStage: Exclude<Stage, "HUMAN_REVIEW"> | undefined;

    for (const event of events) {
      if (event.eventType !== EVENT_TYPES.STAGE_TRANSITIONED) continue;
      const from = event.payload.from;
      const to = event.payload.to;
      if (from !== currentStage || !isStage(to) || !event.stageId) {
        throw new Error(`Invalid stage history at event ${event.eventId}`);
      }

      if (to === "HUMAN_REVIEW") {
        if (currentStage === "HUMAN_REVIEW") {
          throw new Error(`Nested HUMAN_REVIEW at event ${event.eventId}`);
        }
        suspendedStage = currentStage;
      } else if (currentStage === "HUMAN_REVIEW") {
        suspendedStage = undefined;
      }

      currentStage = to;
      currentStageId = event.stageId;
    }

    return {
      sessionId: start.sessionId,
      taskId: start.taskId,
      traceId: start.traceId,
      currentStage,
      currentStageId,
      ...(suspendedStage ? { suspendedStage } : {}),
    };
  }

  transition(input: TransitionInput): AppendResult {
    const state = this.getTraceState(input.traceId);
    if (state.sessionId !== input.sessionId || state.taskId !== input.taskId) {
      throw new Error("Trace scope does not match its original Session and Task.");
    }
    const evidence = this.ledger.getByIds(input.evidenceEventIds);
    if (evidence.length !== new Set(input.evidenceEventIds).size) {
      throw new Error("One or more evidence events do not exist.");
    }
    if (
      evidence.some(
        (event) => {
          const inTrace = event.traceId === input.traceId || event.correlationId === input.traceId;
          const atTaskScope = event.taskId === input.taskId && !event.traceId;
          const atSessionScope = event.sessionId === input.sessionId && !event.taskId;
          return !inTrace && !atTaskScope && !atSessionScope;
        },
      )
    ) {
      throw new Error("Evidence belongs to a different Trace scope.");
    }
    if (
      input.to === "COMPLETE" &&
      !evidence.some(
        (event) =>
          event.eventType === EVENT_TYPES.RESULT_EVALUATED && event.payload.outcome === "success",
      )
    ) {
      throw new Error("COMPLETE requires a successful Result Evaluator event.");
    }

    const decision = decideTransition({
      from: state.currentStage,
      to: input.to,
      reason: input.reason,
      evidenceEventIds: input.evidenceEventIds,
      ...(state.suspendedStage ? { resumeStage: state.suspendedStage } : {}),
    });
    if (!decision.allowed) {
      throw new Error(decision.reason);
    }

    const causationId = input.evidenceEventIds.at(-1);
    return this.ledger.append({
      eventType: EVENT_TYPES.STAGE_TRANSITIONED,
      sessionId: input.sessionId,
      taskId: input.taskId,
      traceId: input.traceId,
      stageId: createEventId("stage"),
      runtimeInstanceId: this.identity.runtimeInstanceId,
      correlationId: input.traceId,
      ...(causationId ? { causationId } : {}),
      actor: this.identity.actor,
      source: this.identity.source,
      policyVersion: this.identity.policyVersion,
      payload: {
        from: state.currentStage,
        to: input.to,
        reason: input.reason,
        evidenceEventIds: input.evidenceEventIds,
        previousStageId: state.currentStageId,
      },
    });
  }
}

function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}
