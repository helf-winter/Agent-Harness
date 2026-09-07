import { spawnSync } from "node:child_process";
import { createEventId } from "../domain/events.js";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { ResultOutcome } from "../domain/lifecycle.js";
import type { HarnessContext } from "../integration/harness-service.js";
import { EventLedger } from "../storage/event-ledger.js";

export interface GraderCommand {
  id: string;
  command: string;
  args: string[];
  required: boolean;
  timeoutMs: number;
}

export interface EvaluationPlan {
  projectDirectory: string;
  commands: GraderCommand[];
}

export interface CommandResult {
  id: string;
  command: string;
  args: string[];
  required: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  evidenceEventId: string;
}

export interface EvaluationReport {
  outcome: ResultOutcome;
  reason: string;
  resultEventId: string;
  commands: CommandResult[];
}

export class ResultEvaluator {
  constructor(
    private readonly ledger: EventLedger,
    private readonly runtimeInstanceId: string,
  ) {}

  evaluate(context: HarnessContext, plan: EvaluationPlan): EvaluationReport {
    const results = plan.commands.map((command) => this.#runCommand(context, plan, command));
    const required = results.filter((result) => result.required);
    const outcome: ResultOutcome =
      required.length === 0
        ? "unknown"
        : required.every((result) => result.exitCode === 0 && !result.timedOut)
          ? "success"
          : "failure";
    const reason =
      outcome === "unknown"
        ? "No deterministic evaluation command was discovered."
        : outcome === "success"
          ? "All required deterministic graders passed."
          : "One or more required deterministic graders failed.";

    const result = this.ledger.append({
      eventType: EVENT_TYPES.RESULT_EVALUATED,
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      traceId: context.traceId,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      stageId: context.currentStageId,
      correlationId: context.traceId,
      ...(results.at(-1) ? { causationId: results.at(-1)!.evidenceEventId } : {}),
      actor: { type: "grader", id: "deterministic-result-evaluator" },
      source: { adapter: "harness-core", adapterVersion: "0.1.0" },
      policyVersion: "default-1",
      payload: {
        outcome,
        reason,
        commandEvidenceEventIds: results.map((item) => item.evidenceEventId),
      },
    });

    return { outcome, reason, resultEventId: result.event.eventId, commands: results };
  }

  #runCommand(
    context: HarnessContext,
    plan: EvaluationPlan,
    command: GraderCommand,
  ): CommandResult {
    const startedAt = performance.now();
    const child = spawnSync(command.command, command.args, {
      cwd: plan.projectDirectory,
      encoding: "utf8",
      shell: false,
      timeout: command.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: sanitizedEnvironment(),
    });
    const durationMs = Math.round(performance.now() - startedAt);
    const timedOut = (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const stdout = summarizeOutput(child.stdout ?? "");
    const stderr = summarizeOutput(child.stderr ?? child.error?.message ?? "");
    const stepId = createEventId("step");
    const evidence = this.ledger.append({
      eventType: "grader.completed",
      runtimeInstanceId: this.runtimeInstanceId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      traceId: context.traceId,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      stageId: context.currentStageId,
      stepId,
      attemptId: createEventId("attempt"),
      correlationId: context.traceId,
      actor: { type: "grader", id: command.id },
      source: { adapter: "harness-core", adapterVersion: "0.1.0" },
      policyVersion: "default-1",
      payload: {
        ...portableInvocation(command.command, command.args),
        required: command.required,
        exitCode: child.status,
        timedOut,
        durationMs,
        stdout,
        stderr,
      },
    });

    return {
      id: command.id,
      command: command.command,
      args: command.args,
      required: command.required,
      exitCode: child.status,
      timedOut,
      durationMs,
      stdout,
      stderr,
      evidenceEventId: evidence.event.eventId,
    };
  }
}

export function summarizeOutput(output: string): string {
  const limit = 32_000;
  return output.length <= limit ? output : `${output.slice(0, limit)}\n<TRUNCATED>`;
}

function portableInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (command !== process.execPath) return { command, args };
  if (args[0]?.replaceAll("\\", "/").endsWith("/npm/bin/npm-cli.js")) {
    return { command: "npm", args: args.slice(1) };
  }
  return { command: "node", args };
}

export function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "CI",
    "NODE_OPTIONS",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
}
