#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessDatabasePath, stableProjectId } from "./integration/paths.js";
import { ProjectionStore } from "./projections/projection-store.js";
import { EventLedger } from "./storage/event-ledger.js";

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

  return checks.slice(0, 4).every((check) => check.ok) ? 0 : 1;
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

function help(): void {
  console.log(`Agent Harness

Usage:
  harness doctor
  harness run [claude arguments...]
  harness trace list
  harness trace show <trace-id>`);
}

const [command = "help", subcommand, argument] = process.argv.slice(2);
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
  default:
    help();
}
