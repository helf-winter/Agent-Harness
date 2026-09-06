import { createHash, randomUUID } from "node:crypto";
import type { ExperienceStore } from "../experiences/experience-store.js";
import { canonicalJson } from "../storage/canonical-json.js";
import type { SkillRegistry } from "./skill-registry.js";
import { SKILL_SCHEMA_VERSION, type HarnessSkill } from "./types.js";

export interface SkillGenerationPolicy { minimumSupportingExperiences: number; minimumConfidence: number }

export class SkillGenerator {
  constructor(
    private readonly experiences: ExperienceStore,
    private readonly skills: SkillRegistry,
    private readonly policy: SkillGenerationPolicy = { minimumSupportingExperiences: 1, minimumConfidence: 0.7 },
  ) {}

  generate(experienceIds: string[]): { skill: HarnessSkill; created: boolean } {
    const sources = experienceIds.map((id) => this.experiences.get(id));
    if (sources.some((item) => !item)) throw new Error("One or more source Experiences do not exist.");
    const usable = sources.filter((item): item is NonNullable<typeof item> => item?.status === "usable" && item.confidence >= this.policy.minimumConfidence);
    if (usable.length < this.policy.minimumSupportingExperiences) {
      throw new Error("Not enough usable, high-confidence Experiences to generate a Skill.");
    }
    const experienceIdSet = [...new Set(usable.map((item) => item.experienceId))];
    const traceIds = [...new Set(usable.flatMap((item) => item.source.traceIds))];
    const caseIds = [...new Set(usable.flatMap((item) => item.source.caseIds))];
    const technologies = [...new Set(usable.flatMap((item) => item.context.technologies))].sort();
    const strategies = [...new Set(usable.map((item) => item.strategy))];
    const exclusions = [...new Set(usable.flatMap((item) => item.exclusions))];
    const now = new Date().toISOString();
    const fingerprint = createHash("sha256")
      .update(canonicalJson({ experienceIdSet: [...experienceIdSet].sort(), strategies }))
      .digest("hex");
    const skillId = `skill_${randomUUID()}`;
    const skill: HarnessSkill = {
      schemaVersion: SKILL_SCHEMA_VERSION,
      skillId,
      version: 1,
      fingerprint,
      name: "repair-reproducible-typescript-test",
      description: "Diagnose and repair a deterministic test failure in a TypeScript package with evidence-backed completion gates.",
      status: "testing",
      source: { experienceIds: experienceIdSet, traceIds, caseIds },
      trigger: {
        taskTypes: ["typescript-reproducible-test-repair"],
        technologies,
        conditions: ["A local test command fails deterministically in a TypeScript package."],
        exclusions,
      },
      preconditions: ["Repository has a committed Git baseline.", "A deterministic failing test command is available."],
      inputContract: "Repository path, failing test evidence, and user repair goal.",
      outputContract: "Minimal source change plus passing typecheck/build/test evidence, or a precise blocker.",
      steps: [
        { id: "reproduce", instruction: "Run the narrowest failing test and preserve its exact failure evidence.", allowedTools: ["Read", "Grep", "Glob", "Bash"], completionEvidence: "A deterministic failing command and output." },
        { id: "diagnose", instruction: strategies.join("\n"), allowedTools: ["Read", "Grep", "Glob"], completionEvidence: "A source-backed causal explanation." },
        { id: "repair", instruction: "Make the smallest scoped TypeScript change that addresses the demonstrated cause.", allowedTools: ["Read", "Edit"], completionEvidence: "A reviewable source diff." },
        { id: "verify", instruction: "Run the focused test, then required typecheck, build, and full test graders.", allowedTools: ["Bash"], completionEvidence: "All required deterministic graders exit successfully." },
      ],
      permissions: { tools: ["Read", "Grep", "Glob", "Edit", "Bash"], destructiveOperations: false, network: false },
      qualityGates: ["Original failure is reproduced before editing.", "All required deterministic graders pass.", "No destructive or network operation is used."],
      failureHandling: ["Stop and report unknown when no deterministic oracle exists.", "Request user input when the expected behavior is ambiguous."],
      environment: ["Node.js 22+", "Git", "Bash", "TypeScript package"],
      provenance: { creator: "agent-harness", generator: "deterministic-skill-template-v1", generatedAt: now },
      baseline: { validationRunIds: [], successRate: null, medianDurationMs: null },
      markdown: "",
      createdAt: now,
      updatedAt: now,
    };
    skill.markdown = renderSkillMarkdown(skill);
    return this.skills.create(skill);
  }
}

export function renderSkillMarkdown(skill: HarnessSkill): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\n## Trigger\n\n${skill.trigger.conditions.map((item) => `- ${item}`).join("\n")}\n\n## Exclusions\n\n${skill.trigger.exclusions.map((item) => `- ${item}`).join("\n")}\n\n## Workflow\n\n${skill.steps.map((step, index) => `${index + 1}. ${step.instruction}\n   Evidence: ${step.completionEvidence}`).join("\n")}\n\n## Permissions\n\nAllowed tools: ${skill.permissions.tools.join(", ")}. Network and destructive operations are forbidden.\n\n## Completion gates\n\n${skill.qualityGates.map((item) => `- ${item}`).join("\n")}\n`;
}
