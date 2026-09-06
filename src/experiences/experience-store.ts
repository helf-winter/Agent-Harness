import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import Database from "better-sqlite3";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { EventEnvelope } from "../domain/events.js";
import type { EventLedger, StoredEvent } from "../storage/event-ledger.js";
import type { Experience, ExperienceStatus } from "./types.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

interface ExperienceRow { experience_id: string; fingerprint: string; status: ExperienceStatus; document_json: string }

export class ExperienceStore {
  readonly #database: Database.Database;
  readonly #validate: ValidateFunction;

  constructor(
    databasePath: string,
    private readonly ledger: EventLedger,
    private readonly runtimeInstanceId = "experience-store",
  ) {
    this.#database = new Database(databasePath);
    this.#database.pragma("journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS experience_projection_offsets(projector TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO experience_projection_offsets(projector, last_sequence) VALUES ('experiences', 0);
      CREATE TABLE IF NOT EXISTS experiences(
        experience_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        task_type TEXT NOT NULL,
        technologies_json TEXT NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS experiences_by_status ON experiences(status, confidence DESC);
    `);
    const schema = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../schemas/experience.schema.json", import.meta.url)), "utf8"),
    ) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    this.#validate = ajv.compile(schema);
    this.projectPending();
  }

  create(experience: Experience): { experience: Experience; created: boolean } {
    this.#assertValid(experience);
    if (experience.status !== "candidate") throw new Error("A new Experience must be candidate.");
    const existing = this.findByFingerprint(experience.fingerprint);
    if (existing) return { experience: existing, created: false };
    this.ledger.append({
      eventType: EVENT_TYPES.EXPERIENCE_CREATED,
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: experience.experienceId,
      actor: { type: "worker", id: "experience-curator" },
      source: { adapter: "harness-core", adapterVersion: "0.3.0" },
      policyVersion: "experience-policy-1",
      payload: { experience },
    });
    this.projectPending();
    return { experience: this.get(experience.experienceId)!, created: true };
  }

  transition(experienceId: string, to: ExperienceStatus, reason: string): Experience {
    const current = this.get(experienceId);
    if (!current) throw new Error(`Experience not found: ${experienceId}`);
    const valid =
      (current.status === "candidate" && (to === "usable" || to === "deprecated")) ||
      (current.status === "usable" && to === "deprecated");
    if (!valid) throw new Error(`Invalid Experience transition: ${current.status} -> ${to}`);
    this.ledger.append({
      eventType: EVENT_TYPES.EXPERIENCE_STATUS_CHANGED,
      runtimeInstanceId: this.runtimeInstanceId,
      correlationId: experienceId,
      actor: { type: "controller", id: "experience-lifecycle-controller" },
      source: { adapter: "harness-core", adapterVersion: "0.3.0" },
      policyVersion: "experience-policy-1",
      payload: { experienceId, from: current.status, to, reason },
    });
    this.projectPending();
    return this.get(experienceId)!;
  }

  get(experienceId: string): Experience | undefined {
    this.projectPending();
    const row = this.#database.prepare("SELECT * FROM experiences WHERE experience_id = ?").get(experienceId) as ExperienceRow | undefined;
    return row ? JSON.parse(row.document_json) as Experience : undefined;
  }

  findByFingerprint(fingerprint: string): Experience | undefined {
    this.projectPending();
    const row = this.#database.prepare("SELECT * FROM experiences WHERE fingerprint = ?").get(fingerprint) as ExperienceRow | undefined;
    return row ? JSON.parse(row.document_json) as Experience : undefined;
  }

  list(status?: ExperienceStatus): Experience[] {
    this.projectPending();
    const rows = (status
      ? this.#database.prepare("SELECT * FROM experiences WHERE status = ? ORDER BY confidence DESC, updated_at DESC").all(status)
      : this.#database.prepare("SELECT * FROM experiences ORDER BY confidence DESC, updated_at DESC").all()) as ExperienceRow[];
    return rows.map((row) => JSON.parse(row.document_json) as Experience);
  }

  projectPending(): number {
    const offset = this.#database.prepare("SELECT last_sequence FROM experience_projection_offsets WHERE projector = 'experiences'").get() as { last_sequence: number };
    const events = this.ledger.readAfter(offset.last_sequence);
    if (events.length === 0) return 0;
    const applyBatch = this.#database.transaction((items: StoredEvent[]) => {
      for (const item of items) {
        this.#apply(item.event);
        this.#database.prepare("UPDATE experience_projection_offsets SET last_sequence = ? WHERE projector = 'experiences'").run(item.sequence);
      }
    });
    applyBatch(events);
    return events.length;
  }

  close(): void { this.#database.close(); }

  #apply(event: EventEnvelope): void {
    if (event.eventType === EVENT_TYPES.EXPERIENCE_CREATED) {
      const value = event.payload.experience;
      this.#assertValid(value);
      const experience = value as Experience;
      this.#database.prepare(`
        INSERT OR IGNORE INTO experiences(
          experience_id, fingerprint, status, confidence, task_type, technologies_json,
          document_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        experience.experienceId, experience.fingerprint, experience.status, experience.confidence,
        experience.context.taskType, JSON.stringify(experience.context.technologies),
        JSON.stringify(experience), experience.createdAt, experience.updatedAt,
      );
    } else if (event.eventType === EVENT_TYPES.EXPERIENCE_STATUS_CHANGED) {
      const experienceId = String(event.payload.experienceId ?? "");
      const to = String(event.payload.to ?? "") as ExperienceStatus;
      const row = this.#database.prepare("SELECT * FROM experiences WHERE experience_id = ?").get(experienceId) as ExperienceRow | undefined;
      if (!row) throw new Error(`Cannot project unknown Experience ${experienceId}.`);
      const experience = JSON.parse(row.document_json) as Experience;
      experience.status = to;
      experience.updatedAt = event.occurredAt;
      this.#assertValid(experience);
      this.#database.prepare("UPDATE experiences SET status = ?, document_json = ?, updated_at = ? WHERE experience_id = ?")
        .run(to, JSON.stringify(experience), event.occurredAt, experienceId);
    }
  }

  #assertValid(value: unknown): asserts value is Experience {
    if (!this.#validate(value)) {
      throw new Error(`Invalid Experience: ${this.#validate.errors?.map((item) => `${item.instancePath} ${item.message}`).join(", ")}`);
    }
  }
}
