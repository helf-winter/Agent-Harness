import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import Database from "better-sqlite3";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { EventEnvelope } from "../domain/events.js";
import type { EventLedger, StoredEvent } from "../storage/event-ledger.js";
import type { HarnessSkill, SkillStatus, ValidationReport } from "./types.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

const TRANSITIONS: Readonly<Record<SkillStatus, readonly SkillStatus[]>> = {
  testing: ["completed", "testing", "rejected"],
  completed: ["quarantined", "deprecated"],
  quarantined: ["testing", "rejected"],
  deprecated: [],
  rejected: [],
};

interface SkillRow { skill_id: string; fingerprint: string; status: SkillStatus; document_json: string }

export class SkillRegistry {
  readonly #database: Database.Database;
  readonly #validate: ValidateFunction;

  constructor(
    databasePath: string,
    private readonly ledger: EventLedger,
    private readonly runtimeInstanceId = "skill-registry",
  ) {
    this.#database = new Database(databasePath);
    this.#database.pragma("journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS skill_projection_offsets(projector TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO skill_projection_offsets(projector, last_sequence) VALUES ('skills', 0);
      CREATE TABLE IF NOT EXISTS skills(
        skill_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        technologies_json TEXT NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skills_by_status ON skills(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS validation_runs(
        validation_run_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const schema = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../schemas/skill.schema.json", import.meta.url)), "utf8"),
    ) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    this.#validate = ajv.compile(schema);
    this.projectPending();
  }

  create(skill: HarnessSkill): { skill: HarnessSkill; created: boolean } {
    this.#assertValid(skill);
    if (skill.status !== "testing") throw new Error("A new Skill must start in testing status.");
    const existing = this.findByFingerprint(skill.fingerprint);
    if (existing) return { skill: existing, created: false };
    this.ledger.append({
      eventType: EVENT_TYPES.SKILL_CREATED,
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: skill.skillId,
      actor: { type: "worker", id: "skill-generator" },
      source: { adapter: "harness-core", adapterVersion: "0.4.0" },
      policyVersion: "skill-policy-1",
      payload: { skill },
    });
    this.projectPending();
    return { skill: this.get(skill.skillId)!, created: true };
  }

  transition(skillId: string, to: SkillStatus, reason: string, evidenceEventIds: string[]): HarnessSkill {
    const current = this.get(skillId);
    if (!current) throw new Error(`Skill not found: ${skillId}`);
    if (!TRANSITIONS[current.status].includes(to)) throw new Error(`Invalid Skill transition: ${current.status} -> ${to}`);
    const evidence = this.ledger.getByIds(evidenceEventIds);
    if (evidence.length !== new Set(evidenceEventIds).size) throw new Error("Skill transition evidence is missing.");
    if (to === "completed") {
      const valid = evidence.some(
        (event) => event.eventType === EVENT_TYPES.VALIDATION_COMPLETED && event.payload.skillId === skillId && event.payload.verdict === "pass",
      );
      if (!valid) throw new Error("Skill completion requires a passing independent Validation Report.");
    }
    if (to === "quarantined") {
      const severeFailures = evidence.filter(
        (event) =>
          event.eventType === EVENT_TYPES.SKILL_INVOCATION_RECORDED &&
          event.payload.skillId === skillId &&
          event.payload.outcome === "failure" &&
          event.payload.severity === "high",
      );
      if (severeFailures.length < 2) {
        throw new Error("Skill quarantine requires at least two high-severity production failures.");
      }
    }
    const passingReport = to === "completed"
      ? evidence.find((event) => event.eventType === EVENT_TYPES.VALIDATION_COMPLETED && event.payload.verdict === "pass")
      : undefined;
    this.ledger.append({
      eventType: EVENT_TYPES.SKILL_STATUS_CHANGED,
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: skillId,
      actor: { type: "controller", id: "skill-lifecycle-controller" },
      source: { adapter: "harness-core", adapterVersion: "0.4.0" },
      policyVersion: "skill-policy-1",
      payload: {
        skillId,
        from: current.status,
        to,
        reason,
        evidenceEventIds,
        ...(passingReport
          ? {
              validationRunId: passingReport.payload.validationRunId,
              successRate: 1,
              medianDurationMs: median(
                ((passingReport.payload.caseResults as Array<{ durationsMs?: number[] }> | undefined) ?? [])
                  .flatMap((item) => item.durationsMs ?? []),
              ),
              validatedCaseIds: ((passingReport.payload.caseResults as Array<{ caseId?: string }> | undefined) ?? [])
                .map((item) => item.caseId)
                .filter((caseId): caseId is string => typeof caseId === "string"),
            }
          : {}),
      },
    });
    this.projectPending();
    return this.get(skillId)!;
  }

  recordValidation(report: Omit<ValidationReport, "evidenceEventId">): ValidationReport {
    const event = this.ledger.append({
      eventType: EVENT_TYPES.VALIDATION_COMPLETED,
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: report.validationRunId,
      actor: { type: "grader", id: "independent-skill-validation-agent" },
      source: { adapter: "harness-core", adapterVersion: "0.5.0" },
      policyVersion: report.policyVersion,
      payload: report,
    });
    this.projectPending();
    return { ...report, evidenceEventId: event.event.eventId };
  }

  recordValidationAttempt(input: {
    validationRunId: string;
    skillId: string;
    caseId: string;
    repetition: number;
    passed: boolean;
    durationMs: number;
    executorId: string;
    detail: string;
  }): string {
    const event = this.ledger.append({
      eventType: "validation.case_completed",
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: input.validationRunId,
      actor: { type: "grader", id: "independent-skill-validation-agent" },
      source: { adapter: "harness-core", adapterVersion: "0.5.0" },
      policyVersion: "skill-validation-policy-1",
      payload: input,
    });
    return event.event.eventId;
  }

  recordInvocation(input: {
    skillId: string;
    traceId: string;
    outcome: "success" | "failure" | "unknown";
    severity: "low" | "medium" | "high";
    reason: string;
  }): string {
    const skill = this.get(input.skillId);
    if (!skill) throw new Error(`Skill not found: ${input.skillId}`);
    if (skill.status !== "completed") throw new Error("Only a completed Skill can record a production invocation.");
    const event = this.ledger.append({
      eventType: EVENT_TYPES.SKILL_INVOCATION_RECORDED,
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: input.skillId,
      actor: { type: "worker", id: "production-skill-monitor" },
      source: { adapter: "harness-core", adapterVersion: "0.6.0" },
      policyVersion: "skill-regression-policy-1",
      payload: input,
    });
    return event.event.eventId;
  }

  get(skillId: string): HarnessSkill | undefined {
    this.projectPending();
    const row = this.#database.prepare("SELECT * FROM skills WHERE skill_id = ?").get(skillId) as SkillRow | undefined;
    return row ? JSON.parse(row.document_json) as HarnessSkill : undefined;
  }

  findByFingerprint(fingerprint: string): HarnessSkill | undefined {
    this.projectPending();
    const row = this.#database.prepare("SELECT * FROM skills WHERE fingerprint = ?").get(fingerprint) as SkillRow | undefined;
    return row ? JSON.parse(row.document_json) as HarnessSkill : undefined;
  }

  list(status?: SkillStatus): HarnessSkill[] {
    this.projectPending();
    const rows = (status
      ? this.#database.prepare("SELECT * FROM skills WHERE status = ? ORDER BY updated_at DESC").all(status)
      : this.#database.prepare("SELECT * FROM skills ORDER BY updated_at DESC").all()) as SkillRow[];
    return rows.map((row) => JSON.parse(row.document_json) as HarnessSkill);
  }

  listProduction(): HarnessSkill[] { return this.list("completed"); }

  getValidationReport(validationRunId: string): ValidationReport | undefined {
    this.projectPending();
    const row = this.#database.prepare("SELECT report_json FROM validation_runs WHERE validation_run_id = ?").get(validationRunId) as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) as ValidationReport : undefined;
  }

  projectPending(): number {
    const offset = this.#database.prepare("SELECT last_sequence FROM skill_projection_offsets WHERE projector = 'skills'").get() as { last_sequence: number };
    const events = this.ledger.readAfter(offset.last_sequence);
    if (events.length === 0) return 0;
    const batch = this.#database.transaction((items: StoredEvent[]) => {
      for (const item of items) {
        this.#apply(item.event);
        this.#database.prepare("UPDATE skill_projection_offsets SET last_sequence = ? WHERE projector = 'skills'").run(item.sequence);
      }
    });
    batch(events);
    return events.length;
  }

  close(): void { this.#database.close(); }

  #apply(event: EventEnvelope): void {
    if (event.eventType === EVENT_TYPES.SKILL_CREATED) {
      const value = event.payload.skill;
      this.#assertValid(value);
      const skill = value as HarnessSkill;
      this.#database.prepare(`
        INSERT OR IGNORE INTO skills(skill_id, fingerprint, name, version, status, technologies_json, document_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(skill.skillId, skill.fingerprint, skill.name, skill.version, skill.status, JSON.stringify(skill.trigger.technologies), JSON.stringify(skill), skill.createdAt, skill.updatedAt);
    } else if (event.eventType === EVENT_TYPES.SKILL_STATUS_CHANGED) {
      const skillId = String(event.payload.skillId ?? "");
      const to = String(event.payload.to ?? "") as SkillStatus;
      const row = this.#database.prepare("SELECT * FROM skills WHERE skill_id = ?").get(skillId) as SkillRow | undefined;
      if (!row) throw new Error(`Cannot project unknown Skill ${skillId}.`);
      const skill = JSON.parse(row.document_json) as HarnessSkill;
      skill.status = to;
      skill.updatedAt = event.occurredAt;
      if (to === "completed" && typeof event.payload.validationRunId === "string") {
        skill.baseline.validationRunIds = [
          ...new Set([...skill.baseline.validationRunIds, event.payload.validationRunId]),
        ];
        skill.baseline.successRate = typeof event.payload.successRate === "number" ? event.payload.successRate : null;
        skill.baseline.medianDurationMs = typeof event.payload.medianDurationMs === "number" ? event.payload.medianDurationMs : null;
        if (Array.isArray(event.payload.validatedCaseIds)) {
          skill.source.caseIds = [
            ...new Set([
              ...skill.source.caseIds,
              ...event.payload.validatedCaseIds.filter((caseId): caseId is string => typeof caseId === "string"),
            ]),
          ];
        }
      }
      this.#assertValid(skill);
      this.#database.prepare("UPDATE skills SET status = ?, document_json = ?, updated_at = ? WHERE skill_id = ?")
        .run(to, JSON.stringify(skill), event.occurredAt, skillId);
    } else if (event.eventType === EVENT_TYPES.VALIDATION_COMPLETED) {
      const report = { ...event.payload, evidenceEventId: event.eventId } as unknown as ValidationReport;
      this.#database.prepare(`
        INSERT OR IGNORE INTO validation_runs(validation_run_id, skill_id, verdict, report_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(report.validationRunId, report.skillId, report.verdict, JSON.stringify(report), report.createdAt);
    }
  }

  #assertValid(value: unknown): asserts value is HarnessSkill {
    if (!this.#validate(value)) {
      throw new Error(`Invalid Skill: ${this.#validate.errors?.map((item) => `${item.instancePath} ${item.message}`).join(", ")}`);
    }
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const current = sorted[middle];
  if (current === undefined) return null;
  return sorted.length % 2 === 1 ? current : (current + (sorted[middle - 1] ?? current)) / 2;
}
