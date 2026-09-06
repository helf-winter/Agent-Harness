export const EXPERIENCE_SCHEMA_VERSION = "1.0.0" as const;

export type ExperienceStatus = "candidate" | "usable" | "deprecated";

export interface Experience {
  schemaVersion: typeof EXPERIENCE_SCHEMA_VERSION;
  experienceId: string;
  version: number;
  fingerprint: string;
  status: ExperienceStatus;
  polarity: "positive" | "negative";
  title: string;
  source: {
    traceIds: string[];
    caseIds: string[];
    evidenceEventIds: string[];
  };
  context: {
    taskType: "typescript-reproducible-test-repair";
    projectType: "node-package";
    technologies: string[];
  };
  applicability: string[];
  exclusions: string[];
  strategy: string;
  avoid: string[];
  confidence: number;
  usageCount: number;
  lastValidatedAt: string;
  conflictExperienceIds: string[];
  supersedesExperienceIds: string[];
  createdAt: string;
  updatedAt: string;
}
