import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverEvaluationPlan } from "../src/evaluation/command-discovery.js";
import { ResultEvaluator } from "../src/evaluation/result-evaluator.js";
import type { HarnessContext } from "../src/integration/harness-service.js";
import { EventLedger } from "../src/storage/event-ledger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`Unsafe test path: ${target}`);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "agent-harness-evaluator-"));
  temporaryDirectories.push(directory);
  const ledger = new EventLedger(join(directory, "harness.sqlite"));
  const context: HarnessContext = {
    runtimeInstanceId: "runtime-one",
    sessionId: "session-one",
    taskId: "task-one",
    taskTitle: "Evaluate repair",
    traceId: "trace-one",
    currentStage: "VERIFY",
    currentStageId: "stage-verify",
    recentEvidence: [],
  };
  return { directory, ledger, context };
}

describe("deterministic Result Evaluator", () => {
  it("reports success only when every required command passes", () => {
    const { directory, ledger, context } = setup();
    const evaluator = new ResultEvaluator(ledger, "runtime-one");
    const report = evaluator.evaluate(context, {
      projectDirectory: directory,
      commands: [
        {
          id: "passing-test",
          command: process.execPath,
          args: ["-e", "console.log('passed')"],
          required: true,
          timeoutMs: 5_000,
        },
      ],
    });

    expect(report.outcome).toBe("success");
    expect(report.commands[0]).toMatchObject({ exitCode: 0, timedOut: false });
    expect(ledger.getByIds([report.resultEventId])[0]?.payload.outcome).toBe("success");
    ledger.close();
  });

  it("reports failure when a required command fails", () => {
    const { directory, ledger, context } = setup();
    const evaluator = new ResultEvaluator(ledger, "runtime-one");
    const report = evaluator.evaluate(context, {
      projectDirectory: directory,
      commands: [
        {
          id: "failing-test",
          command: process.execPath,
          args: ["-e", "process.exit(7)"],
          required: true,
          timeoutMs: 5_000,
        },
      ],
    });

    expect(report.outcome).toBe("failure");
    expect(report.commands[0]?.exitCode).toBe(7);
    ledger.close();
  });

  it("reports unknown when no deterministic command exists", () => {
    const { directory, ledger, context } = setup();
    const report = new ResultEvaluator(ledger, "runtime-one").evaluate(context, {
      projectDirectory: directory,
      commands: [],
    });
    expect(report.outcome).toBe("unknown");
    ledger.close();
  });
});

describe("evaluation command discovery", () => {
  it("discovers TypeScript quality scripts and ignores placeholder tests", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-discovery-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          build: "tsc",
          test: "echo 'Error: no test specified' && exit 1",
        },
      }),
    );

    expect(discoverEvaluationPlan(directory).commands.map((command) => command.id)).toEqual([
      "typecheck",
      "build",
    ]);
  });

  it("executes an automatically discovered npm test without a shell", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-discovery-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"console.log('fixture passed')\"" } }),
    );
    const ledger = new EventLedger(join(directory, "harness.sqlite"));
    const context: HarnessContext = {
      runtimeInstanceId: "runtime-one",
      sessionId: "session-one",
      taskId: "task-one",
      taskTitle: "Auto discovery",
      traceId: "trace-one",
      currentStage: "VERIFY",
      currentStageId: "stage-verify",
      recentEvidence: [],
    };

    const report = new ResultEvaluator(ledger, "runtime-one").evaluate(
      context,
      discoverEvaluationPlan(directory),
    );
    expect(report.outcome).toBe("success");
    expect(report.commands[0]?.stdout).toContain("fixture passed");
    ledger.close();
  });
});
