import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import Database from "better-sqlite3";
import {
  EVENT_SCHEMA_VERSION,
  assertValidEventContext,
  createEventId,
  type CapturedEvent,
  type EventEnvelope,
} from "../domain/events.js";
import { REDACTION_RULES_VERSION, redact } from "../security/redactor.js";
import { canonicalJson } from "./canonical-json.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

interface EventRow {
  sequence: number;
  event_id: string;
  fingerprint: string;
  envelope_json: string;
  previous_hash: string | null;
  chain_hash: string;
}

export interface StoredEvent {
  sequence: number;
  chainHash: string;
  event: EventEnvelope;
}

export interface AppendResult {
  sequence: number;
  chainHash: string;
  created: boolean;
  event: EventEnvelope;
}

export interface ChainVerification {
  valid: boolean;
  checkedEvents: number;
  invalidSequence?: number;
}

export class EventLedger {
  readonly #database: Database.Database;
  readonly #validate: ValidateFunction;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        runtime_instance_id TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        trace_id TEXT,
        turn_id TEXT,
        correlation_id TEXT,
        fingerprint TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        previous_hash TEXT,
        chain_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS events_by_task ON events(task_id, sequence);
      CREATE INDEX IF NOT EXISTS events_by_trace ON events(trace_id, sequence);
      CREATE TRIGGER IF NOT EXISTS events_immutable_update
        BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS events_immutable_delete
        BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
    `);
    const eventColumns = this.#database.pragma("table_info(events)") as Array<{ name: string }>;
    if (!eventColumns.some((column) => column.name === "correlation_id")) {
      this.#database.exec("ALTER TABLE events ADD COLUMN correlation_id TEXT");
    }
    this.#database.exec(
      "CREATE INDEX IF NOT EXISTS events_by_correlation ON events(correlation_id, sequence)",
    );

    const schemaPath = fileURLToPath(
      new URL("../../schemas/event-envelope.schema.json", import.meta.url),
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    this.#validate = ajv.compile(schema);
  }

  append(captured: CapturedEvent): AppendResult {
    assertValidEventContext(captured);

    const eventId = captured.eventId ?? createEventId();
    const occurredAt = captured.occurredAt ?? new Date().toISOString();
    const userHome = process.env.USERPROFILE ?? process.env.HOME;
    const redaction = userHome
      ? redact(captured.payload, { userHome })
      : redact(captured.payload);
    const normalizedInput = {
      ...captured,
      eventId,
      occurredAt,
      payload: redaction.value,
    };
    const fingerprint = sha256(canonicalJson(normalizedInput));

    const existing = this.#database
      .prepare("SELECT * FROM events WHERE event_id = ?")
      .get(eventId) as EventRow | undefined;

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`Event ID collision with different content: ${eventId}`);
      }
      return {
        sequence: existing.sequence,
        chainHash: existing.chain_hash,
        created: false,
        event: JSON.parse(existing.envelope_json) as EventEnvelope,
      };
    }

    const event: EventEnvelope = {
      ...captured,
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId,
      occurredAt,
      recordedAt: new Date().toISOString(),
      redaction: {
        status: redaction.redactedFields.length > 0 ? "applied" : "not_required",
        rulesVersion: REDACTION_RULES_VERSION,
        redactedFields: redaction.redactedFields,
      },
      payload: redaction.value,
    };

    if (!this.#validate(event)) {
      throw new Error(`Invalid event: ${this.#validate.errors?.map((item) => item.message).join(", ")}`);
    }

