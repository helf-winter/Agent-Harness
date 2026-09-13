import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { EVENT_TYPES } from "../domain/event-types.js";
import { createEventId, type CapturedEvent, type EventContext } from "../domain/events.js";
import type { Stage } from "../domain/lifecycle.js";
import { LifecycleController } from "../lifecycle/controller.js";
import { ProjectionStore } from "../projections/projection-store.js";
import type { TraceProjection } from "../projections/projection-store.js";
import { REDACTION_RULES_VERSION } from "../security/redactor.js";
import { EventLedger } from "../storage/event-ledger.js";
import {
  evaluateToolPolicy,
  type HarnessSafetyMode,
} from "./tool-policy.js";
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
  additionalContext?: string;
}

export class HookPolicyViolation extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "HookPolicyViolation";
  }
}

export class HookProcessor {
  readonly #ledger: EventLedger;
  readonly #projection: ProjectionStore;
  readonly #runtimeInstanceId: string;
  readonly #projectId: string;
  readonly #adapterVersion: string;
  readonly #safetyMode: HarnessSafetyMode;

  constructor(
    databasePath: string,
    options: {
      runtimeInstanceId: string;
      projectId: string;
      adapterVersion: string;
      safetyMode?: HarnessSafetyMode;
      controlMode?: HarnessSafetyMode;
    },
  ) {
    this.#ledger = new EventLedger(databasePath);
    this.#projection = new ProjectionStore(databasePath);
    this.#runtimeInstanceId = options.runtimeInstanceId;
    this.#projectId = options.projectId;
    this.#adapterVersion = options.adapterVersion;
    this.#safetyMode = options.safetyMode ?? options.controlMode ?? "audit";
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

    const policyDecision =
      input.hook_event_name === "PreToolUse"
        ? evaluateToolPolicy(
            input,
            trace ? { currentStage: trace.currentStage } : {},
            this.#safetyMode,
          )
        : undefined;
    const mapped = mapHookEvent(input, scope, policyDecision);
    if (mapped) {
      this.#ledger.append(mapped);
      appendedEvents += 1;
    }
    this.#projection.projectPending(this.#ledger);

    if (policyDecision && !policyDecision.allowed) {
      throw new HookPolicyViolation(policyDecision.reason);
    }

    let additionalContext: string | undefined;
    if (input.hook_event_name === "PostToolUse" && trace && mapped?.eventId) {
      additionalContext = this.#handlePostToolUse(input, trace, mapped.eventId);
      if (additionalContext) this.#projection.projectPending(this.#ledger);
    }

    if (input.hook_event_name === "Stop" && trace) {
      scheduleEvolution(trace.traceId, input.cwd);
    }

    return {
      appendedEvents,
      sessionId,
      ...(additionalContext ? { additionalContext } : {}),
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
      this.#append({
        eventType: EVENT_TYPES.TASK_NODE_CREATED,
        sessionId,
        taskId,
        traceId,
        correlationId: traceId,
        payload: {
          nodeId: stableChildId("task_node", traceId),
          title: promptPreview(prompt) || "Untitled Claude Code task",
          description: "Root recursive TaskNode automatically created for the Trace.",
        },
      });
      appendedEvents += 3;
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

  #handlePostToolUse(
    input: ClaudeHookInput,
    trace: TraceProjection,
    evidenceEventId: string,
  ): string | undefined {
    const toolName = input.tool_name ?? "";
    const rootComplete =
      this.#projection.getTaskTree({ traceId: trace.traceId }).root?.status === "completed";

    const targetStage = deriveStageFromTool(toolName, input.tool_input, rootComplete);
    if (targetStage && targetStage !== trace.currentStage) {
      new LifecycleController(this.#ledger, {
        runtimeInstanceId: this.#runtimeInstanceId,
        actor: { type: "controller", id: "lifecycle-controller" },
        source: { adapter: "harness-core", adapterVersion: "0.1.0" },
        policyVersion: "default-1",
      }).deriveStage({
        sessionId: trace.sessionId,
        taskId: trace.taskId,
        traceId: trace.traceId,
        to: targetStage,
        reason: `Auto-derived from ${toolName} tool behavior.`,
        evidenceEventIds: [evidenceEventId],
      });
    }

    const normalizedTool = toolName.split("__").at(-1) ?? toolName;
    if (normalizedTool === "harness_complete_task_node") {
      return this.#aggregationHint(trace.traceId, readNodeId(input.tool_input));
    }
    return undefined;
  }

  #aggregationHint(traceId: string, completedNodeId: string | undefined): string | undefined {
    if (!completedNodeId) return undefined;
    const tree = this.#projection.getTaskTree({ traceId });
    const node = tree.nodes.find((candidate) => candidate.nodeId === completedNodeId);
    if (!node?.parentNodeId) return undefined;
    const parent = tree.nodes.find((candidate) => candidate.nodeId === node.parentNodeId);
    if (!parent || parent.status === "completed") return undefined;
    const siblings = tree.nodes.filter((candidate) => candidate.parentNodeId === parent.nodeId);
    if (!siblings.every((sibling) => sibling.status === "completed" || sibling.status === "pruned")) {
      return undefined;
    }
    return [
      `TaskNode "${parent.title}" is ready to aggregate: all of its child nodes are resolved.`,
      `Call harness_complete_task_node with nodeId "${parent.nodeId}" and a result summary combining the children's results.`,
    ].join(" ");
  }

  close(): void {
    this.#projection.close();
    this.#ledger.close();
  }
}

