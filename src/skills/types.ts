export const SKILL_SCHEMA_VERSION = "1.0.0" as const;

export type SkillStatus = "testing" | "completed" | "quarantined" | "deprecated" | "rejected";

export interface SkillStep {
  id: string;
  instruction: string;
  allowedTools: string[];
  completionEvidence: string;
}

export interface HarnessSkill {
  schemaVersion: typeof SKILL_SCHEMA_VERSION;
  skillId: string;
  version: number;
  fingerprint: string;
  name: string;
  description: string;
  status: SkillStatus;
  source: {
    experienceIds: string[];
    traceIds: string[];
    caseIds: string[];
  };
  trigger: {
    taskTypes: string[];
    technologies: string[];
    conditions: string[];
    exclusions: string[];
  };
  preconditions: string[];
  inputContract: string;
  outputContract: string;
  steps: SkillStep[];
  permissions: {
    tools: string[];
    destructiveOperations: false;
    network: false;
  };
  qualityGates: string[];
  failureHandling: string[];
  environment: string[];
  provenance: {
    creator: string;
    generator: string;
    generatedAt: string;
  };
  baseline: {
    validationRunIds: string[];
    successRate: number | null;
    medianDurationMs: number | null;
  };
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationCaseResult {
  caseId: string;
  split: string;
  repetitions: number;
  passed: number;
  stable: boolean;
  baselineConfirmed: boolean;
  durationsMs: number[];
  tokenUsage: number | null;
  toolCalls: number | null;
  evidenceEventIds: string[];
  failure?: string;
}

export interface ValidationReport {
  validationRunId: string;
  skillId: string;
  skillVersion: number;
  policyVersion: string;
  verdict: "pass" | "fail";
  reason: string;
  caseResults: ValidationCaseResult[];
  requiredSplits: string[];
  holdoutSuccessRate: number;
  securityViolations: string[];
  destructiveSideEffects: string[];
  durationMs: number;
  totalTokenUsage: number | null;
  totalToolCalls: number | null;
  evidenceEventId: string;
  createdAt: string;
}
