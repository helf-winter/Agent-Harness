#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FailureCaseService } from "./cases/failure-case-service.js";
import { CaseRegistry } from "./cases/case-registry.js";
import type { CaseSplit, CaseStatus, FailureCase } from "./cases/types.js";
import { ExperienceCurator } from "./experiences/experience-curator.js";
import { ExperienceStore } from "./experiences/experience-store.js";
import type { ExperienceStatus } from "./experiences/types.js";
import { EvolutionService } from "./evolution/evolution-service.js";
import { harnessDatabasePath, stableProjectId } from "./integration/paths.js";
import { ProjectionStore } from "./projections/projection-store.js";
import { SkillExposureAdapter } from "./skills/skill-exposure-adapter.js";
import { SkillGenerator } from "./skills/skill-generator.js";
import { SkillRegistry } from "./skills/skill-registry.js";
import type { SkillStatus } from "./skills/types.js";
import { EventLedger } from "./storage/event-ledger.js";
import { ClaudeCodeSkillExecutor } from "./validation/claude-code-skill-executor.js";
import { SkillLifecycleController, SkillValidationAgent } from "./validation/skill-validation-agent.js";

const MINIMUM_CLAUDE_VERSION = "2.1.220";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Check {
  name: string;
  ok: boolean;
  value: string;
  detail?: string;
}

function resolveClaudeExecutable(): string {
  if (process.env.CLAUDE_EXECUTABLE) return resolve(process.env.CLAUDE_EXECUTABLE);
  if (process.platform !== "win32") return "claude";

  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    if (!pathEntry) continue;
    const packagePath = resolve(
      pathEntry,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "package.json",
    );
    if (!existsSync(packagePath)) continue;
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.claude;
    if (bin) return resolve(dirname(packagePath), bin);
  }

  return "claude";
}

function commandVersion(command: string, args: string[]): { ok: boolean; value: string } {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  const output = (result.stdout || result.stderr || "").replaceAll("\0", "").trim();
  const value = output.split(/\r?\n/).find((line) => /\d+\.\d+/.test(line)) ?? output;
  return { ok: result.status === 0, value };
}

function numericVersion(value: string): number[] {
  return value.match(/\d+\.\d+\.\d+/)?.[0]?.split(".").map(Number) ?? [];
}

function atLeast(actual: number[], required: number[]): boolean {
  for (let index = 0; index < required.length; index += 1) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function doctor(): number {
  const claudeExecutable = resolveClaudeExecutable();
  const node = commandVersion(process.execPath, ["--version"]);
  const git = commandVersion("git", ["--version"]);
  const bash = commandVersion("bash", ["--version"]);
  const claude = commandVersion(claudeExecutable, ["--version"]);
  const claudeAuthProcess = spawnSync(claudeExecutable, ["auth", "status"], {
    encoding: "utf8",
    shell: false,
  });
  let claudeLoggedIn = false;
  try {
    claudeLoggedIn = (JSON.parse(claudeAuthProcess.stdout || "{}") as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    claudeLoggedIn = false;
  }
  const repository = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    shell: false,
  });
  const repositoryHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    shell: false,
  });
  const worktreeReady = repository.status === 0 && repositoryHead.status === 0;

  const checks: Check[] = [
    { name: "node", ok: node.ok && atLeast(numericVersion(node.value), [22, 0, 0]), value: node.value },
    { name: "git", ok: git.ok, value: git.value },
    { name: "bash", ok: bash.ok, value: bash.value },
    {
      name: "claude",
      ok: claude.ok && atLeast(numericVersion(claude.value), numericVersion(MINIMUM_CLAUDE_VERSION)),
      value: claude.value,
      detail: `minimum ${MINIMUM_CLAUDE_VERSION}`,
    },
    {
      name: "claude-auth",
      ok: claudeAuthProcess.status === 0 && claudeLoggedIn,
      value: claudeLoggedIn ? "logged in" : "not logged in; run `claude` and use /login",
    },
    {
      name: "git-worktree",
      ok: worktreeReady,
      value:
        repository.status !== 0
          ? "current directory is not a Git repository"
          : repositoryHead.status !== 0
            ? "Git repository has no commits"
            : "available",
      detail: "Required for Case reproduction and Skill validation, not for schema development.",
    },
  ];

  for (const check of checks) {
    const mark = check.ok ? "PASS" : "WARN";
    console.log(`${mark.padEnd(4)} ${check.name.padEnd(14)} ${check.value}`);
    if (check.detail) console.log(`     ${check.detail}`);
  }

  return checks.every((check) => check.ok) ? 0 : 1;
}

