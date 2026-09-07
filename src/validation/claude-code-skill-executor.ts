import { spawnSync } from "node:child_process";
import type { FailureCase } from "../cases/types.js";
import { sanitizedEnvironment, summarizeOutput } from "../evaluation/result-evaluator.js";
import type { HarnessSkill } from "../skills/types.js";
import type { SkillExecutionResult, SkillExecutor } from "./skill-validation-agent.js";

export class ClaudeCodeSkillExecutor implements SkillExecutor {
  readonly id = "claude-code-independent-validator";

  constructor(
    private readonly executable = process.env.HARNESS_VALIDATION_CLAUDE_EXECUTABLE ?? "claude",
    private readonly apiKey = process.env.HARNESS_VALIDATION_AUTH_TOKEN ?? process.env.HARNESS_VALIDATION_API_KEY,
    private readonly baseUrl = process.env.HARNESS_VALIDATION_BASE_URL,
    private readonly model = process.env.HARNESS_VALIDATION_MODEL,
  ) {}

  execute(skill: HarnessSkill, failureCase: FailureCase, worktree: string): SkillExecutionResult {
    if (!this.apiKey) {
      return {
        succeeded: false,
        tokenUsage: null,
        toolCalls: null,
        detail: "HARNESS_VALIDATION_AUTH_TOKEN (or legacy HARNESS_VALIDATION_API_KEY) is required; independent validation never reads the user's Claude login or keychain.",
      };
    }
    const prompt = [
      `Repair this isolated Case: ${failureCase.title}`,
      "Follow the supplied candidate Skill. Work only inside the current repository.",
      "Do not use network access or destructive commands. Finish only after the solution oracle passes.",
      "",
      skill.markdown,
    ].join("\n");
    const child = spawnSync(
      this.executable,
      [
        "--print",
        "--bare",
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,Grep,Glob,Edit,Bash(npm test:*),Bash(npm run test:*),Bash(npm run typecheck:*),Bash(npm run build:*),Bash(git diff:*)",
        "--max-budget-usd",
        "1",
        ...(this.model ? ["--model", this.model] : []),
        prompt,
      ],
      {
        cwd: worktree,
        encoding: "utf8",
        shell: false,
        timeout: 10 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...sanitizedEnvironment(),
          ...(this.baseUrl
            ? { ANTHROPIC_BASE_URL: this.baseUrl, ANTHROPIC_AUTH_TOKEN: this.apiKey }
            : { ANTHROPIC_API_KEY: this.apiKey }),
          ...(this.model
            ? {
                ANTHROPIC_MODEL: this.model,
                ANTHROPIC_DEFAULT_OPUS_MODEL: this.model,
                ANTHROPIC_DEFAULT_SONNET_MODEL: this.model,
                ANTHROPIC_DEFAULT_HAIKU_MODEL: this.model,
              }
            : {}),
        },
      },
    );
    const detail = child.status === 0
      ? "Claude Code completed candidate Skill execution."
      : summarizeOutput(child.stderr || child.error?.message || `Claude Code exited with status ${child.status}.`);
    const parsed = parseClaudeJson(child.stdout);
    return {
      succeeded: child.status === 0,
      tokenUsage: parsed.tokenUsage,
      toolCalls: parsed.toolCalls,
      detail,
    };
  }
}

function parseClaudeJson(output: string): { tokenUsage: number | null; toolCalls: number | null } {
  try {
    const value = JSON.parse(output) as {
      usage?: { input_tokens?: number; output_tokens?: number };
      num_turns?: number;
    };
    const input = value.usage?.input_tokens;
    const outputTokens = value.usage?.output_tokens;
    return {
      tokenUsage:
        typeof input === "number" && typeof outputTokens === "number" ? input + outputTokens : null,
      toolCalls: typeof value.num_turns === "number" ? value.num_turns : null,
    };
  } catch {
    return { tokenUsage: null, toolCalls: null };
  }
}
