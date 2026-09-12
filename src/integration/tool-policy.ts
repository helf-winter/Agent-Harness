import type { Stage } from "../domain/lifecycle.js";
import type { ClaudeHookInput } from "./hook-processor.js";

export type HarnessControlMode = "audit" | "enforce";

export interface ToolPolicyContext {
  currentStage?: Stage;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  mode: HarnessControlMode;
  reason: string;
}

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "TodoRead",
  "NotebookRead",
]);

const WRITE_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

const BASH_ALLOWED_STAGES = new Set<Stage>(["EXECUTE", "VERIFY", "REVIEW"]);
const WRITE_ALLOWED_STAGES = new Set<Stage>(["EXECUTE"]);

export function evaluateToolPolicy(
  input: ClaudeHookInput,
  context: ToolPolicyContext,
  mode: HarnessControlMode,
): ToolPolicyDecision {
  if (mode === "audit") {
    return { allowed: true, mode, reason: "Harness control mode is audit." };
  }

  const toolName = input.tool_name ?? "unknown";
  const stage = context.currentStage;
  if (!stage) {
    return {
      allowed: false,
      mode,
      reason: "Harness cannot authorize tool use before an active lifecycle stage exists.",
    };
  }
  if (stage === "COMPLETE") {
    return { allowed: false, mode, reason: "Harness blocks tool use after COMPLETE." };
  }
  if (isHarnessControlPlaneTool(toolName)) {
    return {
      allowed: true,
      mode,
      reason: `Harness allows control-plane tool ${toolName} during ${stage}.`,
    };
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { allowed: true, mode, reason: `Harness allows read-only ${toolName} during ${stage}.` };
  }
  if (WRITE_TOOLS.has(toolName)) {
    return WRITE_ALLOWED_STAGES.has(stage)
      ? { allowed: true, mode, reason: `Harness allows write tool ${toolName} during EXECUTE.` }
      : {
          allowed: false,
          mode,
          reason: `Harness blocks write tool ${toolName} during ${stage}; advance to EXECUTE first.`,
        };
  }
  if (toolName === "Bash") {
    return BASH_ALLOWED_STAGES.has(stage)
      ? { allowed: true, mode, reason: `Harness allows Bash during ${stage}.` }
      : {
          allowed: false,
          mode,
          reason: `Harness blocks Bash during ${stage}; advance to EXECUTE, VERIFY, or REVIEW first.`,
        };
  }

  return {
    allowed: false,
    mode,
    reason: `Harness has no allow rule for tool ${toolName} during ${stage}.`,
  };
}

function isHarnessControlPlaneTool(toolName: string): boolean {
  return toolName === "harness" ||
    toolName.startsWith("harness_") ||
    toolName.startsWith("mcp__harness__");
}
