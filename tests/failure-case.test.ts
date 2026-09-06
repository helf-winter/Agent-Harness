import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FailureCaseService } from "../src/cases/failure-case-service.js";
import { EVENT_TYPES } from "../src/domain/event-types.js";
import type { CapturedEvent } from "../src/domain/events.js";
import { LifecycleController } from "../src/lifecycle/controller.js";
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

function base(overrides: Partial<CapturedEvent>): CapturedEvent {
  return {
    eventType: "test.event",
    runtimeInstanceId: "runtime-case-test",
    sessionId: "session-case-test",
    correlationId: "trace-case-test",
    actor: { type: "worker", id: "case-test" },
    source: { adapter: "test", adapterVersion: "1.0.0" },
    policyVersion: "test-policy",
    payload: {},
    ...overrides,
  };
}

function createFailingRepository(): { directory: string; commitSha: string } {
  const directory = mkdtempSync(join(tmpdir(), "agent-harness-case-repo-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "node test.js" } }),
  );
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
  writeFileSync(
    join(directory, "test.js"),
    "console.error('expected 4 but received 5'); process.exit(3);\n",
  );
  git(directory, ["init"]);
  git(directory, ["config", "user.email", "case-test@example.invalid"]);
  git(directory, ["config", "user.name", "Case Test"]);
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "failing fixture"]);
  return { directory, commitSha: git(directory, ["rev-parse", "HEAD"]) };
}

function setupTrace(databasePath: string): { ledger: EventLedger; projection: ProjectionStore } {
  const ledger = new EventLedger(databasePath);
  const projection = new ProjectionStore(databasePath);
  ledger.append(
    base({
      eventType: EVENT_TYPES.SESSION_STARTED,
      correlationId: "session-case-test",
      payload: { claudeSessionId: "claude-case-test", projectId: "project-case-test" },
    }),
  );
  ledger.append(
    base({
      eventType: EVENT_TYPES.TASK_CREATED,
      taskId: "task-case-test",
      correlationId: "task-case-test",
      payload: { title: "Repair reproducible addition failure" },
    }),
  );
  new LifecycleController(ledger, {
    runtimeInstanceId: "runtime-case-test",
    actor: { type: "controller", id: "test-controller" },
    source: { adapter: "test", adapterVersion: "1.0.0" },
    policyVersion: "test-policy",
  }).startTrace(
    { sessionId: "session-case-test", taskId: "task-case-test", traceId: "trace-case-test" },
    "test",
  );
  ledger.append(
    base({
      eventId: "evt-failing-grader",
      eventType: "grader.completed",
      taskId: "task-case-test",
      traceId: "trace-case-test",
      stageId: "stage-case-test",
      stepId: "step-case-test",
      attemptId: "attempt-case-test",
      payload: {
        command: process.execPath,
        args: ["test.js"],
        exitCode: 3,
        timedOut: false,
        stdout: "",
        stderr: "expected 4 but received 5",
      },
    }),
  );
  ledger.append(
    base({
      eventId: "evt-failure-result",
      eventType: EVENT_TYPES.RESULT_EVALUATED,
      taskId: "task-case-test",
      traceId: "trace-case-test",
      stageId: "stage-case-test",
      causationId: "evt-failing-grader",
      payload: {
        outcome: "failure",
        commandEvidenceEventIds: ["evt-failing-grader"],
      },
    }),
  );
  projection.projectPending(ledger);
  return { ledger, projection };
}

describe("Failure Case vertical slice", () => {
  it("curates, reproduces, and automatically promotes a deterministic TypeScript failure", () => {
    const fixture = createFailingRepository();
    const stateDirectory = mkdtempSync(join(tmpdir(), "agent-harness-case-state-"));
    temporaryDirectories.push(stateDirectory);
    const databasePath = join(stateDirectory, "harness.sqlite");
    const { ledger, projection } = setupTrace(databasePath);
    const service = new FailureCaseService(databasePath, ledger, projection);

    const curation = service.curate("trace-case-test", fixture.directory);
    expect(curation).toMatchObject({ accepted: true, created: true });
    expect(curation.failureCase).toMatchObject({
      status: "triaged",
      taskType: "typescript-reproducible-test-repair",
      source: { commitSha: fixture.commitSha },
    });

    const promotion = service.reproduceAndPromote(curation.failureCase!.caseId, fixture.directory);
    expect(promotion.reproduction).toMatchObject({ reproduced: true, exitCode: 3 });
    expect(promotion.failureCase.status).toBe("active");
    expect(service.registry.list("active")).toHaveLength(1);
    expect(git(fixture.directory, ["worktree", "list", "--porcelain"]).match(/worktree /g)).toHaveLength(1);

    const duplicate = service.curate("trace-case-test", fixture.directory);
    expect(duplicate).toMatchObject({ accepted: true, created: false });
    expect(duplicate.failureCase?.caseId).toBe(curation.failureCase?.caseId);

    service.close();
    projection.close();
    ledger.close();
  }, 20_000);

  it("rejects a Trace without deterministic failure evidence", () => {
    const fixture = createFailingRepository();
    const stateDirectory = mkdtempSync(join(tmpdir(), "agent-harness-case-state-"));
    temporaryDirectories.push(stateDirectory);
    const databasePath = join(stateDirectory, "harness.sqlite");
    const ledger = new EventLedger(databasePath);
    const projection = new ProjectionStore(databasePath);
    const service = new FailureCaseService(databasePath, ledger, projection);

    expect(service.curate("missing-trace", fixture.directory)).toEqual({
      accepted: false,
      reason: "Trace not found: missing-trace",
    });

    service.close();
    projection.close();
    ledger.close();
  });
});

function git(directory: string, args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
