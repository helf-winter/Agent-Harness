import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FailureCase } from "../cases/types.js";
import { sanitizedEnvironment, summarizeOutput } from "../evaluation/result-evaluator.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { HarnessSkill, ValidationCaseResult, ValidationReport } from "../skills/types.js";

export interface SkillExecutionResult {
  succeeded: boolean;
  tokenUsage: number | null;
  toolCalls: number | null;
  detail: string;
}

export interface SkillExecutor {
  readonly id: string;
  execute(skill: HarnessSkill, failureCase: FailureCase, worktree: string): SkillExecutionResult;
}

export interface ValidationTarget {
  failureCase: FailureCase;
  repositoryDirectory: string;
}

export interface SkillValidationPolicy {
  policyVersion: string;
  requiredSplits: Array<"development" | "validation" | "regression" | "holdout">;
  repetitions: number;
  minimumHoldoutSuccessRate: number;
}

const DEFAULT_POLICY: SkillValidationPolicy = {
  policyVersion: "skill-validation-policy-1",
  requiredSplits: ["development", "validation", "regression", "holdout"],
  repetitions: 3,
  minimumHoldoutSuccessRate: 1,
};

export class SkillValidationAgent {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly executor: SkillExecutor,
    private readonly policy: SkillValidationPolicy = DEFAULT_POLICY,
  ) {}

  validate(skillId: string, targets: ValidationTarget[]): ValidationReport {
    const skill = this.registry.get(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    if (skill.status !== "testing") throw new Error("Only a testing Skill can be validated.");
    const active = targets.filter((target) => target.failureCase.status === "active");
    const validationRunId = `validation_${randomUUID()}`;
    const missingSplits = this.policy.requiredSplits.filter(
      (split) => !active.some((target) => target.failureCase.split === split),
    );
    const startedAt = performance.now();
    const caseResults = active.map((target) => this.#validateCase(validationRunId, skill, target));
    const holdout = caseResults.filter((result) => result.split === "holdout");
    const holdoutRuns = holdout.reduce((sum, result) => sum + result.repetitions, 0);
    const holdoutPassed = holdout.reduce((sum, result) => sum + result.passed, 0);
    const holdoutSuccessRate = holdoutRuns === 0 ? 0 : holdoutPassed / holdoutRuns;
    const requiredCasesPass = caseResults.length > 0 && caseResults.every(
      (result) => result.baselineConfirmed && result.passed === result.repetitions && result.stable,
    );
    const securityViolations = skill.permissions.destructiveOperations || skill.permissions.network
      ? ["Skill requests a forbidden high-risk permission."]
      : [];
    const destructiveSideEffects: string[] = [];
    const verdict =
      missingSplits.length === 0 &&
      requiredCasesPass &&
      holdoutSuccessRate >= this.policy.minimumHoldoutSuccessRate &&
      securityViolations.length === 0 &&
      destructiveSideEffects.length === 0
        ? "pass"
        : "fail";
    const reason = verdict === "pass"
      ? "All required active Cases passed three stable isolated repetitions, including holdout."
      : [
          missingSplits.length > 0 ? `Missing required splits: ${missingSplits.join(", ")}.` : "",
          !requiredCasesPass ? "One or more Case repetitions failed or were unstable." : "",
          holdoutSuccessRate < this.policy.minimumHoldoutSuccessRate ? "Holdout success rate is below policy." : "",
          securityViolations.join(" "),
        ].filter(Boolean).join(" ");
    const tokenValues = caseResults.map((item) => item.tokenUsage).filter((item): item is number => item !== null);
    const toolValues = caseResults.map((item) => item.toolCalls).filter((item): item is number => item !== null);
    const draft: Omit<ValidationReport, "evidenceEventId"> = {
      validationRunId,
      skillId: skill.skillId,
      skillVersion: skill.version,
      policyVersion: this.policy.policyVersion,
      verdict,
      reason,
      caseResults,
      requiredSplits: this.policy.requiredSplits,
      holdoutSuccessRate,
      securityViolations,
      destructiveSideEffects,
      durationMs: Math.round(performance.now() - startedAt),
      totalTokenUsage: tokenValues.length === 0 ? null : tokenValues.reduce((sum, value) => sum + value, 0),
      totalToolCalls: toolValues.length === 0 ? null : toolValues.reduce((sum, value) => sum + value, 0),
      createdAt: new Date().toISOString(),
    };
    return this.registry.recordValidation(draft);
  }

  #validateCase(validationRunId: string, skill: HarnessSkill, target: ValidationTarget): ValidationCaseResult {
    const durationsMs: number[] = [];
    const outcomes: boolean[] = [];
    const baselineOutcomes: boolean[] = [];
    const evidenceEventIds: string[] = [];
    let tokenUsage: number | null = null;
    let toolCalls: number | null = null;
    let failure: string | undefined;

    for (let repetition = 0; repetition < this.policy.repetitions; repetition += 1) {
      const run = runInIsolatedWorktree(skill, target, this.executor);
      durationsMs.push(run.durationMs);
      outcomes.push(run.passed);
      baselineOutcomes.push(run.baselineConfirmed);
      if (run.execution.tokenUsage !== null) tokenUsage = (tokenUsage ?? 0) + run.execution.tokenUsage;
      if (run.execution.toolCalls !== null) toolCalls = (toolCalls ?? 0) + run.execution.toolCalls;
      if (!run.passed) failure = run.detail;
      evidenceEventIds.push(this.registry.recordValidationAttempt({
        validationRunId,
        skillId: skill.skillId,
        caseId: target.failureCase.caseId,
        repetition: repetition + 1,
        passed: run.passed,
        durationMs: run.durationMs,
        executorId: this.executor.id,
        detail: run.detail,
      }));
    }
    return {
      caseId: target.failureCase.caseId,
      split: target.failureCase.split,
      repetitions: this.policy.repetitions,
      passed: outcomes.filter(Boolean).length,
      stable: outcomes.every((value) => value === outcomes[0]),
      baselineConfirmed: baselineOutcomes.every(Boolean),
      durationsMs,
      tokenUsage,
      toolCalls,
      evidenceEventIds,
      ...(failure ? { failure } : {}),
    };
  }
}

