import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EVENT_TYPES } from "../domain/event-types.js";
import { createEventId, type CapturedEvent, type EventContext } from "../domain/events.js";
import { LifecycleController } from "../lifecycle/controller.js";
import { ProjectionStore } from "../projections/projection-store.js";
import { REDACTION_RULES_VERSION } from "../security/redactor.js";
import { EventLedger } from "../storage/event-ledger.js";
import {
  harnessDatabasePath,
  stableChildId,
  stableProjectId,
  stableSessionId,
} from "./paths.js";

export interface ClaudeHookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
  prompt?: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  error?: string;
  is_interrupt?: boolean;
  last_assistant_message?: string;
  [key: string]: unknown;
}

export interface HookProcessResult {
  appendedEvents: number;
  sessionId: string;
  taskId?: string;
  traceId?: string;
  turnId?: string;
}

export class HookProcessor {
  readonly #ledger: EventLedger;
  readonly #projection: ProjectionStore;
  readonly #runtimeInstanceId: string;
  readonly #projectId: string;
  readonly #adapterVersion: string;

  constructor(
    databasePath: string,
    options: { runtimeInstanceId: string; projectId: string; adapterVersion: string },
  ) {
    this.#ledger = new EventLedger(databasePath);
    this.#projection = new ProjectionStore(databasePath);
    this.#runtimeInstanceId = options.runtimeInstanceId;
    this.#projectId = options.projectId;
    this.#adapterVersion = options.adapterVersion;
  }

  process(input: ClaudeHookInput): HookProcessResult {
    if (!input.session_id || !input.hook_event_name || !input.cwd) {
      throw new Error("Hook input is missing session_id, hook_event_name, or cwd.");
    }

    const sessionId = stableSessionId(input.session_id);
    let appendedEvents = 0;
    if (!this.#projection.findSession(sessionId)) {
      this.#append({
        eventType:
          input.hook_event_name === "SessionStart" && input.source === "resume"
            ? EVENT_TYPES.SESSION_RESUMED
            : EVENT_TYPES.SESSION_STARTED,
        sessionId,
        correlationId: sessionId,
        payload: {
          claudeSessionId: input.session_id,
          projectId: this.#projectId,
          cwd: input.cwd,
          source: input.source ?? "recovered",
        },
      });
      appendedEvents += 1;
      this.#projection.projectPending(this.#ledger);
    }

    if (input.hook_event_name === "SessionStart") {
      if (appendedEvents === 0) {
        this.#append({
          eventType: input.source === "resume" ? EVENT_TYPES.SESSION_RESUMED : EVENT_TYPES.SESSION_STARTED,
          sessionId,
          correlationId: sessionId,
          payload: {
            claudeSessionId: input.session_id,
            projectId: this.#projectId,
            cwd: input.cwd,
            source: input.source ?? "startup",
          },
        });
        appendedEvents += 1;
      }
      this.#projection.projectPending(this.#ledger);
      return { appendedEvents, sessionId };
    }

    if (input.hook_event_name === "UserPromptSubmit") {
      const result = this.#startTurn(sessionId, input);
      this.#projection.projectPending(this.#ledger);
      return { appendedEvents: appendedEvents + result.appendedEvents, sessionId, ...result.scope };
    }

    const task = this.#projection.getFocusedTask(sessionId);
    const trace = task ? this.#projection.getActiveTrace(task.taskId) : undefined;
    const turn = this.#projection.getOpenTurn(sessionId);
    const scope: EventContext = {
      runtimeInstanceId: this.#runtimeInstanceId,
      sessionId,
      ...(task ? { taskId: task.taskId } : {}),
      ...(trace ? { traceId: trace.traceId, stageId: trace.currentStageId } : {}),
      ...(turn ? { turnId: turn.turnId } : {}),
    };

    const mapped = mapHookEvent(input, scope);
    if (mapped) {
      this.#ledger.append(mapped);
      appendedEvents += 1;
    }
    this.#projection.projectPending(this.#ledger);

    return {
      appendedEvents,
      sessionId,
      ...(task ? { taskId: task.taskId } : {}),
      ...(trace ? { traceId: trace.traceId } : {}),
      ...(turn ? { turnId: turn.turnId } : {}),
    };
  }

  #startTurn(
    sessionId: string,
    input: ClaudeHookInput,
  ): { appendedEvents: number; scope: { taskId: string; traceId: string; turnId: string } } {
    let task = this.#projection.getFocusedTask(sessionId);
    let trace = task ? this.#projection.getActiveTrace(task.taskId) : undefined;
    let appendedEvents = 0;
    const prompt = input.prompt ?? "";

    if (!task || !trace) {
      const taskId = createEventId("task");
      const traceId = createEventId("trace");
      this.#append({
        eventType: EVENT_TYPES.TASK_CREATED,
        sessionId,
        taskId,
        correlationId: taskId,
        payload: { title: promptPreview(prompt) || "Untitled Claude Code task" },
      });
      const controller = new LifecycleController(this.#ledger, {
        runtimeInstanceId: this.#runtimeInstanceId,
        actor: { type: "controller", id: "lifecycle-controller" },
        source: { adapter: "harness-core", adapterVersion: "0.1.0" },
        policyVersion: "default-1",
      });
      controller.startTrace({ sessionId, taskId, traceId }, "First execution of the task");
      appendedEvents += 2;
      this.#projection.projectPending(this.#ledger);
      task = this.#projection.getFocusedTask(sessionId) ?? {
        taskId,
        title: promptPreview(prompt),
        status: "active",
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      trace = this.#projection.getActiveTrace(taskId);
      if (!trace) throw new Error(`Failed to project new Trace ${traceId}`);
    }

    const turnId = createEventId("turn");
    this.#append({
      eventType: EVENT_TYPES.TURN_STARTED,
      sessionId,
      turnId,
      correlationId: trace.traceId,
      payload: {
        prompt,
        promptPreview: promptPreview(prompt),
      },
    });
    this.#append({
      eventType: EVENT_TYPES.TURN_LINKED_TO_TASK,
      sessionId,
      taskId: task.taskId,
      traceId: trace.traceId,
      turnId,
      correlationId: trace.traceId,
      payload: { relation: "primary", confidence: 1, method: "current-focus" },
    });
    appendedEvents += 2;
    return { appendedEvents, scope: { taskId: task.taskId, traceId: trace.traceId, turnId } };
  }

  #append(event: Omit<CapturedEvent, "runtimeInstanceId" | "actor" | "source" | "policyVersion">): void {
    this.#ledger.append({
      ...event,
      runtimeInstanceId: this.#runtimeInstanceId,
      actor: { type: "hook", id: "claude-code" },
      source: { adapter: "claude-code", adapterVersion: this.#adapterVersion },
      policyVersion: "default-1",
    });
  }

  close(): void {
    this.#projection.close();
    this.#ledger.close();
  }
}