function scheduleEvolution(traceId: string, repositoryDirectory: string): void {
  if (process.env.HARNESS_AUTO_EVOLVE === "0") return;
  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  if (!existsSync(cliPath) || !process.env.HARNESS_DB_PATH) return;
  const child = spawn(process.execPath, [cliPath, "evolve", traceId, repositoryDirectory], {
    cwd: repositoryDirectory,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

function mapHookEvent(
  input: ClaudeHookInput,
  context: EventContext,
  policyDecision?: ReturnType<typeof evaluateToolPolicy>,
): CapturedEvent | undefined {
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
        payload: {
          toolName: input.tool_name ?? "unknown",
          toolInput: input.tool_input ?? {},
          ...(policyDecision ? { policyDecision } : {}),
        },
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
          toolResponseSummary: summarizeHookValue(input.tool_response),
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
      const finalResponse = input.last_assistant_message ?? "";
      return {
        ...common,
        eventType: EVENT_TYPES.TURN_ENDED,
        payload: {
          failed: false,
          finalResponsePreview: promptPreview(finalResponse),
          finalResponseLength: finalResponse.length,
          finalResponseSha256: createHash("sha256").update(finalResponse).digest("hex"),
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

function summarizeHookValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length <= 4_000) return value;
  return {
    truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, 4_000),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

export function processHookFromEnvironment(input: ClaudeHookInput): HookProcessResult {
  const databasePath = harnessDatabasePath();
  mkdirSync(dirname(databasePath), { recursive: true });
  const processor = new HookProcessor(databasePath, {
    runtimeInstanceId: process.env.HARNESS_RUNTIME_INSTANCE_ID ?? `runtime_${randomUUID()}`,
    projectId: process.env.HARNESS_PROJECT_ID ?? stableProjectId(input.cwd),
    adapterVersion: process.env.HARNESS_CLAUDE_VERSION ?? "unknown",
    safetyMode:
      process.env.HARNESS_SAFETY_MODE === "enforce" || process.env.HARNESS_CONTROL_MODE === "enforce"
        ? "enforce"
        : "audit",
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

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const VERIFY_COMMAND_PATTERNS: readonly RegExp[] = [
  /\b(npm|yarn|pnpm|bun)\s+(run\s+)?(test|typecheck|check|lint|build)\b/i,
  /\b(tsc|eslint|pytest|jest|vitest|mocha|jasmine|ava|ruff|mypy|flake8)\b/,
  /\b(go\s+test|cargo\s+test|make\s+(test|check)|gradle\s+test|mvn\s+test)\b/i,
];

function deriveStageFromTool(
  toolName: string,
  toolInput: unknown,
  rootComplete: boolean,
): Stage | undefined {
  if (WRITE_TOOLS.has(toolName)) return "EXECUTE";
  if (toolName === "Bash" && rootComplete && isVerificationCommand(readCommand(toolInput))) {
    return "VERIFY";
  }
  return undefined;
}

function isVerificationCommand(command: string): boolean {
  if (!command) return false;
  return VERIFY_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function readCommand(toolInput: unknown): string {
  if (toolInput && typeof toolInput === "object" && "command" in toolInput) {
    const command = (toolInput as { command?: unknown }).command;
    return typeof command === "string" ? command : "";
  }
  return "";
}

function readNodeId(toolInput: unknown): string | undefined {
  if (toolInput && typeof toolInput === "object" && "nodeId" in toolInput) {
    const nodeId = (toolInput as { nodeId?: unknown }).nodeId;
    return typeof nodeId === "string" && nodeId ? nodeId : undefined;
  }
  return undefined;
}
