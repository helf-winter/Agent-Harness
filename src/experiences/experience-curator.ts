import { createHash, randomUUID } from "node:crypto";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { EventEnvelope } from "../domain/events.js";
import type { ProjectionStore } from "../projections/projection-store.js";
import { canonicalJson } from "../storage/canonical-json.js";
import type { EventLedger } from "../storage/event-ledger.js";
import type { ExperienceStore } from "./experience-store.js";
import { EXPERIENCE_SCHEMA_VERSION, type Experience } from "./types.js";

export interface ExperienceCurationResult {
  accepted: boolean;
  reason: string;
  experience?: Experience;
  created?: boolean;
}

export class ExperienceCurator {
  constructor(
    private readonly ledger: EventLedger,
    private readonly projection: ProjectionStore,
    private readonly store: ExperienceStore,
  ) {}

  curate(traceId: string): ExperienceCurationResult {
    this.projection.projectPending(this.ledger);
    const trace = this.projection.getTrace(traceId);
    if (!trace) return { accepted: false, reason: `Trace not found: ${traceId}` };
    const events = this.ledger.listTraceEvidence(traceId, trace.taskId, trace.sessionId);
    const result = [...events].reverse().find((event) => event.eventType === EVENT_TYPES.RESULT_EVALUATED);
    if (!result || result.payload.outcome !== "success") {
      return { accepted: false, reason: "Only a deterministically successful Trace can support a positive Experience." };
    }
    const task = events.find((event) => event.eventType === EVENT_TYPES.TASK_CREATED);
    const title = typeof task?.payload.title === "string" ? task.payload.title : `Successful repair ${traceId}`;
    const observations = events
      .filter((event) => event.eventType === "observation.recorded")
      .map((event) => String(event.payload.summary ?? ""))
      .filter(Boolean);
    const graderIds = Array.isArray(result.payload.commandEvidenceEventIds)
      ? result.payload.commandEvidenceEventIds.filter((value): value is string => typeof value === "string")
      : [];
    const evidenceEventIds = [...new Set([...observationsEvidence(events), ...graderIds, result.eventId])];
    const strategy = observations.length > 0
      ? observations.join(" Then: ")
      : "Reproduce the failing test, make the smallest TypeScript change, then run typecheck, build, and tests before completion.";
    const fingerprint = createHash("sha256")
      .update(canonicalJson({ title: normalize(title), strategy: normalize(strategy), taskType: "typescript-reproducible-test-repair" }))
      .digest("hex");
    const now = new Date().toISOString();
    const candidate: Experience = {
      schemaVersion: EXPERIENCE_SCHEMA_VERSION,
      experienceId: `exp_${randomUUID()}`,
      version: 1,
      fingerprint,
      status: "candidate",
      polarity: "positive",
      title: `Verified approach: ${title}`,
      source: { traceIds: [traceId], caseIds: [], evidenceEventIds },
      context: {
        taskType: "typescript-reproducible-test-repair",
        projectType: "node-package",
        technologies: ["typescript", "node", "git"],
      },
      applicability: ["A TypeScript package has a deterministic, locally reproducible test failure."],
      exclusions: ["Authentication, network, dependency registry, or other infrastructure failures."],
      strategy,
      avoid: ["Do not declare success without a deterministic grader result."],
      confidence: observations.length > 0 ? 0.85 : 0.75,
      usageCount: 0,
      lastValidatedAt: result.occurredAt,
      conflictExperienceIds: [],
      supersedesExperienceIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const stored = this.store.create(candidate);
    const experience = stored.experience.status === "candidate"
      ? this.store.transition(stored.experience.experienceId, "usable", "Backed by a deterministic successful result and scoped applicability.")
      : stored.experience;
    return {
      accepted: true,
      reason: stored.created ? "Positive Experience curated." : "Matching Experience already exists.",
      experience,
      created: stored.created,
    };
  }
}

function observationsEvidence(events: EventEnvelope[]): string[] {
  return events.filter((event) => event.eventType === "observation.recorded").map((event) => event.eventId);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
