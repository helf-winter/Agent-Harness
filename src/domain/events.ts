import { randomUUID } from "node:crypto";

export const EVENT_SCHEMA_VERSION = "1.0.0" as const;

export type ActorType =
  | "user"
  | "agent"
  | "controller"
  | "hook"
  | "worker"
  | "grader"
  | "system";

export interface Actor {
  type: ActorType;
  id: string;
}

export interface EventSource {
  adapter: string;
  adapterVersion: string;
}

export interface ArtifactRef {
  sha256: string;
  mediaType: string;
  size: number;
}

export interface RedactionMetadata {
  status: "applied" | "not_required";
  rulesVersion: string;
  redactedFields: string[];
}

export interface EventContext {
  runtimeInstanceId: string;
  sessionId?: string;
  taskId?: string;
  relatedTaskIds?: string[];
  traceId?: string;
  turnId?: string;
  stageId?: string;
  stepId?: string;
  attemptId?: string;
  modelCallId?: string;
  toolCallId?: string;
}

export interface EventEnvelope extends EventContext {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  eventId: string;
  eventType: string;
  occurredAt: string;
  recordedAt: string;
  causationId?: string;
  correlationId: string;
  actor: Actor;
  source: EventSource;
  policyVersion: string;
  redaction: RedactionMetadata;
  payload: Record<string, unknown>;
  artifactRefs?: ArtifactRef[];
}

export interface CapturedEvent extends EventContext {
  eventId?: string;
  eventType: string;
  occurredAt?: string;
  causationId?: string;
  correlationId: string;
  actor: Actor;
  source: EventSource;
  policyVersion: string;
  payload: Record<string, unknown>;
  artifactRefs?: ArtifactRef[];
}

export function createEventId(prefix = "evt"): string {
  return `${prefix}_${randomUUID()}`;
}

export function assertValidEventContext(context: EventContext): void {
  if (!context.runtimeInstanceId) {
    throw new Error("runtimeInstanceId is required");
  }

  if (context.taskId && !context.sessionId) {
    throw new Error("taskId requires sessionId");
  }
  if (context.traceId && !context.taskId) {
    throw new Error("traceId requires taskId");
  }
  if (context.stageId && !context.traceId) {
    throw new Error("stageId requires traceId");
  }
  if (context.stepId && !context.stageId) {
    throw new Error("stepId requires stageId");
  }
  if (context.attemptId && !context.stepId) {
    throw new Error("attemptId requires stepId");
  }
  if ((context.modelCallId || context.toolCallId) && !context.attemptId) {
    throw new Error("modelCallId and toolCallId require attemptId");
  }
  if (context.relatedTaskIds?.includes(context.taskId ?? "")) {
    throw new Error("relatedTaskIds must not repeat the primary taskId");
  }
}
