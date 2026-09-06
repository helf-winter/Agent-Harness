import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import Database from "better-sqlite3";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { EventEnvelope } from "../domain/events.js";
import type { EventLedger, StoredEvent } from "../storage/event-ledger.js";
import type { CaseStatus, FailureCase, ReproductionRecord } from "./types.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

const STATUS_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  raw: ["triaged", "deprecated"],
  triaged: ["reproducible", "deprecated"],
  reproducible: ["approved", "deprecated"],
  approved: ["active", "deprecated"],
  active: ["deprecated"],
  deprecated: [],
};

interface CaseRow {
  case_id: string;
  fingerprint: string;
  status: CaseStatus;
  document_json: string;
}

export class CaseRegistry {
  readonly #database: Database.Database;
  readonly #validate: ValidateFunction;

  constructor(
    databasePath: string,
    private readonly ledger: EventLedger,
    private readonly runtimeInstanceId = "case-registry",
  ) {
    this.#database = new Database(databasePath);
    this.#database.pragma("journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS case_projection_offsets (
        projector TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO case_projection_offsets(projector, last_sequence)
        VALUES ('cases', 0);
      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        split TEXT NOT NULL,
        classification TEXT NOT NULL,
        source_trace_id TEXT NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cases_by_status ON cases(status, updated_at);
      CREATE TABLE IF NOT EXISTS case_reproductions (
        event_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        reproduced INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);

    const schemaPath = fileURLToPath(
      new URL("../../schemas/failure-case.schema.json", import.meta.url),
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    this.#validate = ajv.compile(schema);
    this.projectPending();
  }

  create(candidate: FailureCase): { failureCase: FailureCase; created: boolean } {
    this.#assertValid(candidate);
    if (candidate.status !== "raw") throw new Error("A new Case must start in raw status.");
    const existing = this.findByFingerprint(candidate.fingerprint);
    if (existing) return { failureCase: existing, created: false };

    this.ledger.append({
      eventType: EVENT_TYPES.CASE_CREATED,
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: candidate.caseId,
      actor: { type: "worker", id: "failure-case-curator" },
      source: { adapter: "harness-core", adapterVersion: "0.2.0" },
      policyVersion: "case-policy-1",
      payload: { case: candidate },
    });
    this.projectPending();
    return { failureCase: this.get(candidate.caseId)!, created: true };
  }

  transition(caseId: string, to: CaseStatus, reason: string): FailureCase {
    const current = this.getRequired(caseId);
    if (!reason.trim()) throw new Error("Case transition reason is required.");
    if (!STATUS_TRANSITIONS[current.status].includes(to)) {
      throw new Error(`Invalid Case transition: ${current.status} -> ${to}`);
    }
    this.ledger.append({
      eventType: EVENT_TYPES.CASE_STATUS_CHANGED,
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: caseId,
      actor: { type: "controller", id: "case-lifecycle-controller" },
      source: { adapter: "harness-core", adapterVersion: "0.2.0" },
      policyVersion: "case-policy-1",
      payload: { caseId, from: current.status, to, reason },
    });
    this.projectPending();
    return this.getRequired(caseId);
  }

  recordReproduction(caseId: string, record: ReproductionRecord): string {
    this.getRequired(caseId);
    const result = this.ledger.append({
      eventType: EVENT_TYPES.CASE_REPRODUCTION_RECORDED,
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: caseId,
      actor: { type: "grader", id: "git-worktree-reproduction-runner" },
      source: { adapter: "harness-core", adapterVersion: "0.2.0" },
      policyVersion: "case-policy-1",
      payload: { caseId, ...record },
    });
    this.projectPending();
    return result.event.eventId;
  }

  projectPending(): number {
    const offset = this.#database
      .prepare("SELECT last_sequence FROM case_projection_offsets WHERE projector = 'cases'")
      .get() as { last_sequence: number };
    const events = this.ledger.readAfter(offset.last_sequence);
    if (events.length === 0) return 0;
    const applyBatch = this.#database.transaction((storedEvents: StoredEvent[]) => {
      for (const stored of storedEvents) {
        this.#apply(stored.event);
        this.#database
          .prepare("UPDATE case_projection_offsets SET last_sequence = ? WHERE projector = 'cases'")
          .run(stored.sequence);
      }
    });
    applyBatch(events);
    return events.length;
  }

  get(caseId: string): FailureCase | undefined {
    this.projectPending();
    const row = this.#database.prepare("SELECT * FROM cases WHERE case_id = ?").get(caseId) as
      | CaseRow
      | undefined;
    return row ? (JSON.parse(row.document_json) as FailureCase) : undefined;
  }

  findByFingerprint(fingerprint: string): FailureCase | undefined {
    this.projectPending();
    const row = this.#database.prepare("SELECT * FROM cases WHERE fingerprint = ?").get(fingerprint) as
      | CaseRow
      | undefined;
    return row ? (JSON.parse(row.document_json) as FailureCase) : undefined;
  }

  list(status?: CaseStatus): FailureCase[] {
    this.projectPending();
    const rows = (status
      ? this.#database.prepare("SELECT * FROM cases WHERE status = ? ORDER BY updated_at DESC").all(status)
      : this.#database.prepare("SELECT * FROM cases ORDER BY updated_at DESC").all()) as CaseRow[];
    return rows.map((row) => JSON.parse(row.document_json) as FailureCase);
  }

  close(): void {
    this.#database.close();
  }

  #getDocument(event: EventEnvelope): FailureCase {
    const candidate = event.payload.case;
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Missing Case document in event ${event.eventId}`);
    }
    this.#assertValid(candidate);
    return candidate as FailureCase;
  }

  #apply(event: EventEnvelope): void {
    if (event.eventType === EVENT_TYPES.CASE_CREATED) {
      const failureCase = this.#getDocument(event);
      this.#database.prepare(`
        INSERT OR IGNORE INTO cases(
          case_id, fingerprint, title, status, split, classification,
          source_trace_id, document_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        failureCase.caseId,
        failureCase.fingerprint,
        failureCase.title,
        failureCase.status,
        failureCase.split,
        failureCase.classification,
        failureCase.source.traceId,
        JSON.stringify(failureCase),
        failureCase.createdAt,
        failureCase.updatedAt,
      );
      return;
    }

    if (event.eventType === EVENT_TYPES.CASE_STATUS_CHANGED) {
      const caseId = requiredString(event.payload.caseId, "caseId", event);
      const to = requiredString(event.payload.to, "to", event) as CaseStatus;
      const row = this.#database.prepare("SELECT * FROM cases WHERE case_id = ?").get(caseId) as
        | CaseRow
        | undefined;
      if (!row) throw new Error(`Cannot project transition for unknown Case ${caseId}.`);
      const failureCase = JSON.parse(row.document_json) as FailureCase;
      failureCase.status = to;
      failureCase.updatedAt = event.occurredAt;
      this.#assertValid(failureCase);
      this.#database
        .prepare("UPDATE cases SET status = ?, document_json = ?, updated_at = ? WHERE case_id = ?")
        .run(to, JSON.stringify(failureCase), event.occurredAt, caseId);
      return;
    }

    if (event.eventType === EVENT_TYPES.CASE_REPRODUCTION_RECORDED) {
      this.#database.prepare(`
        INSERT OR IGNORE INTO case_reproductions(
          event_id, case_id, reproduced, record_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        requiredString(event.payload.caseId, "caseId", event),
        event.payload.reproduced === true ? 1 : 0,
        JSON.stringify(event.payload),
        event.occurredAt,
      );
    }
  }

  #assertValid(value: unknown): asserts value is FailureCase {
    if (!this.#validate(value)) {
      throw new Error(
        `Invalid Failure Case: ${this.#validate.errors?.map((item) => `${item.instancePath} ${item.message}`).join(", ")}`,
      );
    }
  }

  private getRequired(caseId: string): FailureCase {
    const failureCase = this.get(caseId);
    if (!failureCase) throw new Error(`Case not found: ${caseId}`);
    return failureCase;
  }
}

function requiredString(value: unknown, field: string, event: EventEnvelope): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${field} in ${event.eventId}`);
  return value;
}