function runClaude(args: string[]): number {
  const pluginDirectory = resolve(PACKAGE_ROOT, "plugin");
  const managedPrompt = resolve(pluginDirectory, "managed-prompt.md");
  const hookEntry = resolve(PACKAGE_ROOT, "dist", "integration", "hook-entry.js");
  if (!existsSync(hookEntry)) {
    console.error(`Built Hook entry not found: ${hookEntry}`);
    console.error("Run `npm run build` before starting Harness.");
    return 1;
  }

  const claudeExecutable = resolveClaudeExecutable();
  const claudeVersion = commandVersion(claudeExecutable, ["--version"]);
  if (!claudeVersion.ok) {
    console.error("Claude Code executable was not found.");
    return 1;
  }
  if (!atLeast(numericVersion(claudeVersion.value), numericVersion(MINIMUM_CLAUDE_VERSION))) {
    console.error(`Claude Code ${MINIMUM_CLAUDE_VERSION}+ is required; found ${claudeVersion.value}.`);
    return 1;
  }

  const projectDirectory = process.cwd();
  const child = spawnSync(
    claudeExecutable,
    ["--plugin-dir", pluginDirectory, "--append-system-prompt-file", managedPrompt, ...args],
    {
    cwd: projectDirectory,
    env: {
      ...process.env,
      HARNESS_RUNTIME_INSTANCE_ID: `runtime_${randomUUID()}`,
      HARNESS_PROJECT_ID: stableProjectId(projectDirectory),
      HARNESS_PROJECT_DIR: projectDirectory,
      HARNESS_DB_PATH: harnessDatabasePath(),
      HARNESS_CLAUDE_VERSION: numericVersion(claudeVersion.value).join("."),
    },
    stdio: "inherit",
      shell: false,
    },
  );

  if (child.error) {
    console.error(child.error.message);
    return 1;
  }
  return child.status ?? 1;
}

function listTraces(): number {
  const databasePath = harnessDatabasePath();
  if (!existsSync(databasePath)) {
    console.log("No Harness traces have been recorded yet.");
    return 0;
  }
  const projection = new ProjectionStore(databasePath);
  const traces = projection.listTraces();
  projection.close();
  if (traces.length === 0) {
    console.log("No Harness traces have been recorded yet.");
    return 0;
  }
  console.table(
    traces.map((trace) => ({
      traceId: trace.traceId,
      task: trace.taskTitle,
      stage: trace.currentStage,
      status: trace.status,
      startedAt: trace.startedAt,
    })),
  );
  return 0;
}

function showTrace(traceId: string | undefined): number {
  if (!traceId) {
    console.error("Usage: harness trace show <trace-id>");
    return 1;
  }
  const databasePath = harnessDatabasePath();
  if (!existsSync(databasePath)) {
    console.error("Harness database does not exist.");
    return 1;
  }
  const projection = new ProjectionStore(databasePath);
  const trace = projection.getTrace(traceId);
  projection.close();
  if (!trace) {
    console.error(`Trace not found: ${traceId}`);
    return 1;
  }
  const ledger = new EventLedger(databasePath);
  const events = ledger.listTraceEvidence(traceId, trace.taskId, trace.sessionId);
  const chain = ledger.verifyChain();
  ledger.close();
  console.log(JSON.stringify({ trace, chain, events }, null, 2));
  return 0;
}

function withCaseService<T>(callback: (service: FailureCaseService) => T): T {
  const databasePath = harnessDatabasePath();
  const ledger = new EventLedger(databasePath);
  const projection = new ProjectionStore(databasePath);
  const service = new FailureCaseService(databasePath, ledger, projection);
  try {
    return callback(service);
  } finally {
    service.close();
    projection.close();
    ledger.close();
  }
}

function listCases(status?: string): number {
  const allowed = ["raw", "triaged", "reproducible", "approved", "active", "deprecated"];
  if (status && !allowed.includes(status)) {
    console.error(`Invalid Case status: ${status}`);
    return 1;
  }
  const cases = withCaseService((service) => service.registry.list(status as CaseStatus | undefined));
  if (cases.length === 0) {
    console.log("No matching Cases exist.");
    return 0;
  }
  console.table(
    cases.map((failureCase) => ({
      caseId: failureCase.caseId,
      title: failureCase.title,
      status: failureCase.status,
      split: failureCase.split,
      traceId: failureCase.source.traceId,
    })),
  );
  return 0;
}

function curateCase(traceId: string | undefined): number {
  if (!traceId) {
    console.error("Usage: harness case curate <trace-id>");
    return 1;
  }
  const result = withCaseService((service) => service.curate(traceId, process.cwd()));
  console.log(JSON.stringify(result, null, 2));
  return result.accepted ? 0 : 1;
}

