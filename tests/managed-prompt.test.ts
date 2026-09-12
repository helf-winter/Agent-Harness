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
});
