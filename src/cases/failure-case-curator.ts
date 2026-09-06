import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { EventEnvelope } from "../domain/events.js";
import { stableProjectId } from "../integration/paths.js";
import type { ProjectionStore } from "../projections/projection-store.js";
import { canonicalJson } from "../storage/canonical-json.js";
import type { EventLedger } from "../storage/event-ledger.js";
import type { CaseRegistry } from "./case-registry.js";
import { CASE_SCHEMA_VERSION, type CaseOracle, type FailureCase } from "./types.js";

export interface CurationResult {
  accepted: boolean;
  reason: string;
  failureCase?: FailureCase;
  created?: boolean;
}

export class FailureCaseCurator {
  constructor(
    private readonly ledger: EventLedger,
    private readonly projection: ProjectionStore,
    private readonly registry: CaseRegistry,
  ) {}

  curate(traceId: string, repositoryDirectory: string): CurationResult {
    this.projection.projectPending(this.ledger);
    const trace = this.projection.getTrace(traceId);
    if (!trace) return { accepted: false, reason: `Trace not found: ${traceId}` };
    const events = this.ledger.listTraceEvidence(trace.traceId, trace.taskId, trace.sessionId);
    const result = [...events]
      .reverse()
      .find((event) => event.eventType === EVENT_TYPES.RESULT_EVALUATED);
    if (!result || result.payload.outcome !== "failure") {
      return {
        accepted: false,
        reason: "Only a Trace with a deterministic failure result can become a Case.",
      };
    }

    const grader = findFailingGrader(events, result);
    if (!grader) {
      return { accepted: false, reason: "The failure has no deterministic failing grader evidence." };
    }
    const repository = resolve(repositoryDirectory);
    if (!existsSync(resolve(repository, "package.json"))) {
      return { accepted: false, reason: "The repository is not a package-based TypeScript project." };
    }
    if (!existsSync(resolve(repository, "tsconfig.json"))) {
      return { accepted: false, reason: "The first Case type requires a tsconfig.json file." };
    }

    const commitSha = git(repository, ["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40,64}$/.test(commitSha)) {
      return { accepted: false, reason: "The repository has no valid Git commit to reproduce." };
    }
    const workingTreePatch = git(repository, ["diff", "--binary", "HEAD", "--", "."]);
    const taskEvent = events.find((event) => event.eventType === EVENT_TYPES.TASK_CREATED);
    const title = stringValue(taskEvent?.payload.title) ?? `Failure from ${traceId}`;
    const oracle = oracleFromGrader(grader);
    if (!oracle) {
      return { accepted: false, reason: "The failing grader command is incomplete." };
    }
    const now = new Date().toISOString();
    const projectId =
      stringValue(
        events.find((event) => event.eventType === EVENT_TYPES.SESSION_STARTED)?.payload.projectId,
      ) ?? stableProjectId(repository);
    const evidenceEventIds = [grader.eventId, result.eventId];
    const fingerprint = createHash("sha256")
      .update(
        canonicalJson({
          projectId,
          title,
          commitSha,
          patch: createHash("sha256").update(workingTreePatch).digest("hex"),
          command: oracle.command,
          args: oracle.args,
        }),
      )
      .digest("hex");
    const candidate: FailureCase = {
      schemaVersion: CASE_SCHEMA_VERSION,
      caseId: `case_${randomUUID()}`,
      fingerprint,
      title,
      status: "raw",
      split: "development",
      classification: "capability",
      taskType: "typescript-reproducible-test-repair",
      source: {
        projectId,
        traceId,
        taskId: trace.taskId,
        evidenceEventIds,
        commitSha,
        workingTreePatch,
      },
      reproductionOracle: oracle,
      solutionOracle: { ...oracle, expectedExitCode: 0 },
      tags: ["typescript", "deterministic-test", "auto-curated"],
      createdAt: now,
      updatedAt: now,
    };
    const stored = this.registry.create(candidate);
    const triaged =
      stored.failureCase.status === "raw"
        ? this.registry.transition(
            stored.failureCase.caseId,
            "triaged",
            "Deterministic failure evidence and TypeScript project requirements are present.",
          )
        : stored.failureCase;
    return {
      accepted: true,
      reason: stored.created ? "Failure Case curated and triaged." : "Matching Case already exists.",
      failureCase: triaged,
      created: stored.created,
    };
  }
}

function findFailingGrader(events: EventEnvelope[], result: EventEnvelope): EventEnvelope | undefined {
  const ids = Array.isArray(result.payload.commandEvidenceEventIds)
    ? result.payload.commandEvidenceEventIds.filter((value): value is string => typeof value === "string")
    : [];
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.eventType === "grader.completed" &&
        (ids.length === 0 || ids.includes(event.eventId)) &&
        (event.payload.timedOut === true ||
          (typeof event.payload.exitCode === "number" && event.payload.exitCode !== 0)),
    );
}

function oracleFromGrader(event: EventEnvelope): CaseOracle | undefined {
  const command = stringValue(event.payload.command);
  const args = Array.isArray(event.payload.args)
    ? event.payload.args.filter((value): value is string => typeof value === "string")
    : [];
  const exitCode = event.payload.exitCode;
  if (!command || typeof exitCode !== "number") return undefined;

  if (
    command === process.execPath &&
    args[0]?.replaceAll("\\", "/").endsWith("/npm/bin/npm-cli.js")
  ) {
    return {
      command: "npm",
      args: args.slice(1),
      timeoutMs: 120_000,
      expectedExitCode: exitCode,
    };
  }
  return { command, args, timeoutMs: 120_000, expectedExitCode: exitCode };
}

function git(repository: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
