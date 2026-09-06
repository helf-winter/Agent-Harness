import { EVENT_TYPES } from "../domain/event-types.js";
import type { EventLedger } from "../storage/event-ledger.js";
import type { SkillRegistry } from "./skill-registry.js";
import type { HarnessSkill } from "./types.js";

export class SkillRegressionMonitor {
  constructor(
    private readonly ledger: EventLedger,
    private readonly registry: SkillRegistry,
    private readonly consecutiveHighSeverityFailureThreshold = 2,
  ) {}

  record(input: {
    skillId: string;
    traceId: string;
    outcome: "success" | "failure" | "unknown";
    severity: "low" | "medium" | "high";
    reason: string;
  }): HarnessSkill {
    const eventId = this.registry.recordInvocation(input);
    const events = this.ledger
      .listByCorrelation(input.skillId)
      .filter((event) => event.eventType === EVENT_TYPES.SKILL_INVOCATION_RECORDED)
      .reverse();
    const consecutiveFailures = [];
    for (const event of events) {
      if (event.payload.outcome !== "failure" || event.payload.severity !== "high") break;
      consecutiveFailures.push(event);
    }
    if (consecutiveFailures.length >= this.consecutiveHighSeverityFailureThreshold) {
      return this.registry.transition(
        input.skillId,
        "quarantined",
        `${consecutiveFailures.length} consecutive high-severity production failures reached the automatic isolation threshold.`,
        consecutiveFailures.map((event) => event.eventId),
      );
    }
    const skill = this.registry.get(input.skillId);
    if (!skill) throw new Error(`Skill not found after invocation ${eventId}.`);
    return skill;
  }
}
