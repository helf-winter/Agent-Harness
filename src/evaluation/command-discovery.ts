import { existsSync, readFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { EvaluationPlan, GraderCommand } from "./result-evaluator.js";

interface PackageJson {
  scripts?: Record<string, string>;
}

export function discoverEvaluationPlan(projectDirectory: string): EvaluationPlan {
  const packagePath = resolve(projectDirectory, "package.json");
  if (!existsSync(packagePath)) {
    return { projectDirectory, commands: [] };
  }

  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
  const scripts = packageJson.scripts ?? {};
  const packageManager = detectPackageManager(projectDirectory);
  const commands: GraderCommand[] = [];

  addScript(commands, scripts, packageManager, "typecheck", ["typecheck", "check:types"]);
  addScript(commands, scripts, packageManager, "build", ["build"]);
  addScript(commands, scripts, packageManager, "test", ["test"], (script) =>
    !/no test specified/i.test(script),
  );

  return { projectDirectory, commands };
}

function addScript(
  commands: GraderCommand[],
  scripts: Record<string, string>,
  packageManager: string,
  id: string,
  candidates: string[],
  predicate: (script: string) => boolean = () => true,
): void {
  const scriptName = candidates.find((candidate) => scripts[candidate] && predicate(scripts[candidate]));
  if (!scriptName) return;
  const invocation = packageManagerInvocation(packageManager);
  commands.push({
    id,
    command: invocation.command,
    args: [
      ...invocation.prefixArgs,
      ...(packageManager === "npm" ? ["run", scriptName] : [scriptName]),
    ],
    required: true,
    timeoutMs: 120_000,
  });
}

function detectPackageManager(projectDirectory: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (existsSync(resolve(projectDirectory, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(projectDirectory, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(projectDirectory, "bun.lock")) || existsSync(resolve(projectDirectory, "bun.lockb"))) {
    return "bun";
  }
  return "npm";
}

function packageManagerInvocation(packageManager: string): {
  command: string;
  prefixArgs: string[];
} {
  if (process.platform === "win32" && packageManager === "npm") {
    const npmCli = resolveNpmCli();
    if (npmCli) return { command: process.execPath, prefixArgs: [npmCli] };
  }
  return {
    command: process.platform === "win32" ? `${packageManager}.cmd` : packageManager,
    prefixArgs: [],
  };
}

function resolveNpmCli(): string | undefined {
  const fromEnvironment = process.env.npm_execpath;
  if (fromEnvironment && existsSync(fromEnvironment)) return resolve(fromEnvironment);
  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    if (!pathEntry) continue;
    const candidate = resolve(pathEntry, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
