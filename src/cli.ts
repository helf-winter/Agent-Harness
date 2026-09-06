#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const MINIMUM_CLAUDE_VERSION = "2.1.220";

interface Check {
  name: string;
  ok: boolean;
  value: string;
  detail?: string;
}

function commandVersion(command: string, args: string[]): { ok: boolean; value: string } {
  const useCommandShell = process.platform === "win32" && command === "claude";
  const executable = useCommandShell ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArgs = useCommandShell ? ["/d", "/s", "/c", `claude ${args.join(" ")}`] : args;
  const result = spawnSync(executable, executableArgs, { encoding: "utf8", shell: false });
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
  const node = commandVersion(process.execPath, ["--version"]);
  const git = commandVersion("git", ["--version"]);
  const bash = commandVersion("bash", ["--version"]);
  const claude = commandVersion("claude", ["--version"]);
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

const command = process.argv[2] ?? "help";
if (command === "doctor") {
  process.exitCode = doctor();
} else {
  console.log("Usage: harness doctor");
}
