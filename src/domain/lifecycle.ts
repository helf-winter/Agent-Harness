export const STAGES = [
  "INTAKE",
  "RECALL",
  "PLAN",
  "EXECUTE",
  "VERIFY",
  "REVIEW",
  "HUMAN_REVIEW",
  "COMPLETE",
] as const;

export type Stage = (typeof STAGES)[number];
export type ResultOutcome = "success" | "partial" | "failure" | "unknown";

export interface TransitionRequest {
  from: Stage;
  to: Stage;
  reason: string;
  evidenceEventIds: string[];
  resumeStage?: Exclude<Stage, "HUMAN_REVIEW">;
}

export interface TransitionDecision {
  allowed: boolean;
  reason?: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<Stage, readonly Stage[]>> = {
  INTAKE: ["RECALL", "HUMAN_REVIEW"],
  RECALL: ["PLAN", "HUMAN_REVIEW"],
  PLAN: ["EXECUTE", "HUMAN_REVIEW"],
  EXECUTE: ["VERIFY", "RECALL", "HUMAN_REVIEW"],
  VERIFY: ["REVIEW", "EXECUTE", "PLAN", "HUMAN_REVIEW"],
  REVIEW: ["COMPLETE", "EXECUTE", "HUMAN_REVIEW"],
  HUMAN_REVIEW: ["INTAKE", "RECALL", "PLAN", "EXECUTE", "VERIFY", "REVIEW"],
  COMPLETE: [],
};

export function decideTransition(request: TransitionRequest): TransitionDecision {
  if (!request.reason.trim()) {
    return { allowed: false, reason: "A transition reason is required." };
  }

  if (request.evidenceEventIds.length === 0) {
    return { allowed: false, reason: "At least one evidence event is required." };
  }

  if (!ALLOWED_TRANSITIONS[request.from].includes(request.to)) {
    return {
      allowed: false,
      reason: `Transition ${request.from} -> ${request.to} is not allowed.`,
    };
  }

  if (request.from === "HUMAN_REVIEW" && request.resumeStage !== request.to) {
    return {
      allowed: false,
      reason: "Leaving HUMAN_REVIEW must resume the recorded stage.",
    };
  }

  return { allowed: true };
}

export const CASE_STATES = [
  "raw",
  "triaged",
  "reproducible",
  "approved",
  "active",
  "deprecated",
] as const;

export const EXPERIENCE_STATES = ["candidate", "active", "deprecated"] as const;

export const SKILL_STATES = [
  "testing",
  "completed",
  "quarantined",
  "deprecated",
  "rejected",
] as const;