function reproduceCase(caseId: string | undefined): number {
  if (!caseId) {
    console.error("Usage: harness case reproduce <case-id>");
    return 1;
  }
  const result = withCaseService((service) =>
    service.reproduceAndPromote(caseId, process.cwd()),
  );
  console.log(JSON.stringify(result, null, 2));
  return result.reproduction.reproduced ? 0 : 1;
}

function showCase(caseId: string | undefined): number {
  if (!caseId) {
    console.error("Usage: harness case show <case-id>");
    return 1;
  }
  const failureCase = withCaseService((service) => service.registry.get(caseId));
  if (!failureCase) {
    console.error(`Case not found: ${caseId}`);
    return 1;
  }
  console.log(JSON.stringify(summarizeCase(failureCase), null, 2));
  return 0;
}

function assignCaseSplit(caseId: string | undefined, split: string | undefined): number {
  const allowed = ["development", "validation", "regression", "holdout", "resilience"];
  if (!caseId || !split || !allowed.includes(split)) {
    console.error("Usage: harness case assign-split <case-id> <development|validation|regression|holdout|resilience>");
    return 1;
  }
  const failureCase = withCaseService((service) =>
    service.registry.assignSplit(caseId, split as CaseSplit, "Explicit dataset assignment through Harness CLI."),
  );
  console.log(JSON.stringify(summarizeCase(failureCase), null, 2));
  return 0;
}

function summarizeCase(failureCase: FailureCase): Record<string, unknown> {
  return {
    ...failureCase,
    source: {
      ...failureCase.source,
      workingTreePatch:
        failureCase.source.workingTreePatch.length === 0
          ? ""
          : `<${failureCase.source.workingTreePatch.length} character patch>`,
    },
  };
}

interface AssetServices {
  ledger: EventLedger;
  projection: ProjectionStore;
  cases: CaseRegistry;
  experiences: ExperienceStore;
  skills: SkillRegistry;
}

function withAssetServices<T>(callback: (services: AssetServices) => T): T {
  const databasePath = harnessDatabasePath();
  const ledger = new EventLedger(databasePath);
  const projection = new ProjectionStore(databasePath);
  const cases = new CaseRegistry(databasePath, ledger);
  const experiences = new ExperienceStore(databasePath, ledger);
  const skills = new SkillRegistry(databasePath, ledger);
  try {
    return callback({ ledger, projection, cases, experiences, skills });
  } finally {
    skills.close();
    experiences.close();
    cases.close();
    projection.close();
    ledger.close();
  }
}

function listExperiences(status?: string): number {
  const allowed = ["candidate", "usable", "deprecated"];
  if (status && !allowed.includes(status)) {
    console.error(`Invalid Experience status: ${status}`);
    return 1;
  }
  const values = withAssetServices(({ experiences }) => experiences.list(status as ExperienceStatus | undefined));
  if (values.length === 0) console.log("No matching Experiences exist.");
  else console.table(values.map((item) => ({ experienceId: item.experienceId, title: item.title, status: item.status, confidence: item.confidence, traces: item.source.traceIds.length })));
  return 0;
}

function curateExperience(traceId: string | undefined): number {
  if (!traceId) {
    console.error("Usage: harness experience curate <trace-id>");
    return 1;
  }
  const result = withAssetServices(({ ledger, projection, experiences }) =>
    new ExperienceCurator(ledger, projection, experiences).curate(traceId),
  );
  console.log(JSON.stringify(result, null, 2));
  return result.accepted ? 0 : 1;
}

function listSkills(status?: string): number {
  const allowed = ["testing", "completed", "quarantined", "deprecated", "rejected"];
  if (status && !allowed.includes(status)) {
    console.error(`Invalid Skill status: ${status}`);
    return 1;
  }
  const values = withAssetServices(({ skills }) => skills.list(status as SkillStatus | undefined));
  if (values.length === 0) console.log("No matching Skills exist.");
  else console.table(values.map((item) => ({ skillId: item.skillId, name: item.name, version: item.version, status: item.status, validationRuns: item.baseline.validationRunIds.length })));
  return 0;
}

function generateSkill(experienceIds: string[]): number {
  if (experienceIds.length === 0) {
    console.error("Usage: harness skill generate <experience-id> [experience-id...]");
    return 1;
  }
  const result = withAssetServices(({ experiences, skills }) =>
    new SkillGenerator(experiences, skills).generate(experienceIds),
  );
  console.log(JSON.stringify({ created: result.created, skillId: result.skill.skillId, status: result.skill.status, name: result.skill.name }, null, 2));
  return 0;
}

