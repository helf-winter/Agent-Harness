import { randomUUID } from "node:crypto";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { Actor, CapturedEvent, EventSource } from "../domain/events.js";
import type { EventLedger } from "../storage/event-ledger.js";
import type { TaskNodeInput } from "./types.js";

export interface TaskTreeServiceContext {
  runtimeInstanceId: string;
  sessionId: string;
  taskId: string;
  traceId: string;
  actor: Actor;
  source: EventSource;
  policyVersion: string;
}

export class TaskTreeService {
  readonly #ledger: EventLedger;
  readonly #context: TaskTreeServiceContext;

  constructor(ledger: EventLedger, context: TaskTreeServiceContext) {
    this.#ledger = ledger;
    this.#context = context;
  }

  createRoot(input: TaskNodeInput): CapturedEvent {
    return this.#append(EVENT_TYPES.TASK_NODE_CREATED, {
      nodeId: input.nodeId ?? createTaskNodeId(),
      title: input.title,
      description: input.description,
      isAtomic: input.isAtomic === true,
    });
  }

  decompose(nodeId: string, children: TaskNodeInput[]): CapturedEvent {
    if (children.length === 0) throw new Error("At least one child TaskNode is required");
    return this.#append(EVENT_TYPES.TASK_NODE_DECOMPOSED, {
      nodeId,
      children: children.map((child) => ({
        nodeId: child.nodeId ?? createTaskNodeId(),
        title: child.title,
        description: child.description,
        isAtomic: child.isAtomic === true,
      })),
    });
  }

  select(nodeId: string, reason: string): CapturedEvent {
    return this.#append(EVENT_TYPES.TASK_NODE_SELECTED, { nodeId, reason });
  }

  start(nodeId: string, reason: string): CapturedEvent {
    return this.#append(EVENT_TYPES.TASK_NODE_STARTED, { nodeId, reason });
  }

  complete(nodeId: string, resultSummary: string): CapturedEvent {
    return this.#append(EVENT_TYPES.TASK_NODE_COMPLETED, { nodeId, resultSummary });
  }

  fail(nodeId: string, resultSummary: string): CapturedEvent {
    return this.#append(EVENT_TYPES.TASK_NODE_FAILED, { nodeId, resultSummary });
  }

  prune(nodeId: string, resultSummary: string): CapturedEvent {
    return this.#append(EVENT_TYPES.TASK_NODE_PRUNED, { nodeId, resultSummary });
  }

  #append(eventType: string, payload: Record<string, unknown>): CapturedEvent {
    const result = this.#ledger.append({
      ...this.#context,
      eventType,
      correlationId: this.#context.traceId,
      payload,
    });
    return result.event;
  }
}

function createTaskNodeId(): string {
  return `task_node_${randomUUID()}`;
}
