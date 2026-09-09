import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaseRegistry } from "../src/cases/case-registry.js";
import { CASE_SCHEMA_VERSION, type CaseSplit, type FailureCase } from "../src/cases/types.js";
import { EVENT_TYPES } from "../src/domain/event-types.js";
import type { CapturedEvent } from "../src/domain/events.js";
import { ExperienceCurator } from "../src/experiences/experience-curator.js";
import { ExperienceStore } from "../src/experiences/experience-store.js";
import { LifecycleController } from "../src/lifecycle/controller.js";
import { ProjectionStore } from "../src/projections/projection-store.js";
import { RecallEngine } from "../src/recall/recall-engine.js";
import { SkillGenerator } from "../src/skills/skill-generator.js";
import { SkillExposureAdapter } from "../src/skills/skill-exposure-adapter.js";
import { SkillRegressionMonitor } from "../src/skills/skill-regression-monitor.js";
import { SkillRegistry } from "../src/skills/skill-registry.js";
import type { HarnessSkill } from "../src/skills/types.js";
import { EventLedger } from "../src/storage/event-ledger.js";
import {
  SkillLifecycleController,
  SkillValidationAgent,
  type SkillExecutor,
} from "../src/validation/skill-validation-agent.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`Unsafe test path: ${target}`);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function event(overrides: Partial<CapturedEvent>): CapturedEvent {
  return {
    eventType: "test.event",
    runtimeInstanceId: "runtime-skill-test",
    sessionId: "session-skill-test",
    correlationId: "trace-skill-test",
    actor: { type: "worker", id: "skill-test" },
    source: { adapter: "test", adapterVersion: "1.0.0" },
    policyVersion: "test-policy",
    payload: {},
    ...overrides,
  };
}

function successfulTrace(ledger: EventLedger, projection: ProjectionStore): void {
  ledger.append(event({ eventType: EVENT_TYPES.SESSION_STARTED, correlationId: "session-skill-test", payload: { claudeSessionId: "claude-skill-test", projectId: "project-skill-test" } }));
  ledger.append(event({ eventType: EVENT_TYPES.TASK_CREATED, taskId: "task-skill-test", correlationId: "task-skill-test", payload: { title: "Repair arithmetic regression" } }));
  new LifecycleController(ledger, {
    runtimeInstanceId: "runtime-skill-test",
    actor: { type: "controller", id: "controller" },
    source: { adapter: "test", adapterVersion: "1.0.0" },
    policyVersion: "test-policy",
  }).startTrace({ sessionId: "session-skill-test", taskId: "task-skill-test", traceId: "trace-skill-test" }, "test");
  ledger.append(event({
    eventId: "evt-skill-observation",
    eventType: "observation.recorded",
    taskId: "task-skill-test",
    traceId: "trace-skill-test",
    stageId: "stage-skill-test",
    payload: { summary: "Trace the assertion to the narrow arithmetic implementation and preserve the public contract." },
  }));
  ledger.append(event({
    eventId: "evt-task-node-root",
    eventType: EVENT_TYPES.TASK_NODE_CREATED,
    taskId: "task-skill-test",
    traceId: "trace-skill-test",
    payload: {
      nodeId: "node-root",
      title: "Repair arithmetic regression",
      description: "Top-level repair task.",
    },
  }));
  ledger.append(event({
    eventId: "evt-task-node-root-decomposed",
    eventType: EVENT_TYPES.TASK_NODE_DECOMPOSED,
    taskId: "task-skill-test",
    traceId: "trace-skill-test",
    payload: {
      nodeId: "node-root",
      children: [
        {
          nodeId: "node-diagnose",
          title: "Diagnose arithmetic failure",
          description: "Trace the failure to the implementation.",
        },
      ],
    },
  }));
  ledger.append(event({
    eventId: "evt-task-node-diagnose-completed",
    eventType: EVENT_TYPES.TASK_NODE_COMPLETED,
    taskId: "task-skill-test",
    traceId: "trace-skill-test",
    payload: {
      nodeId: "node-diagnose",
      resultSummary: "Arithmetic implementation was isolated.",
    },
  }));
  ledger.append(event({
    eventId: "evt-skill-grader",
    eventType: "grader.completed",
    taskId: "task-skill-test",
    traceId: "trace-skill-test",
    stageId: "stage-skill-test",
    stepId: "step-skill-test",
    attemptId: "attempt-skill-test",
    payload: { command: process.execPath, args: ["test.js"], exitCode: 0, timedOut: false },
  }));
  ledger.append(event({
    eventId: "evt-skill-success",
    eventType: EVENT_TYPES.RESULT_EVALUATED,
    taskId: "task-skill-test",
    traceId: "trace-skill-test",
    stageId: "stage-skill-test",
    causationId: "evt-skill-grader",
    payload: { outcome: "success", commandEvidenceEventIds: ["evt-skill-grader"] },
  }));
  projection.projectPending(ledger);
}

