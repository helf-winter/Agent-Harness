import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillRegistry } from "./skill-registry.js";

export class SkillExposureAdapter {
  constructor(private readonly registry: SkillRegistry) {}

  exportCompleted(skillId: string, projectDirectory: string): string {
    const skill = this.registry.get(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    if (skill.status !== "completed") {
      throw new Error("Only a completed Skill can be exposed to a production project.");
    }
    const skillsRoot = resolve(projectDirectory, ".claude", "skills");
    const destinationDirectory = resolve(skillsRoot, skill.name);
    if (!destinationDirectory.startsWith(skillsRoot)) {
      throw new Error("Unsafe Skill export destination.");
    }
    mkdirSync(destinationDirectory, { recursive: true });
    const destination = resolve(destinationDirectory, "SKILL.md");
    writeFileSync(destination, skill.markdown, "utf8");
    return destination;
  }
}
