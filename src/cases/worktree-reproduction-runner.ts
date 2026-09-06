import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sanitizedEnvironment, summarizeOutput } from "../evaluation/result-evaluator.js";
import type { FailureCase, ReproductionRecord } from "./types.js";

export class WorktreeReproductionRunner {
  reproduce(failureCase: FailureCase, repositoryDirectory: string): ReproductionRecord {
    const repository = resolve(repositoryDirectory);
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-harness-case-"));
    const worktree = resolve(temporaryRoot, "worktree");
    let attached = false;
    try {
      const verify = spawnSync(
        "git",
        ["-C", repository, "rev-parse", "--verify", `${failureCase.source.commitSha}^{commit}`],
        { encoding: "utf8", shell: false },
      );
      if (verify.status !== 0) {
        return failedRecord(failureCase, `Git commit is unavailable: ${summarizeOutput(verify.stderr)}`);
      }
      const add = spawnSync(
        "git",
        ["-C", repository, "worktree", "add", "--detach", worktree, failureCase.source.commitSha],
        { encoding: "utf8", shell: false, timeout: 60_000 },
      );
      if (add.status !== 0) {
        return failedRecord(failureCase, `Git worktree creation failed: ${summarizeOutput(add.stderr)}`);
      }
      attached = true;

      if (failureCase.source.workingTreePatch) {
        const apply = spawnSync("git", ["-C", worktree, "apply", "--whitespace=nowarn", "-"], {
          input: failureCase.source.workingTreePatch,
          encoding: "utf8",
          shell: false,
          timeout: 60_000,
        });
        if (apply.status !== 0) {
          return failedRecord(failureCase, `Snapshot patch could not be applied: ${summarizeOutput(apply.stderr)}`);
        }
      }

      const invocation = executableInvocation(
        failureCase.reproductionOracle.command,
        failureCase.reproductionOracle.args,
      );
      const startedAt = performance.now();
      const child = spawnSync(invocation.command, invocation.args, {
        cwd: worktree,
        encoding: "utf8",
        shell: false,
        timeout: failureCase.reproductionOracle.timeoutMs,
        maxBuffer: 1024 * 1024,
        env: sanitizedEnvironment(),
      });
      const durationMs = Math.round(performance.now() - startedAt);
      const timedOut = (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      const stdout = summarizeOutput(child.stdout ?? "");
      const stderr = summarizeOutput(child.stderr ?? child.error?.message ?? "");
      const output = `${stdout}\n${stderr}`;
      const reproduced =
        !timedOut &&
        child.status === failureCase.reproductionOracle.expectedExitCode &&
        (!failureCase.reproductionOracle.outputIncludes ||
          output.includes(failureCase.reproductionOracle.outputIncludes));
      return {
        reproduced,
        exitCode: child.status,
        timedOut,
        durationMs,
        stdout,
        stderr,
        commitSha: failureCase.source.commitSha,
      };
    } finally {
      if (attached) {
        spawnSync("git", ["-C", repository, "worktree", "remove", "--force", worktree], {
          encoding: "utf8",
          shell: false,
          timeout: 60_000,
        });
      }
      const resolvedTemporaryRoot = resolve(temporaryRoot);
      if (!resolvedTemporaryRoot.startsWith(resolve(tmpdir()))) {
        throw new Error(`Refusing to clean unsafe temporary path: ${resolvedTemporaryRoot}`);
      }
      rmSync(resolvedTemporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
}

function failedRecord(failureCase: FailureCase, stderr: string): ReproductionRecord {
  return {
    reproduced: false,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    stdout: "",
    stderr,
    commitSha: failureCase.source.commitSha,
  };
}

function executableInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && command === "npm") {
    const npmCli = process.env.npm_execpath;
    if (npmCli) return { command: process.execPath, args: [npmCli, ...args] };
    return { command: "npm.cmd", args };
  }
  return { command, args };
}