function failingRepository(): { directory: string; commitSha: string } {
  const directory = mkdtempSync(join(tmpdir(), "agent-harness-skill-repo-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
  writeFileSync(join(directory, "test.js"), "process.exit(3);\n");
  git(directory, ["init"]);
  git(directory, ["config", "user.email", "skill-test@example.invalid"]);
  git(directory, ["config", "user.name", "Skill Test"]);
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "failing fixture"]);
  return { directory, commitSha: git(directory, ["rev-parse", "HEAD"]) };
}

function activeCase(registry: CaseRegistry, split: CaseSplit, commitSha: string): FailureCase {
  const now = new Date().toISOString();
  const failureCase: FailureCase = {
    schemaVersion: CASE_SCHEMA_VERSION,
    caseId: `case-${split}`.replace("case-", "case_"),
    fingerprint: createHash("sha256").update(split).digest("hex"),
    title: `${split} arithmetic failure`,
    status: "raw",
    split,
    classification: "capability",
    taskType: "typescript-reproducible-test-repair",
    source: {
      projectId: "project-validation-test",
      traceId: `trace-${split}`,
      taskId: `task-${split}`,
      evidenceEventIds: [`evidence-${split}`],
      commitSha,
      workingTreePatch: "",
    },
    reproductionOracle: { command: "node", args: ["test.js"], timeoutMs: 10_000, expectedExitCode: 3 },
    solutionOracle: { command: "node", args: ["test.js"], timeoutMs: 10_000, expectedExitCode: 0 },
    tags: ["typescript", "deterministic-test"],
    createdAt: now,
    updatedAt: now,
  };
  registry.create(failureCase);
  registry.transition(failureCase.caseId, "triaged", "test triage");
  registry.recordReproduction(failureCase.caseId, {
    reproduced: true, exitCode: 3, timedOut: false, durationMs: 1, stdout: "", stderr: "", commitSha,
  });
  registry.transition(failureCase.caseId, "reproducible", "test reproduction");
  registry.transition(failureCase.caseId, "approved", "test approval");
  return registry.transition(failureCase.caseId, "active", "test activation");
}

class RepairFixtureExecutor implements SkillExecutor {
  readonly id = "independent-fixture-executor";
  execute(_skill: HarnessSkill, _failureCase: FailureCase, worktree: string) {
    writeFileSync(join(worktree, "test.js"), "process.exit(0);\n");
    return { succeeded: true, tokenUsage: 20, toolCalls: 2, detail: "Applied independent fixture repair." };
  }
}