export class SkillLifecycleController {
  constructor(private readonly registry: SkillRegistry) {}

  applyValidation(report: ValidationReport): HarnessSkill {
    if (report.verdict !== "pass") {
      const skill = this.registry.get(report.skillId);
      if (!skill) throw new Error(`Skill not found: ${report.skillId}`);
      return skill;
    }
    return this.registry.transition(
      report.skillId,
      "completed",
      "Independent deterministic Validation Report satisfies automatic promotion policy.",
      [report.evidenceEventId],
    );
  }
}

interface IsolatedRunResult {
  passed: boolean;
  baselineConfirmed: boolean;
  durationMs: number;
  detail: string;
  execution: SkillExecutionResult;
}

function runInIsolatedWorktree(
  skill: HarnessSkill,
  target: ValidationTarget,
  executor: SkillExecutor,
): IsolatedRunResult {
  const repository = resolve(target.repositoryDirectory);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-harness-validation-"));
  const worktree = resolve(temporaryRoot, "worktree");
  let attached = false;
  const startedAt = performance.now();
  try {
    const add = spawnSync("git", ["-C", repository, "worktree", "add", "--detach", worktree, target.failureCase.source.commitSha], {
      encoding: "utf8", shell: false, timeout: 60_000,
    });
    if (add.status !== 0) return failed(`Git worktree creation failed: ${summarizeOutput(add.stderr)}`);
    attached = true;
    if (target.failureCase.source.workingTreePatch) {
      const apply = spawnSync("git", ["-C", worktree, "apply", "--whitespace=nowarn", "-"], {
        input: target.failureCase.source.workingTreePatch, encoding: "utf8", shell: false, timeout: 60_000,
      });
      if (apply.status !== 0) return failed(`Case snapshot patch failed: ${summarizeOutput(apply.stderr)}`);
    }
    const baselineOracle = target.failureCase.reproductionOracle;
    const baselineInvocation = executableInvocation(baselineOracle.command, baselineOracle.args);
    const baseline = spawnSync(baselineInvocation.command, baselineInvocation.args, {
      cwd: worktree,
      encoding: "utf8",
      shell: false,
      timeout: baselineOracle.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: sanitizedEnvironment(),
    });
    const baselineOutput = `${baseline.stdout ?? ""}\n${baseline.stderr ?? baseline.error?.message ?? ""}`;
    const baselineConfirmed =
      baseline.status === baselineOracle.expectedExitCode &&
      (!baselineOracle.outputIncludes || baselineOutput.includes(baselineOracle.outputIncludes));
    if (!baselineConfirmed) return failed("No-Skill baseline did not reproduce the expected failure.");
    const execution = executor.execute(skill, target.failureCase, worktree);
    if (!execution.succeeded) return result(false, true, execution.detail, execution);
    const oracle = target.failureCase.solutionOracle;
    const invocation = executableInvocation(oracle.command, oracle.args);
    const grader = spawnSync(invocation.command, invocation.args, {
      cwd: worktree, encoding: "utf8", shell: false, timeout: oracle.timeoutMs,
      maxBuffer: 1024 * 1024, env: sanitizedEnvironment(),
    });
    const timedOut = (grader.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const output = `${grader.stdout ?? ""}\n${grader.stderr ?? grader.error?.message ?? ""}`;
    const passed = !timedOut && grader.status === oracle.expectedExitCode && (!oracle.outputIncludes || output.includes(oracle.outputIncludes));
    return result(passed, true, passed ? "Solution oracle passed." : summarizeOutput(output), execution);
  } finally {
    if (attached) spawnSync("git", ["-C", repository, "worktree", "remove", "--force", worktree], { encoding: "utf8", shell: false, timeout: 60_000 });
    const safeRoot = resolve(temporaryRoot);
    if (!safeRoot.startsWith(resolve(tmpdir()))) throw new Error(`Unsafe validation cleanup path: ${safeRoot}`);
    rmSync(safeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  function failed(detail: string): IsolatedRunResult {
    return result(false, false, detail, { succeeded: false, tokenUsage: null, toolCalls: null, detail });
  }
  function result(passed: boolean, baselineConfirmed: boolean, detail: string, execution: SkillExecutionResult): IsolatedRunResult {
    return { passed, baselineConfirmed, durationMs: Math.round(performance.now() - startedAt), detail, execution };
  }
}

function executableInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && command === "npm") return { command: "npm.cmd", args };
  return { command, args };
}
