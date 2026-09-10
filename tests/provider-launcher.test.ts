import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`Unsafe test path: ${target}`);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("Claude provider launcher", () => {
  it("starts Agent Harness first instead of executing Claude Code directly", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-provider-"));
    temporaryDirectories.push(directory);
    const fakeBin = join(directory, "bin");
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, "claude"),
      "#!/usr/bin/env bash\nprintf 'direct claude %s\\n' \"$*\"\n",
      { mode: 0o700 },
    );

    const result = spawnSync("bash", ["scripts/claude-provider.sh", "ark-kimi"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        ARK_API_KEY: "test-ark-key",
        AGENT_HARNESS_DRY_RUN: "1",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toContain("Starting Agent Harness with Volcano Ark (kimi-k2.7-code).");
    expect(result.stdout).toContain("npm run dev -- run --model kimi-k2.7-code");
    expect(result.stdout).not.toContain("direct claude");
  });
});
