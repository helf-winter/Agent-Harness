import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookProcessor, type ClaudeHookInput } from "../src/integration/hook-processor.js";
import { ProjectionStore } from "../src/projections/projection-store.js";
import { EventLedger } from "../src/storage/event-ledger.js";

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
    session_id: "claude-session-one",
    cwd: "/workspace/example",
    hook_event_name: hookEventName,
    ...extra,
  };
}

describe("Claude Code Hook processor", () => {
  it("builds one trace across multiple turns and captures tool evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-hook-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "harness.sqlite");
    const processor = new HookProcessor(databasePath, {
      runtimeInstanceId: "runtime-one",
      projectId: "project-one",
      adapterVersion: "2.1.220",
    });

    processor.process(hookInput("SessionStart", { source: "startup" }));
    const firstTurn = processor.process(
      hookInput("UserPromptSubmit", { prompt: "Fix the failing login test" }),
    );
    processor.process(
      hookInput("PreToolUse", {
        tool_name: "Bash",
        tool_use_id: "tool-use-one",
        tool_input: { command: "API_KEY=private npm test" },
      }),
    );
    processor.process(
      hookInput("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "tool-use-one",
        tool_input: { command: "npm test" },
        tool_response: { exitCode: 1, output: "login test failed" },
      }),
    );
    processor.process(hookInput("Stop", { last_assistant_message: "I found the failure." }));
    const secondTurn = processor.process(
      hookInput("UserPromptSubmit", { prompt: "Continue and implement the fix" }),
    );
    processor.process(hookInput("Stop", { last_assistant_message: "The tests now pass." }));
    processor.process(hookInput("SessionEnd", { reason: "prompt_input_exit" }));
    processor.close();

    expect(secondTurn.taskId).toBe(firstTurn.taskId);
    expect(secondTurn.traceId).toBe(firstTurn.traceId);
    expect(secondTurn.turnId).not.toBe(firstTurn.turnId);

    const ledger = new EventLedger(databasePath);
    const events = ledger.list();
    expect(events.filter((event) => event.eventType === "turn.started")).toHaveLength(2);
    expect(events.filter((event) => event.eventType === "tool.requested")).toHaveLength(1);
    expect(
      events.find((event) => event.eventType === "tool.requested")?.payload.toolInput,
    ).toEqual({ command: "API_KEY=<REDACTED> npm test" });
    const stopped = events.find((event) => event.eventType === "turn.ended");
    expect(stopped?.payload).not.toHaveProperty("finalResponse");
    expect(stopped?.payload).toMatchObject({
      finalResponsePreview: "I found the failure.",
      finalResponseLength: 20,
    });
    const traceEvidence = ledger.listTraceEvidence(
      firstTurn.traceId!,
      firstTurn.taskId!,
      firstTurn.sessionId,
    );
    expect(traceEvidence.some((event) => event.eventType === "turn.started")).toBe(true);
    expect(traceEvidence.some((event) => event.eventType === "task.created")).toBe(true);
    expect(ledger.verifyChain().valid).toBe(true);
    ledger.close();

    const projection = new ProjectionStore(databasePath);
    const traces = projection.listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      traceId: firstTurn.traceId,
      taskTitle: "Fix the failing login test",
      currentStage: "INTAKE",
    });
    expect(projection.getTaskTree({ traceId: firstTurn.traceId! }).root).toMatchObject({
      title: "Fix the failing login test",
      parentNodeId: null,
      depth: 0,
      status: "pending",
    });
    expect(projection.findSession(firstTurn.sessionId)?.status).toBe("ended");
    projection.close();
  });

  it("ships valid Hook configuration", () => {
    const hooks = JSON.parse(
      readFileSync(resolve("plugin/hooks/hooks.json"), "utf8"),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(hooks.hooks)).toEqual(
      expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"]),
    );
  });
});
