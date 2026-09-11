import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`Unsafe test path: ${target}`);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("Harness CCR launcher", () => {
  it("starts Agent Harness through CCR without pinning a provider model", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-ccr-"));
    temporaryDirectories.push(directory);
    const fakeBin = join(directory, "bin");
    const result = spawnSync("bash", ["scripts/harness.sh", "--permission-mode", "acceptEdits"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        AGENT_HARNESS_DRY_RUN: "1",
        AGENT_HARNESS_START_CCR: "0",
        AGENT_HARNESS_CCR_BASE_URL: "http://127.0.0.1:3456",
        AGENT_HARNESS_CCR_AUTH_TOKEN: "test-client-key",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toContain("Starting Agent Harness through Claude Code Router");
    expect(result.stdout).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:3456");
    expect(result.stdout).toContain("npm run dev -- controlled-run --permission-mode acceptEdits");
    expect(result.stdout).not.toContain("--model");
  });

  it("installs the harness shortcut beside legacy provider shortcuts", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-shortcuts-"));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, "bin");

    const result = spawnSync("bash", ["scripts/install-claude-shortcuts.sh"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_HARNESS_BIN_DIR: binDirectory,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const harnessShortcut = readFileSync(join(binDirectory, "harness"), "utf8");
    expect(harnessShortcut).toContain("agent-harness ccr shortcut");
    expect(harnessShortcut).toContain("exec bash scripts/harness.sh");
    expect(readFileSync(join(binDirectory, "cc"), "utf8")).toContain("claude-provider-menu.sh");
  });
});
