import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("starts Agent Harness through a CCR-owned Claude launcher", () => {
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
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toContain("Starting Agent Harness through Claude Code Router");
    expect(result.stdout).toContain("CLAUDE_EXECUTABLE=");
    expect(result.stdout).toContain("scripts/ccr-claude.sh");
    expect(result.stdout).toContain("npm run dev -- controlled-run --permission-mode acceptEdits");
    expect(result.stdout).not.toContain("ANTHROPIC_BASE_URL");
    expect(result.stdout).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(result.stdout).not.toContain("ANTHROPIC_API_KEY");
  });

  it("delegates Claude arguments to the selected CCR profile", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-ccr-profile-"));
    temporaryDirectories.push(directory);
    const fakeBin = join(directory, "bin");
    const captureFile = join(directory, "ccr-arguments.txt");
    const fakeCcr = join(fakeBin, "ccr");
    mkdirSync(fakeBin);
    writeFileSync(fakeCcr, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$CCR_CAPTURE_FILE"\n`);
    chmodSync(fakeCcr, 0o700);

    const result = spawnSync("bash", ["scripts/ccr-claude.sh", "--version"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        CCR_CAPTURE_FILE: captureFile,
        AGENT_HARNESS_CCR_PROFILE: "test-claude-profile",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(captureFile, "utf8").trim().split("\n")).toEqual([
      "test-claude-profile",
      "cli",
      "--",
      "--settings",
      resolve("config/claude-model-picker.json"),
      "--version",
    ]);
  });

  it("exposes only the five supported provider models in the Claude picker", () => {
    const settings = JSON.parse(readFileSync(resolve("config/claude-model-picker.json"), "utf8")) as {
      apiKeyHelper: string;
      availableModels: string[];
      enforceAvailableModels: boolean;
      env: Record<string, string>;
      modelPicker: {
        replaceBuiltInOptions: boolean;
        options: Array<{ model: string }>;
      };
    };
    const expectedModels = [
      "ark/glm-5.3-flash",
      "ark/kimi-k2.7-code",
      "ark/kimi-k3",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
    ];

    expect(settings.apiKeyHelper).toBe("bash scripts/ccr-api-key-helper.sh");
    expect(settings.availableModels).toEqual(expectedModels);
    expect(settings.enforceAvailableModels).toBe(true);
    expect(settings.env).toMatchObject({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "ark/glm-5.3-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "ark/glm-5.3-flash",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "ark/glm-5.3-flash",
    });
    expect(settings.modelPicker.replaceBuiltInOptions).toBe(true);
    expect(settings.modelPicker.options.map(({ model }) => model)).toEqual(expectedModels);
  });

  it("returns the current CCR profile identity instead of an upstream provider key", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-ccr-identity-"));
    temporaryDirectories.push(directory);
    const identityFile = join(directory, "identity-token");
    writeFileSync(identityFile, "test-ccr-profile-identity\n", { mode: 0o600 });

    const result = spawnSync("bash", ["scripts/ccr-api-key-helper.sh"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        ANTHROPIC_IDENTITY_TOKEN_FILE: identityFile,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toBe("test-ccr-profile-identity\n");
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
    expect(readFileSync(join(binDirectory, "kimi3"), "utf8")).toContain("ark-kimi3");
  });

  it("updates old unmarked Agent Harness provider shortcuts", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-old-shortcuts-"));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    writeFileSync(
      join(binDirectory, "glm"),
      "#!/usr/bin/env bash\nset -euo pipefail\ncd \"/old/repo\"\nexec bash scripts/claude-provider.sh \"ark-glm\" \"$@\"\n",
      { mode: 0o700 },
    );

    const result = spawnSync("bash", ["scripts/install-claude-shortcuts.sh"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_HARNESS_BIN_DIR: binDirectory,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const shortcut = readFileSync(join(binDirectory, "glm"), "utf8");
    expect(shortcut).toContain("agent-harness claude provider shortcut");
    expect(shortcut).toContain("AGENT_HARNESS_WORKING_DIRECTORY");
  });

  it("preserves the caller working directory when using the installed harness shortcut", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-harness-shortcut-cwd-"));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, "bin");
    const projectDirectory = join(directory, "project");
    mkdirSync(projectDirectory);

    const install = spawnSync("bash", ["scripts/install-claude-shortcuts.sh"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_HARNESS_BIN_DIR: binDirectory,
      },
    });
    expect(install.status, install.stderr || install.stdout).toBe(0);

    const result = spawnSync(join(binDirectory, "harness"), ["--print", "pwd"], {
      cwd: projectDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_HARNESS_DRY_RUN: "1",
        AGENT_HARNESS_START_CCR: "0",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(`AGENT_HARNESS_WORKING_DIRECTORY=${projectDirectory}`);
  });
});
