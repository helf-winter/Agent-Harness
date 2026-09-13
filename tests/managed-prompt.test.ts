import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("managed Harness Agent prompt", () => {
  it("frames Claude as the Harness Agent instead of an external worker", () => {
    const prompt = readFileSync(resolve("plugin/managed-prompt.md"), "utf8");

    expect(prompt).toContain("You are Agent Harness");
    expect(prompt).toContain("Claude Code is your execution substrate");
    expect(prompt).not.toContain("Claude Code worker");
    expect(prompt).not.toContain("Call `mcp__harness__harness_get_context` before doing task work.");
  });

  it("does not present Harness context lookup as a mandatory ritual", () => {
    const mcpSource = readFileSync(resolve("src/integration/mcp-server.ts"), "utf8");

    expect(mcpSource).not.toContain("Call this before requesting a stage transition.");
    expect(mcpSource).toContain("Use when exact Task, Trace, lifecycle stage, or recent evidence IDs are needed");
  });
});
