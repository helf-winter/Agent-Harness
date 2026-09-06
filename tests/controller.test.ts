import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleController } from "../src/lifecycle/controller.js";
import { EventLedger } from "../src/storage/event-ledger.js";

const resources: Array<{ ledger: EventLedger; directory: string }> = [];

afterEach(() => {
  for (const { ledger, directory } of resources.splice(0)) {
    try {
      ledger.close();
    } catch {
      // The resource may already be closed by the test.
    }
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()))) {
      throw new Error(`Refusing to remove non-temporary path: ${target}`);
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function setup(): { controller: LifecycleController; ledger: EventLedger } {
  const directory = mkdtempSync(join(tmpdir(), "agent-harness-controller-"));
  const ledger = new EventLedger(join(directory, "events.sqlite"));
  resources.push({ ledger, directory });
  return {
    ledger,
    controller: new LifecycleController(ledger, {
      runtimeInstanceId: "runtime-one",
      actor: { type: "controller", id: "lifecycle-controller" },
      source: { adapter: "harness-core", adapterVersion: "0.1.0" },
      policyVersion: "policy-one",
    }),
  };
}

const scope = { sessionId: "session-one", taskId: "task-one", traceId: "trace-one" };

function appendEvidence(ledger: EventLedger, eventId: string): void {
  ledger.append({
    eventId,
    eventType: "observation.recorded",
    runtimeInstanceId: "runtime-one",
    ...scope,
    correlationId: scope.traceId,
    actor: { type: "agent", id: "test-agent" },
    source: { adapter: "test", adapterVersion: "1.0.0" },
    policyVersion: "policy-one",
    payload: { summary: "Test evidence" },
  });
}

describe("lifecycle controller", () => {
  it("starts a trace in INTAKE and restores it by replay", () => {
    const { controller, ledger } = setup();
    controller.startTrace(scope, "User submitted a repair task");
    appendEvidence(ledger, "evt-prompt");

    expect(controller.getTraceState(scope.traceId)).toMatchObject({
      ...scope,
      currentStage: "INTAKE",
    });
  });

  it("refuses to skip stages", () => {
    const { controller, ledger } = setup();
    controller.startTrace(scope, "User submitted a repair task");
    appendEvidence(ledger, "evt-prompt");

    expect(() =>
      controller.transition({
        ...scope,
        to: "EXECUTE",
        reason: "Skip directly to code",
        evidenceEventIds: ["evt-prompt"],
      }),
    ).toThrow("INTAKE -> EXECUTE");
  });

  it("records a valid transition and restores the new stage", () => {
    const { controller, ledger } = setup();
    controller.startTrace(scope, "User submitted a repair task");
    appendEvidence(ledger, "evt-intake");
    controller.transition({
      ...scope,
      to: "RECALL",
      reason: "Intake contract recorded",
      evidenceEventIds: ["evt-intake"],
    });

    expect(controller.getTraceState(scope.traceId).currentStage).toBe("RECALL");
    expect(ledger.verifyChain().valid).toBe(true);
  });

  it("resumes the exact stage after HUMAN_REVIEW", () => {
    const { controller, ledger } = setup();
    controller.startTrace(scope, "User submitted a repair task");
    appendEvidence(ledger, "evt-ambiguity");
    controller.transition({
      ...scope,
      to: "HUMAN_REVIEW",
      reason: "Acceptance criteria are ambiguous",
      evidenceEventIds: ["evt-ambiguity"],
    });
    appendEvidence(ledger, "evt-answer");

    expect(() =>
      controller.transition({
        ...scope,
        to: "PLAN",
        reason: "User answered",
        evidenceEventIds: ["evt-answer"],
      }),
    ).toThrow("resume the recorded stage");

    controller.transition({
      ...scope,
      to: "INTAKE",
      reason: "User answered",
      evidenceEventIds: ["evt-answer"],
    });
    expect(controller.getTraceState(scope.traceId).currentStage).toBe("INTAKE");
  });

  it("rejects a duplicate trace ID", () => {
    const { controller } = setup();
    controller.startTrace(scope, "First run");
    expect(() => controller.startTrace(scope, "Second run")).toThrow("Trace already exists");
  });

  it("requires a successful deterministic evaluation before COMPLETE", () => {
    const { controller, ledger } = setup();
    controller.startTrace(scope, "Complete a verified task");
    const path = ["RECALL", "PLAN", "EXECUTE", "VERIFY", "REVIEW"] as const;
    for (const [index, stage] of path.entries()) {
      const eventId = `evt-stage-${index}`;
      appendEvidence(ledger, eventId);
      controller.transition({
        ...scope,
        to: stage,
        reason: `Advance to ${stage}`,
        evidenceEventIds: [eventId],
      });
    }

    appendEvidence(ledger, "evt-review-only");
    expect(() =>
      controller.transition({
        ...scope,
        to: "COMPLETE",
        reason: "Review is done",
        evidenceEventIds: ["evt-review-only"],
      }),
    ).toThrow("successful Result Evaluator");

    ledger.append({
      eventId: "evt-result-success",
      eventType: "result.evaluated",
      runtimeInstanceId: "runtime-one",
      ...scope,
      correlationId: scope.traceId,
      actor: { type: "grader", id: "test-grader" },
      source: { adapter: "test", adapterVersion: "1.0.0" },
      policyVersion: "policy-one",
      payload: { outcome: "success" },
    });
    controller.transition({
      ...scope,
      to: "COMPLETE",
      reason: "All deterministic graders passed",
      evidenceEventIds: ["evt-result-success"],
    });
    expect(controller.getTraceState(scope.traceId).currentStage).toBe("COMPLETE");
  });
});
