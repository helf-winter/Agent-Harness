import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "../src/domain/event-types.js";
import type { CapturedEvent } from "../src/domain/events.js";
import { LifecycleController } from "../src/lifecycle/controller.js";
import { ProjectionStore } from "../src/projections/projection-store.js";
import { EventLedger } from "../src/storage/event-ledger.js";

const resources: Array<{ ledger: EventLedger; projection: ProjectionStore; directory: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.projection.close();
    resource.ledger.close();
    const target = resolve(resource.directory);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`Unsafe test path: ${target}`);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "agent-harness-projection-"));
  const databasePath = join(directory, "harness.sqlite");
  const ledger = new EventLedger(databasePath);
  const projection = new ProjectionStore(databasePath);
  resources.push({ ledger, projection, directory });
  return { ledger, projection };
}

function base(overrides: Partial<CapturedEvent>): CapturedEvent {
  return {
    eventType: "test.event",
    runtimeInstanceId: "runtime-one",
    sessionId: "session-one",
    correlationId: "session-one",
    actor: { type: "hook", id: "claude-code" },
    source: { adapter: "claude-code", adapterVersion: "2.1.220" },
    policyVersion: "policy-one",
    payload: {},
    ...overrides,
  };
}

describe("core projections", () => {
  it("projects a Session, Task, Turn link, and Trace", () => {
    const { ledger, projection } = setup();
    ledger.append(
      base({
        eventType: EVENT_TYPES.SESSION_STARTED,
        payload: { claudeSessionId: "claude-one", projectId: "project-one" },
      }),
    );
    ledger.append(
      base({
        eventType: EVENT_TYPES.TASK_CREATED,
        taskId: "task-one",
        payload: { title: "Repair a failing TypeScript test" },
      }),
    );
    ledger.append(
      base({
        eventType: EVENT_TYPES.TURN_STARTED,
        turnId: "turn-one",
        payload: { promptPreview: "Repair the login test" },
      }),
    );
    ledger.append(
      base({
        eventType: EVENT_TYPES.TURN_LINKED_TO_TASK,
        turnId: "turn-one",
        taskId: "task-one",
        payload: { relation: "primary", confidence: 1 },
      }),
    );

    const controller = new LifecycleController(ledger, {
      runtimeInstanceId: "runtime-one",
      actor: { type: "controller", id: "controller" },
      source: { adapter: "harness-core", adapterVersion: "0.1.0" },
      policyVersion: "policy-one",
    });
    controller.startTrace(
      { sessionId: "session-one", taskId: "task-one", traceId: "trace-one" },
      "First execution",
    );

    expect(projection.projectPending(ledger)).toBe(5);
    expect(projection.findSession("session-one")).toMatchObject({ status: "active" });
    expect(projection.getFocusedTask("session-one")).toMatchObject({ taskId: "task-one" });
    expect(projection.getOpenTurn("session-one")).toMatchObject({ turnId: "turn-one" });
    expect(projection.getActiveTrace("task-one")).toMatchObject({
      traceId: "trace-one",
      currentStage: "INTAKE",
    });
    expect(projection.projectPending(ledger)).toBe(0);
  });

  it("preserves derived records when a Session is deleted", () => {
    const { ledger, projection } = setup();
    ledger.append(
      base({
        eventType: EVENT_TYPES.SESSION_STARTED,
        payload: { claudeSessionId: "claude-one", projectId: "project-one" },
      }),
    );
    ledger.append(
      base({
        eventType: EVENT_TYPES.TASK_CREATED,
        taskId: "task-one",
        payload: { title: "Retained task" },
      }),
    );
    ledger.append(base({ eventType: EVENT_TYPES.SESSION_DELETED, payload: {} }));

    projection.projectPending(ledger);
    expect(projection.findSession("session-one")).toBeUndefined();
    expect(projection.listTraces()).toEqual([]);
  });

  it("updates the current stage from transition events", () => {
    const { ledger, projection } = setup();
    ledger.append(
      base({
        eventType: EVENT_TYPES.SESSION_STARTED,
        payload: { claudeSessionId: "claude-one", projectId: "project-one" },
      }),
    );
    ledger.append(
      base({
        eventType: EVENT_TYPES.TASK_CREATED,
        taskId: "task-one",
        payload: { title: "Stage projection" },
      }),
    );
    const controller = new LifecycleController(ledger, {
      runtimeInstanceId: "runtime-one",
      actor: { type: "controller", id: "controller" },
      source: { adapter: "harness-core", adapterVersion: "0.1.0" },
      policyVersion: "policy-one",
    });
    const scope = { sessionId: "session-one", taskId: "task-one", traceId: "trace-one" };
    controller.startTrace(scope, "Start");
    ledger.append(
      base({
        eventId: "evt-intake",
        eventType: "observation.recorded",
        taskId: "task-one",
        traceId: "trace-one",
        correlationId: "trace-one",
        payload: { summary: "Intake evidence" },
      }),
    );
    controller.transition({
      ...scope,
      to: "RECALL",
      reason: "Intake complete",
      evidenceEventIds: ["evt-intake"],
    });

    projection.projectPending(ledger);
    expect(projection.getActiveTrace("task-one")?.currentStage).toBe("RECALL");
  });
});
