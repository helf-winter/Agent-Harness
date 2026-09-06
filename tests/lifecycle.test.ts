import { describe, expect, it } from "vitest";
import { decideTransition } from "../src/domain/lifecycle.js";

describe("lifecycle transitions", () => {
  it("allows the normal forward path with evidence", () => {
    expect(
      decideTransition({
        from: "PLAN",
        to: "EXECUTE",
        reason: "Plan accepted by controller",
        evidenceEventIds: ["evt_plan"],
      }),
    ).toEqual({ allowed: true });
  });

  it("allows a documented verification rollback", () => {
    expect(
      decideTransition({
        from: "VERIFY",
        to: "EXECUTE",
        reason: "The failing assertion is repairable",
        evidenceEventIds: ["evt_test_failure"],
      }).allowed,
    ).toBe(true);
  });

  it("rejects stage skipping", () => {
    expect(
      decideTransition({
        from: "INTAKE",
        to: "EXECUTE",
        reason: "Skip planning",
        evidenceEventIds: ["evt_prompt"],
      }),
    ).toMatchObject({ allowed: false });
  });

  it("requires evidence", () => {
    expect(
      decideTransition({
        from: "RECALL",
        to: "PLAN",
        reason: "Recall completed",
        evidenceEventIds: [],
      }),
    ).toMatchObject({ allowed: false });
  });

  it("only resumes the recorded stage after human review", () => {
    expect(
      decideTransition({
        from: "HUMAN_REVIEW",
        to: "EXECUTE",
        resumeStage: "PLAN",
        reason: "User clarified requirements",
        evidenceEventIds: ["evt_user_answer"],
      }),
    ).toMatchObject({ allowed: false });
  });
});
