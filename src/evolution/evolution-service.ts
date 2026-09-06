import { EVENT_TYPES } from "../domain/event-types.js";
import { FailureCaseCurator } from "../cases/failure-case-curator.js";
import { WorktreeReproductionRunner } from "../cases/worktree-reproduction-runner.js";
import type { CaseRegistry } from "../cases/case-registry.js";
import { ExperienceCurator } from "../experiences/experience-curator.js";
import type { ExperienceStore } from "../experiences/experience-store.js";
import { stableProjectId } from "../integration/paths.js";
import type { ProjectionStore } from "../projections/projection-store.js";
import { SkillGenerator } from "../skills/skill-generator.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { EventLedger } from "../storage/event-ledger.js";
import type { SkillExecutor } from "../validation/skill-validation-agent.js";
import { SkillLifecycleController, SkillValidationAgent } from "../validation/skill-validation-agent.js";

export class EvolutionService {
  constructor(
    private readonly ledger: EventLedger,
    private readonly projection: ProjectionStore,
    private readonly cases: CaseRegistry,
    private readonly experiences: ExperienceStore,
    private readonly skills: SkillRegistry,
    private readonly validationExecutor?: SkillExecutor,
  ) {}

  processTrace(traceId: string, repositoryDirectory: string): Record<string, unknown> {
    this.projection.projectPending(this.ledger);
    const trace = this.projection.getTrace(traceId);
    if (!trace) return { processed: false, reason: `Trace not found: ${traceId}` };
    const result = [...this.ledger.listTraceEvidence(traceId, trace.taskId, trace.sessionId)]
      .reverse()
      .find((event) => event.eventType === EVENT_TYPES.RESULT_EVALUATED);
    if (!result || (result.payload.outcome !== "success" && result.payload.outcome !== "failure")) {
      return { processed: false, reason: "Trace has no deterministic success or failure result." };
    }

    if (result.payload.outcome === "failure") {
      const curated = new FailureCaseCurator(this.ledger, this.projection, this.cases).curate(
        traceId,
        repositoryDirectory,
      );
      if (!curated.accepted || !curated.failureCase) return { processed: false, path: "failure", ...curated };
      if (curated.failureCase.status !== "triaged") {
        return { processed: true, path: "failure", curation: curated, failureCase: curated.failureCase };
      }
      const reproduction = new WorktreeReproductionRunner().reproduce(curated.failureCase, repositoryDirectory);
      this.cases.recordReproduction(curated.failureCase.caseId, reproduction);
      let failureCase = curated.failureCase;
      if (reproduction.reproduced) {
        failureCase = this.cases.transition(failureCase.caseId, "reproducible", "Automatically reproduced after failed Trace completion.");
        failureCase = this.cases.transition(failureCase.caseId, "approved", "Automatic deterministic Case policy passed.");
        failureCase = this.cases.transition(failureCase.caseId, "active", "Activated for global validation and regression use.");
      }
      return { processed: true, path: "failure", curation: curated, reproduction, failureCase };
    }

    const curated = new ExperienceCurator(this.ledger, this.projection, this.experiences).curate(traceId);
    if (!curated.accepted || !curated.experience) return { processed: false, path: "success", ...curated };
    const generated = new SkillGenerator(this.experiences, this.skills).generate([
      curated.experience.experienceId,
    ]);
    const targets = this.cases
      .list("active")
      .filter((failureCase) => failureCase.source.projectId === stableProjectId(repositoryDirectory))
      .map((failureCase) => ({ failureCase, repositoryDirectory }));
    const required = ["development", "validation", "regression", "holdout"];
    const hasAllSplits = required.every((split) => targets.some((target) => target.failureCase.split === split));
    if (!this.validationExecutor || !hasAllSplits || generated.skill.status !== "testing") {
      return {
        processed: true,
        path: "success",
        curation: curated,
        skill: generated.skill,
        validation: {
          scheduled: false,
          reason: !this.validationExecutor
            ? "Independent validation credential/executor is unavailable."
            : !hasAllSplits
              ? "Active development, validation, regression, and holdout Cases are required."
              : "Skill is not in testing status.",
        },
      };
    }
    const report = new SkillValidationAgent(this.skills, this.validationExecutor).validate(
      generated.skill.skillId,
      targets,
    );
    const skill = new SkillLifecycleController(this.skills).applyValidation(report);
    return { processed: true, path: "success", curation: curated, skill, validation: report };
  }
}
