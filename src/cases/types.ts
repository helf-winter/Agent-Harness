export const CASE_SCHEMA_VERSION = "1.0.0" as const;

export type CaseStatus =
  | "raw"
  | "triaged"
  | "reproducible"
  | "approved"
  | "active"
  | "deprecated";

export type CaseSplit =
  | "development"
  | "validation"
  | "regression"
  | "holdout"
  | "resilience";

export type FailureClassification =
  | "capability"
  | "workflow"
  | "tool"
  | "infrastructure"
  | "environment"
  | "requirement"
  | "unknown";

export interface CaseOracle {
  command: string;
  args: string[];
  timeoutMs: number;
  expectedExitCode: number;
  outputIncludes?: string;
}

export interface FailureCase {
  schemaVersion: typeof CASE_SCHEMA_VERSION;
  caseId: string;
  fingerprint: string;
  title: string;
  status: CaseStatus;
  split: CaseSplit;
  classification: FailureClassification;
  taskType: "typescript-reproducible-test-repair";
  source: {
    projectId: string;
    traceId: string;
    taskId: string;
    evidenceEventIds: string[];
    commitSha: string;
    workingTreePatch: string;
  };
  reproductionOracle: CaseOracle;
  solutionOracle: CaseOracle;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReproductionRecord {
  reproduced: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  commitSha: string;
}