describe("Experience to production Skill lifecycle", () => {
  it("mines success, generates testing Skill, validates all splits, and promotes through the controller", () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "agent-harness-skill-state-"));
    temporaryDirectories.push(stateDirectory);
    const databasePath = join(stateDirectory, "harness.sqlite");
    const ledger = new EventLedger(databasePath);
    const projection = new ProjectionStore(databasePath);
    successfulTrace(ledger, projection);
    const experiences = new ExperienceStore(databasePath, ledger);
    const curation = new ExperienceCurator(ledger, projection, experiences).curate("trace-skill-test");
    expect(curation).toMatchObject({ accepted: true, created: true, experience: { status: "usable" } });
    expect(curation.experience?.strategy).toContain(
      "Recursive TaskNode path: Repair arithmetic regression -> Diagnose arithmetic failure",
    );
    expect(curation.experience?.source.evidenceEventIds).toContain("evt-task-node-diagnose-completed");

    const skills = new SkillRegistry(databasePath, ledger);
    const generated = new SkillGenerator(experiences, skills).generate([curation.experience!.experienceId]);
    expect(generated.skill.status).toBe("testing");
    expect(generated.skill.markdown).toContain("## Completion gates");
    expect(skills.listProduction()).toEqual([]);
    expect(() => new SkillExposureAdapter(skills).exportCompleted(generated.skill.skillId, stateDirectory)).toThrow(
      "Only a completed Skill",
    );

    const fixture = failingRepository();
    const cases = new CaseRegistry(databasePath, ledger);
    const targets = (["development", "validation", "regression", "holdout"] as const).map((split) => ({
      failureCase: activeCase(cases, split, fixture.commitSha),
      repositoryDirectory: fixture.directory,
    }));
    const report = new SkillValidationAgent(skills, new RepairFixtureExecutor()).validate(generated.skill.skillId, targets);
    expect(
      report.verdict,
      `${report.reason}\n${JSON.stringify(report.caseResults, null, 2)}`,
    ).toBe("pass");
    expect(report).toMatchObject({ holdoutSuccessRate: 1, totalTokenUsage: 240, totalToolCalls: 24 });
    expect(report.caseResults.every((result) => result.passed === 3 && result.stable)).toBe(true);
    expect(report.caseResults.every((result) => result.evidenceEventIds.length === 3)).toBe(true);
    expect(skills.listProduction()).toEqual([]);

    const completed = new SkillLifecycleController(skills).applyValidation(report);
    expect(completed).toMatchObject({ status: "completed", baseline: { successRate: 1 } });
    expect(completed.baseline.validationRunIds).toEqual([report.validationRunId]);
    expect(completed.source.caseIds).toHaveLength(4);
    expect(skills.listProduction().map((skill) => skill.skillId)).toEqual([generated.skill.skillId]);
    const exported = new SkillExposureAdapter(skills).exportCompleted(generated.skill.skillId, stateDirectory);
    expect(exported.endsWith("SKILL.md")).toBe(true);

    const recall = new RecallEngine(ledger, experiences, skills, "runtime-skill-test").recall(
      {
        runtimeInstanceId: "runtime-skill-test",
        sessionId: "session-skill-test",
        taskId: "task-skill-test",
        taskTitle: "Repair another arithmetic test",
        traceId: "trace-skill-test",
        currentStage: "RECALL",
        currentStageId: "stage-skill-test",
        recentEvidence: [],
      },
      {
        taskType: "typescript-reproducible-test-repair",
        technologies: ["typescript", "node"],
        stage: "RECALL",
        taskSummary: "Repair another arithmetic test",
        tokenBudget: 4096,
      },
    );
    expect(recall.items.map((item) => item.assetType).sort()).toEqual(["experience", "skill"]);
    expect(recall.estimatedTokens).toBeLessThanOrEqual(4096);

    const monitor = new SkillRegressionMonitor(ledger, skills);
    expect(monitor.record({
      skillId: generated.skill.skillId,
      traceId: "production-trace-one",
      outcome: "failure",
      severity: "high",
      reason: "Introduced a deterministic regression.",
    }).status).toBe("completed");
    expect(monitor.record({
      skillId: generated.skill.skillId,
      traceId: "production-trace-two",
      outcome: "failure",
      severity: "high",
      reason: "Repeated the deterministic regression.",
    }).status).toBe("quarantined");
    expect(skills.listProduction()).toEqual([]);

    cases.close();
    skills.close();
    experiences.close();
    projection.close();
    ledger.close();
  }, 20_000);

  it("does not promote when required validation splits are absent", () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "agent-harness-skill-state-"));
    temporaryDirectories.push(stateDirectory);
    const databasePath = join(stateDirectory, "harness.sqlite");
    const ledger = new EventLedger(databasePath);
    const projection = new ProjectionStore(databasePath);
    successfulTrace(ledger, projection);
    const experiences = new ExperienceStore(databasePath, ledger);
    const curation = new ExperienceCurator(ledger, projection, experiences).curate("trace-skill-test");
    const skills = new SkillRegistry(databasePath, ledger);
    const generated = new SkillGenerator(experiences, skills).generate([curation.experience!.experienceId]);
    const report = new SkillValidationAgent(skills, new RepairFixtureExecutor()).validate(generated.skill.skillId, []);

    expect(report.verdict).toBe("fail");
    expect(report.reason).toContain("Missing required splits");
    expect(new SkillLifecycleController(skills).applyValidation(report).status).toBe("testing");
    expect(skills.listProduction()).toEqual([]);

    skills.close();
    experiences.close();
    projection.close();
    ledger.close();
  });
});

function git(directory: string, args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
