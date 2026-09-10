import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HookPolicyViolation,
  HookProcessor,
  type ClaudeHookInput,
} from "../src/integration/hook-processor.js";
import { HarnessService } from "../src/integration/harness-service.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`Unsafe test path: ${target}`);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function hookInput(hookEventName: string, extra: Partial<ClaudeHookInput> = {}): ClaudeHookInput {
  return {
    session_id: "claude-session-controlled",
    cwd: "/workspace/example",
    hook_event_name: hookEventName,
    ...extra,
  };
}

function controlledProcessor(databasePath: string): HookProcessor {
  return new HookProcessor(databasePath, {
    runtimeInstanceId: "runtime-controlled",
    projectId: "project-controlled",
    adapterVersion: "2.1.260",
    controlMode: "enforce",
  });
}

function startTrace(processor: HookProcessor): { taskId: string; traceId: string } {
  processor.process(hookInput("SessionStart", { source: "startup" }));
  const turn = processor.process(
    hookInput("UserPromptSubmit", { prompt: "Fix the deterministic TypeScript test" }),
  );
  if (!turn.taskId || !turn.traceId) throw new Error("Expected focused task and trace");
  return { taskId: turn.taskId, traceId: turn.traceId };
}

describe("Harness-controlled Hook policy gate", () => {
  it("blocks write tools while the lifecycle is still in INTAKE", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-policy-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "harness.sqlite");
    const processor = controlledProcessor(databasePath);
    startTrace(processor);

    expect(() =>
      processor.process(
        hookInput("PreToolUse", {
          tool_name: "Edit",
          tool_use_id: "edit-in-intake",
          tool_input: { file_path: "src/example.ts", old_string: "a", new_string: "b" },
        }),
      ),
    ).toThrow(HookPolicyViolation);

    processor.close();
  });

  it("allows read-only tools while the lifecycle is still in INTAKE", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-policy-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "harness.sqlite");
    const processor = controlledProcessor(databasePath);
    startTrace(processor);

    expect(() =>
      processor.process(
        hookInput("PreToolUse", {
          tool_name: "Read",
          tool_use_id: "read-in-intake",
          tool_input: { file_path: "src/example.ts" },
        }),
      ),
    ).not.toThrow();

    processor.close();
  });

  it("allows source edits in EXECUTE after Harness advances the lifecycle", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-policy-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "harness.sqlite");
    const processor = controlledProcessor(databasePath);
    startTrace(processor);
    processor.close();

    const service = new HarnessService(databasePath, "runtime-controlled");
    let context = service.getContext();
    const evidence = context.recentEvidence.at(-1)?.eventId;
    if (!evidence) throw new Error("Expected lifecycle evidence");
    context = service.transitionStage("RECALL", "Proceed to recall.", [evidence]);
    context = service.transitionStage("PLAN", "Recall complete.", [context.recentEvidence.at(-1)!.eventId]);
    service.transitionStage("EXECUTE", "Plan accepted.", [context.recentEvidence.at(-1)!.eventId]);
    service.close();

    const resumed = controlledProcessor(databasePath);
    expect(() =>
      resumed.process(
        hookInput("PreToolUse", {
          tool_name: "Edit",
          tool_use_id: "edit-in-execute",
          tool_input: { file_path: "src/example.ts", old_string: "a", new_string: "b" },
        }),
      ),
    ).not.toThrow();
    resumed.close();
  });
});