    const insert = this.#database.transaction(() => {
      const prior = this.#database
        .prepare("SELECT chain_hash FROM events ORDER BY sequence DESC LIMIT 1")
        .get() as Pick<EventRow, "chain_hash"> | undefined;
      const previousHash = prior?.chain_hash ?? null;
      const envelopeJson = canonicalJson(event);
      const chainHash = sha256(`${previousHash ?? "GENESIS"}\n${envelopeJson}`);
      const result = this.#database
        .prepare(`
          INSERT INTO events (
            event_id, event_type, occurred_at, recorded_at,
            runtime_instance_id, session_id, task_id, trace_id, turn_id,
            correlation_id, fingerprint, envelope_json, previous_hash, chain_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          event.eventId,
          event.eventType,
          event.occurredAt,
          event.recordedAt,
          event.runtimeInstanceId,
          event.sessionId ?? null,
          event.taskId ?? null,
          event.traceId ?? null,
          event.turnId ?? null,
          event.correlationId,
          fingerprint,
          envelopeJson,
          previousHash,
          chainHash,
        );
      return { sequence: Number(result.lastInsertRowid), chainHash };
    });

    return { ...insert(), created: true, event };
  }

  list(limit = 100): EventEnvelope[] {
    const rows = this.#database
      .prepare("SELECT envelope_json FROM events ORDER BY sequence ASC LIMIT ?")
      .all(limit) as Array<Pick<EventRow, "envelope_json">>;
    return rows.map((row) => JSON.parse(row.envelope_json) as EventEnvelope);
  }

  listByTrace(traceId: string): EventEnvelope[] {
    const rows = this.#database
      .prepare("SELECT envelope_json FROM events WHERE trace_id = ? ORDER BY sequence ASC")
      .all(traceId) as Array<Pick<EventRow, "envelope_json">>;
    return rows.map((row) => JSON.parse(row.envelope_json) as EventEnvelope);
  }

  listByCorrelation(correlationId: string): EventEnvelope[] {
    const rows = this.#database
      .prepare(`
        SELECT envelope_json FROM events
        WHERE correlation_id = ?
           OR (correlation_id IS NULL AND json_extract(envelope_json, '$.correlationId') = ?)
        ORDER BY sequence ASC
      `)
      .all(correlationId, correlationId) as Array<Pick<EventRow, "envelope_json">>;
    return rows.map((row) => JSON.parse(row.envelope_json) as EventEnvelope);
  }

  listTraceEvidence(traceId: string, taskId: string, sessionId: string): EventEnvelope[] {
    const rows = this.#database
      .prepare(`
        SELECT envelope_json FROM events
        WHERE trace_id = ?
           OR correlation_id = ?
           OR (correlation_id IS NULL AND json_extract(envelope_json, '$.correlationId') = ?)
           OR (task_id = ? AND event_type = 'task.created')
           OR (session_id = ? AND event_type IN ('session.started', 'session.resumed'))
        ORDER BY sequence ASC
      `)
      .all(traceId, traceId, traceId, taskId, sessionId) as Array<Pick<EventRow, "envelope_json">>;
    return rows.map((row) => JSON.parse(row.envelope_json) as EventEnvelope);
  }

  getByIds(eventIds: string[]): EventEnvelope[] {
    if (eventIds.length === 0) return [];
    const placeholders = eventIds.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(`SELECT envelope_json FROM events WHERE event_id IN (${placeholders})`)
      .all(...eventIds) as Array<Pick<EventRow, "envelope_json">>;
    return rows.map((row) => JSON.parse(row.envelope_json) as EventEnvelope);
  }

  readAfter(sequence: number, limit = 1_000): StoredEvent[] {
    const rows = this.#database
      .prepare(
        "SELECT sequence, envelope_json, chain_hash FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
      )
      .all(sequence, limit) as EventRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      chainHash: row.chain_hash,
      event: JSON.parse(row.envelope_json) as EventEnvelope,
    }));
  }

  verifyChain(): ChainVerification {
    const rows = this.#database
      .prepare("SELECT * FROM events ORDER BY sequence ASC")
      .all() as EventRow[];
    let previousHash: string | null = null;

    for (const row of rows) {
      const expected = sha256(`${previousHash ?? "GENESIS"}\n${row.envelope_json}`);
      if (row.previous_hash !== previousHash || row.chain_hash !== expected) {
        return { valid: false, checkedEvents: row.sequence - 1, invalidSequence: row.sequence };
      }
      previousHash = row.chain_hash;
    }

    return { valid: true, checkedEvents: rows.length };
  }

  close(): void {
    this.#database.close();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
