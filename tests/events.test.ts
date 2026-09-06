import { describe, expect, it } from "vitest";
import { assertValidEventContext } from "../src/domain/events.js";

describe("event hierarchy", () => {
  it("accepts a complete attempt scope", () => {
    expect(() =>
      assertValidEventContext({
        runtimeInstanceId: "runtime-1",
        sessionId: "session-1",
        taskId: "task-1",
        traceId: "trace-1",
        stageId: "stage-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        toolCallId: "tool-1",
      }),
    ).not.toThrow();
  });

  it("rejects a trace without a task", () => {
    expect(() =>
      assertValidEventContext({ runtimeInstanceId: "runtime-1", traceId: "trace-1" }),
    ).toThrow("traceId requires taskId");
  });

  it("keeps a primary task out of related tasks", () => {
    expect(() =>
      assertValidEventContext({
        runtimeInstanceId: "runtime-1",
        sessionId: "session-1",
        taskId: "task-1",
        relatedTaskIds: ["task-1"],
      }),
    ).toThrow("relatedTaskIds");
  });
});
