import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessService } from "../src/integration/harness-service.js";
import { HookProcessor, type ClaudeHookInput } from "../src/integration/hook-processor.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`Unsafe test path: ${target}`);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function input(hookEventName: string, extra: Partial<ClaudeHookInput> = {}): ClaudeHookInput {
  return {
    session_id: "claude-service-session",
    cwd: "/workspace/example",
    hook_event_name: hookEventName,
    ...extra,
  };
}

describe("Harness MCP service", () => {
  it("returns context, records observations, and transitions with real evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-service-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "harness.sqlite");
    const processor = new HookProcessor(databasePath, {
      runtimeInstanceId: "runtime-service",
      projectId: "project-one",
      adapterVersion: "2.1.220",
    });
    processor.process(input("SessionStart", { source: "startup" }));
    processor.process(input("UserPromptSubmit", { prompt: "Fix the login test" }));
    processor.close();

    const service = new HarnessService(databasePath, "runtime-service");
    const initial = service.getContext();
    expect(initial.currentStage).toBe("INTAKE");
    const promptEvidence = initial.recentEvidence.find(
      (event) => event.eventType === "turn.started",
    );
    expect(promptEvidence).toBeDefined();

    const observation = service.recordObservation("The task goal is explicit.", [
      promptEvidence!.eventId,
    ]);
    const recalled = service.transitionStage("RECALL", "Intake is complete.", [
      observation.eventId,
    ]);
    expect(recalled.currentStage).toBe("RECALL");
    service.close();
  });

  it("rejects fabricated evidence IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-service-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "harness.sqlite");
    const processor = new HookProcessor(databasePath, {
      runtimeInstanceId: "runtime-service",
      projectId: "project-one",
      adapterVersion: "2.1.220",
    });
    processor.process(input("UserPromptSubmit", { prompt: "Fix the test" }));
    processor.close();

    const service = new HarnessService(databasePath, "runtime-service");
    expect(() =>
      service.transitionStage("RECALL", "Pretend intake passed", ["evt-fabricated"]),
    ).toThrow("do not exist");
    service.close();
  });

  it("creates and switches between independent Tasks in one Session", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-service-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "harness.sqlite");
    const processor = new HookProcessor(databasePath, {
      runtimeInstanceId: "runtime-service",
      projectId: "project-one",
      adapterVersion: "2.1.220",
    });
    processor.process(input("UserPromptSubmit", { prompt: "Fix the login test" }));
    processor.close();

    const service = new HarnessService(databasePath, "runtime-service");
    const original = service.getContext();
    const created = service.createAndFocusTask(
      "Fix the build configuration",
      "The prompt introduces an independent goal.",
    );
    expect(created.taskId).not.toBe(original.taskId);
    expect(service.listTasks()).toHaveLength(2);
    expect(service.listTasks().find((task) => task.taskId === created.taskId)?.focused).toBe(true);

    const restored = service.focusTask(original.taskId, "The user returned to the login failure.");
    expect(restored.taskId).toBe(original.taskId);
    expect(restored.traceId).toBe(original.traceId);
    service.close();
  });
});
