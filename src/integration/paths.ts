import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function harnessHome(): string {
  return resolve(process.env.HARNESS_HOME ?? resolve(homedir(), ".agent-harness"));
}

export function harnessDatabasePath(): string {
  return resolve(process.env.HARNESS_DB_PATH ?? resolve(harnessHome(), "harness.sqlite"));
}

export function stableProjectId(projectDirectory: string): string {
  const normalized = resolve(projectDirectory).replaceAll("\\", "/").toLowerCase();
  return `prj_${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export function stableSessionId(claudeSessionId: string): string {
  return `ses_${createHash("sha256").update(claudeSessionId).digest("hex").slice(0, 24)}`;
}

export function stableChildId(prefix: string, sourceId: string): string {
  return `${prefix}_${createHash("sha256").update(sourceId).digest("hex").slice(0, 24)}`;
}
