import type { Stage } from "../domain/lifecycle.js";
import type { ClaudeHookInput } from "./hook-processor.js";

export type HarnessSafetyMode = "audit" | "enforce";

export interface ToolPolicyContext {
  currentStage?: Stage;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  mode: HarnessSafetyMode;
  reason: string;
}

/**
 * Irreversible operations the harness refuses to run silently. Approval and
 * simulation are left to Claude Code's native permission system; the harness
 * only hard-stops the handful of commands that destroy state with no cheap
 * recovery path, and records every Bash invocation to the ledger regardless.
 */
const DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = [
  // rm -rf / rm -fr (recursive + force combined) and rm --recursive
  // Deliberately narrow: a plain `rm -f` or `rm -r` on a single path is common
  // and recoverable-enough to leave to Claude Code's native approval.
  /\brm\s+(-rf|-fr)\b/i,
  /\brm\s+--recursive\b/i,
  // git reset --hard (discards uncommitted work)
  /\bgit\s+reset\s+--hard\b/i,
  // git clean -f / -fd / --force (deletes untracked files)
  /\bgit\s+clean\s+(-[a-z]*[fd][a-z]*|--force)\b/i,
  // git push --force / -f (overwrites remote history)
  /\bgit\s+push\b[^\n]*\s(-f|--force)(\s|$)/i,
  // git branch -D (deletes a branch)
  /\bgit\s+branch\s+-D\b/i,
  // drop table / database / schema
  /\bdrop\s+(table|database|schema)\b/i,
];

export function evaluateToolPolicy(
  input: ClaudeHookInput,
  context: ToolPolicyContext,
  mode: HarnessSafetyMode,
): ToolPolicyDecision {
  if (mode === "audit") {
    return { allowed: true, mode, reason: "Harness safety mode is audit." };
  }

  const toolName = input.tool_name ?? "unknown";

  if (isHarnessControlPlaneTool(toolName)) {
    return { allowed: true, mode, reason: `Harness allows control-plane tool ${toolName}.` };
  }

  if (context.currentStage === "COMPLETE") {
    return { allowed: false, mode, reason: "Harness blocks tool use after COMPLETE." };
  }

  if (toolName === "Bash" && isDestructiveCommand(input.tool_input?.command)) {
    return {
      allowed: false,
      mode,
      reason: "Harness blocks destructive command; use an explicit, recoverable alternative.",
    };
  }

  return { allowed: true, mode, reason: `Harness allows ${toolName}.` };
}

function isDestructiveCommand(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function isHarnessControlPlaneTool(toolName: string): boolean {
  return (
    toolName === "harness" ||
    toolName.startsWith("harness_") ||
    toolName.startsWith("mcp__harness__") ||
    toolName.startsWith("mcp__plugin_agent-harness")
  );
}