function mapHookEvent(input: ClaudeHookInput, context: EventContext): CapturedEvent | undefined {
  const common = {
    ...context,
    eventId: createEventId(),
    correlationId: context.traceId ?? context.sessionId ?? context.runtimeInstanceId,
    actor: { type: "hook" as const, id: "claude-code" },
    source: {
      adapter: "claude-code",
      adapterVersion: process.env.HARNESS_CLAUDE_VERSION ?? "unknown",
    },
    policyVersion: "default-1",
  };

  switch (input.hook_event_name) {
    case "PreToolUse": {
      const toolUseId = input.tool_use_id ?? randomUUID();
      return {
        ...common,
        eventType: "tool.requested",
        ...toolScope(context, toolUseId),
        payload: { toolName: input.tool_name ?? "unknown", toolInput: input.tool_input ?? {} },
      };
    }
    case "PostToolUse": {
      const toolUseId = input.tool_use_id ?? randomUUID();
      return {
        ...common,
        eventType: "tool.completed",
        ...toolScope(context, toolUseId),
        payload: {
          toolName: input.tool_name ?? "unknown",
          toolInput: input.tool_input ?? {},
          toolResponse: input.tool_response ?? null,
        },
      };
    }
    case "PostToolUseFailure": {
      const toolUseId = input.tool_use_id ?? randomUUID();
      return {
        ...common,
        eventType: "tool.failed",
        ...toolScope(context, toolUseId),
        payload: {
          toolName: input.tool_name ?? "unknown",
          toolInput: input.tool_input ?? {},
          error: input.error ?? "unknown",
          interrupted: input.is_interrupt ?? false,
        },
      };
    }
    case "Stop":
      if (!context.turnId) return undefined;
      return {
        ...common,
        eventType: EVENT_TYPES.TURN_ENDED,
        payload: {
          failed: false,
          finalResponse: input.last_assistant_message ?? "",
        },
      };
    case "StopFailure":
      if (!context.turnId) return undefined;
      return {
        ...common,
        eventType: EVENT_TYPES.TURN_ENDED,
        payload: { failed: true, error: input.error ?? input.reason ?? "unknown" },
      };
    case "SessionEnd":
      return {
        ...common,
        eventType: EVENT_TYPES.SESSION_ENDED,
        payload: { reason: input.reason ?? "unknown" },
      };
    default:
      return {
        ...common,
        eventType: `claude.${normalizeEventName(input.hook_event_name)}`,
        payload: { hookEventName: input.hook_event_name },
      };
  }
}

function toolScope(context: EventContext, toolUseId: string): Partial<EventContext> {
  if (!context.stageId) return {};
  return {
    stepId: stableChildId("step", toolUseId),
    attemptId: stableChildId("attempt", toolUseId),
    toolCallId: toolUseId,
  };
}

function promptPreview(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 160);
}

function normalizeEventName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
}

export function processHookFromEnvironment(input: ClaudeHookInput): HookProcessResult {
  const databasePath = harnessDatabasePath();
  mkdirSync(dirname(databasePath), { recursive: true });
  const processor = new HookProcessor(databasePath, {
    runtimeInstanceId: process.env.HARNESS_RUNTIME_INSTANCE_ID ?? `runtime_${randomUUID()}`,
    projectId: process.env.HARNESS_PROJECT_ID ?? stableProjectId(input.cwd),
    adapterVersion: process.env.HARNESS_CLAUDE_VERSION ?? "unknown",
  });
  try {
    return processor.process(input);
  } finally {
    processor.close();
  }
}

export function recordHookFailure(error: unknown): void {
  const path = resolve(dirname(harnessDatabasePath()), "hook-errors.ndjson");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({
      at: new Date().toISOString(),
      rulesVersion: REDACTION_RULES_VERSION,
      error: error instanceof Error ? error.message : "Unknown hook error",
    })}\n`,
    "utf8",
  );
}