function validateSkill(skillId: string | undefined): number {
  if (!skillId) {
    console.error("Usage: harness skill validate <skill-id>");
    return 1;
  }
  const repository = process.cwd();
  const projectId = stableProjectId(repository);
  const result = withAssetServices(({ cases, skills }) => {
    const targets = cases.list("active")
      .filter((failureCase) => failureCase.source.projectId === projectId)
      .map((failureCase) => ({ failureCase, repositoryDirectory: repository }));
    const report = new SkillValidationAgent(skills, new ClaudeCodeSkillExecutor()).validate(skillId, targets);
    const skill = new SkillLifecycleController(skills).applyValidation(report);
    return { report, skill };
  });
  console.log(JSON.stringify(result, null, 2));
  return result.report.verdict === "pass" ? 0 : 1;
}

function exportSkill(skillId: string | undefined): number {
  if (!skillId) {
    console.error("Usage: harness skill export <skill-id>");
    return 1;
  }
  const destination = withAssetServices(({ skills }) =>
    new SkillExposureAdapter(skills).exportCompleted(skillId, process.cwd()),
  );
  console.log(`Exported completed Skill to ${destination}`);
  return 0;
}

function evolveTrace(traceId: string | undefined, repositoryDirectory?: string): number {
  if (!traceId) {
    console.error("Usage: harness evolve <trace-id> [repository-directory]");
    return 1;
  }
  const repository = resolve(repositoryDirectory ?? process.cwd());
  const result = withAssetServices(({ ledger, projection, cases, experiences, skills }) =>
    new EvolutionService(
      ledger,
      projection,
      cases,
      experiences,
      skills,
      process.env.HARNESS_VALIDATION_API_KEY ? new ClaudeCodeSkillExecutor() : undefined,
    ).processTrace(traceId, repository),
  );
  console.log(JSON.stringify(result, null, 2));
  return result.processed === true ? 0 : 1;
}

function reportOverview(): number {
  const report = withAssetServices(({ ledger, cases, experiences, skills }) => {
    const events = ledger.list(1_000_000);
    const countBy = (values: string[]) => Object.fromEntries(
      [...new Set(values)].sort().map((value) => [value, values.filter((candidate) => candidate === value).length]),
    );
    return {
      generatedAt: new Date().toISOString(),
      ledger: {
        events: events.length,
        chain: ledger.verifyChain(),
        redactedEvents: events.filter((event) => event.redaction.status === "applied").length,
      },
      cases: countBy(cases.list().map((item) => item.status)),
      experiences: countBy(experiences.list().map((item) => item.status)),
      skills: countBy(skills.list().map((item) => item.status)),
      validationRuns: events.filter((event) => event.eventType === "validation.completed").length,
      recalls: events.filter((event) => event.eventType === "recall.performed").length,
      recallFeedback: events.filter((event) => event.eventType === "recall.feedback_recorded").length,
    };
  });
  console.log(JSON.stringify(report, null, 2));
  return report.ledger.chain.valid ? 0 : 1;
}

function help(): void {
  console.log(`Agent Harness

Usage:
  harness doctor
  harness run [claude arguments...]
  harness trace list
  harness trace show <trace-id>
  harness case list [status]
  harness case show <case-id>
  harness case curate <trace-id>
  harness case reproduce <case-id>
  harness case assign-split <case-id> <split>
  harness experience list [status]
  harness experience curate <trace-id>
  harness skill list [status]
  harness skill generate <experience-id> [experience-id...]
  harness skill validate <skill-id>
  harness skill export <skill-id>
  harness evolve <trace-id> [repository-directory]
  harness report`);
}

const [command = "help", subcommand, argument, ...extraArguments] = process.argv.slice(2);
switch (command) {
  case "doctor":
    process.exitCode = doctor();
    break;
  case "run":
    process.exitCode = runClaude(process.argv.slice(3));
    break;
  case "trace":
    process.exitCode = subcommand === "list" ? listTraces() : showTrace(argument);
    break;
  case "case":
    process.exitCode =
      subcommand === "list"
        ? listCases(argument)
        : subcommand === "show"
          ? showCase(argument)
          : subcommand === "curate"
            ? curateCase(argument)
          : subcommand === "reproduce"
              ? reproduceCase(argument)
              : subcommand === "assign-split"
                ? assignCaseSplit(argument, extraArguments[0])
              : (help(), 1);
    break;
  case "experience":
    process.exitCode = subcommand === "list" ? listExperiences(argument) : subcommand === "curate" ? curateExperience(argument) : (help(), 1);
    break;
  case "skill":
    process.exitCode =
      subcommand === "list"
        ? listSkills(argument)
        : subcommand === "generate"
          ? generateSkill([argument, ...extraArguments].filter((value): value is string => Boolean(value)))
          : subcommand === "validate"
            ? validateSkill(argument)
            : subcommand === "export"
              ? exportSkill(argument)
              : (help(), 1);
    break;
  case "evolve":
    process.exitCode = evolveTrace(subcommand, argument);
    break;
  case "report":
    process.exitCode = reportOverview();
    break;
  default:
    help();
}
