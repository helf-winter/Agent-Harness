import type { ProjectionStore } from "../projections/projection-store.js";
import type { EventLedger } from "../storage/event-ledger.js";
import { CaseRegistry } from "./case-registry.js";
import { FailureCaseCurator, type CurationResult } from "./failure-case-curator.js";
import type { FailureCase, ReproductionRecord } from "./types.js";
import { WorktreeReproductionRunner } from "./worktree-reproduction-runner.js";

export interface PromotionResult {
  failureCase: FailureCase;
  reproduction: ReproductionRecord;
}

export class FailureCaseService {
  readonly registry: CaseRegistry;

  constructor(
    databasePath: string,
    private readonly ledger: EventLedger,
    private readonly projection: ProjectionStore,
  ) {
    this.registry = new CaseRegistry(databasePath, ledger);
  }

  curate(traceId: string, repositoryDirectory: string): CurationResult {
    return new FailureCaseCurator(this.ledger, this.projection, this.registry).curate(
      traceId,
      repositoryDirectory,
    );
  }

  reproduceAndPromote(caseId: string, repositoryDirectory: string): PromotionResult {
    let failureCase = this.registry.get(caseId);
    if (!failureCase) throw new Error(`Case not found: ${caseId}`);
    if (failureCase.status !== "triaged") {
      throw new Error(`Only a triaged Case can be reproduced; current status is ${failureCase.status}.`);
    }
    const reproduction = new WorktreeReproductionRunner().reproduce(
      failureCase,
      repositoryDirectory,
    );
    this.registry.recordReproduction(caseId, reproduction);
    if (reproduction.reproduced) {
      failureCase = this.registry.transition(caseId, "reproducible", "Failure reproduced in an isolated Git worktree.");
      failureCase = this.registry.transition(caseId, "approved", "Deterministic reproduction satisfies the automatic approval policy.");
      failureCase = this.registry.transition(caseId, "active", "Automatically promoted for development and regression use.");
    }
    return { failureCase, reproduction };
  }

  close(): void {
    this.registry.close();
  }
}
