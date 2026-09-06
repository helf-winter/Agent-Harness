import Database from "better-sqlite3";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { EventEnvelope } from "../domain/events.js";
import type { Stage } from "../domain/lifecycle.js";
import type { EventLedger, StoredEvent } from "../storage/event-ledger.js";

export interface SessionProjection {
  sessionId: string;
  claudeSessionId: string;
  runtimeInstanceId: string;
  projectId: string;
  status: "active" | "ended";
  startedAt: string;
  endedAt: string | null;
}

export interface TaskProjection {
  taskId: string;
  title: string;
  status: "active" | "suspended" | "waiting" | "completed" | "cancelled";
  createdAt: string;
  completedAt: string | null;
}

export interface TraceProjection {
  traceId: string;
  taskId: string;
  sessionId: string;
  status: "active" | "ended";
  currentStage: Stage;
  currentStageId: string;
  startedAt: string;
  endedAt: string | null;
}

export interface TurnProjection {
  turnId: string;
  sessionId: string;
  status: "active" | "ended" | "failed";
  promptPreview: string;
  startedAt: string;
  endedAt: string | null;
}

export interface TraceSummary extends TraceProjection {
  taskTitle: string;
}

export class ProjectionStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    this.#database = new Database(databasePath);
    this.#database.pragma("journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS projection_offsets (
        projector TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO projection_offsets(projector, last_sequence)
        VALUES ('core', 0);

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        claude_session_id TEXT NOT NULL UNIQUE,
        runtime_instance_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt_preview TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS turn_task_links (
        turn_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        confidence REAL NOT NULL,
        PRIMARY KEY(turn_id, task_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_primary_task_per_turn
        ON turn_task_links(turn_id) WHERE relation = 'primary';

      CREATE TABLE IF NOT EXISTS session_task_focus (
        session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        current_stage_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE INDEX IF NOT EXISTS traces_by_task ON traces(task_id, started_at);
      CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id, started_at);
    `);
  }

  projectPending(ledger: EventLedger): number {
    const offset = this.#database
      .prepare("SELECT last_sequence FROM projection_offsets WHERE projector = 'core'")
      .get() as { last_sequence: number };
    const storedEvents = ledger.readAfter(offset.last_sequence);
    if (storedEvents.length === 0) return 0;

    const applyBatch = this.#database.transaction((events: StoredEvent[]) => {
      for (const stored of events) {
        this.#apply(stored.event);
        this.#database
          .prepare("UPDATE projection_offsets SET last_sequence = ? WHERE projector = 'core'")
          .run(stored.sequence);
      }
    });
    applyBatch(storedEvents);
    return storedEvents.length;
  }

  #apply(event: EventEnvelope): void {
    switch (event.eventType) {
      case EVENT_TYPES.SESSION_STARTED:
      case EVENT_TYPES.SESSION_RESUMED:
        this.#database
          .prepare(`
            INSERT INTO sessions (
              session_id, claude_session_id, runtime_instance_id,
              project_id, status, started_at, ended_at
            ) VALUES (?, ?, ?, ?, 'active', ?, NULL)
            ON CONFLICT(session_id) DO UPDATE SET
              runtime_instance_id = excluded.runtime_instance_id,
              status = 'active',
              ended_at = NULL
          `)
          .run(
            requiredId(event.sessionId, event),
            requiredString(event.payload.claudeSessionId, "claudeSessionId", event),
            event.runtimeInstanceId,
            requiredString(event.payload.projectId, "projectId", event),
            event.occurredAt,
          );
        break;

      case EVENT_TYPES.SESSION_ENDED:
        this.#database
          .prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE session_id = ?")
          .run(event.occurredAt, requiredId(event.sessionId, event));
        break;

      case EVENT_TYPES.SESSION_DELETED:
        this.#database
          .prepare("DELETE FROM sessions WHERE session_id = ?")
          .run(requiredId(event.sessionId, event));
        break;

      case EVENT_TYPES.TASK_CREATED:
        this.#database
          .prepare(`
            INSERT OR IGNORE INTO tasks(task_id, title, status, created_at, completed_at)
            VALUES (?, ?, 'active', ?, NULL)
          `)
          .run(
            requiredId(event.taskId, event),
            requiredString(event.payload.title, "title", event),
            event.occurredAt,
          );
        break;

      case EVENT_TYPES.TASK_STATUS_CHANGED: {
        const status = requiredString(event.payload.status, "status", event);
        const completedAt = status === "completed" || status === "cancelled" ? event.occurredAt : null;
        this.#database
          .prepare("UPDATE tasks SET status = ?, completed_at = ? WHERE task_id = ?")
          .run(status, completedAt, requiredId(event.taskId, event));
        break;
      }

      case EVENT_TYPES.TURN_STARTED:
        this.#database
          .prepare(`
            INSERT OR IGNORE INTO turns(
              turn_id, session_id, status, prompt_preview, started_at, ended_at
            ) VALUES (?, ?, 'active', ?, ?, NULL)
          `)
          .run(
            requiredId(event.turnId, event),
            requiredId(event.sessionId, event),
            requiredString(event.payload.promptPreview, "promptPreview", event),
            event.occurredAt,
          );
        break;

      case EVENT_TYPES.TURN_LINKED_TO_TASK: {
        const relation = requiredString(event.payload.relation, "relation", event);
        if (relation === "primary") {
          this.#database
            .prepare(
              "UPDATE turn_task_links SET relation = 'related' WHERE turn_id = ? AND relation = 'primary'",
            )
            .run(requiredId(event.turnId, event));
        }
        this.#database
          .prepare(`
            INSERT INTO turn_task_links(turn_id, task_id, relation, confidence)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(turn_id, task_id) DO UPDATE SET
              relation = excluded.relation,
              confidence = excluded.confidence
          `)
          .run(
            requiredId(event.turnId, event),
            requiredId(event.taskId, event),
            relation,
            requiredNumber(event.payload.confidence, "confidence", event),
          );
        if (relation === "primary") {
          this.#database
            .prepare(`
              INSERT INTO session_task_focus(session_id, task_id, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                task_id = excluded.task_id,
                updated_at = excluded.updated_at
            `)
            .run(
              requiredId(event.sessionId, event),
              requiredId(event.taskId, event),
              event.occurredAt,
            );
        }
        break;
      }

      case EVENT_TYPES.TURN_ENDED:
        this.#database
          .prepare("UPDATE turns SET status = ?, ended_at = ? WHERE turn_id = ?")
          .run(
            event.payload.failed === true ? "failed" : "ended",
            event.occurredAt,
            requiredId(event.turnId, event),
          );
        break;

      case EVENT_TYPES.TRACE_STARTED:
        this.#database
          .prepare(`
            INSERT OR IGNORE INTO traces(
              trace_id, task_id, session_id, status, current_stage,
              current_stage_id, started_at, ended_at
            ) VALUES (?, ?, ?, 'active', 'INTAKE', ?, ?, NULL)
          `)
          .run(
            requiredId(event.traceId, event),
            requiredId(event.taskId, event),
            requiredId(event.sessionId, event),
            requiredId(event.stageId, event),
            event.occurredAt,
          );
        break;

      case EVENT_TYPES.STAGE_TRANSITIONED:
        this.#database
          .prepare("UPDATE traces SET current_stage = ?, current_stage_id = ? WHERE trace_id = ?")
          .run(
            requiredString(event.payload.to, "to", event),
            requiredId(event.stageId, event),
            requiredId(event.traceId, event),
          );
        break;

      case EVENT_TYPES.TRACE_ENDED:
        this.#database
          .prepare("UPDATE traces SET status = 'ended', ended_at = ? WHERE trace_id = ?")
          .run(event.occurredAt, requiredId(event.traceId, event));
        break;
    }
  }

  findSession(sessionId: string): SessionProjection | undefined {
    const row = this.#database
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  findActiveSessionForRuntime(runtimeInstanceId: string): SessionProjection | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM sessions
        WHERE runtime_instance_id = ? AND status = 'active'
        ORDER BY started_at DESC LIMIT 1
      `)
      .get(runtimeInstanceId) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  getFocusedTask(sessionId: string): TaskProjection | undefined {
    const row = this.#database
      .prepare(`
        SELECT tasks.* FROM session_task_focus
        JOIN tasks ON tasks.task_id = session_task_focus.task_id
        WHERE session_task_focus.session_id = ?
          AND tasks.status IN ('active', 'suspended', 'waiting')
      `)
      .get(sessionId) as TaskRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  listTasksForSession(sessionId: string): TaskProjection[] {
    const rows = this.#database
      .prepare(`
        SELECT DISTINCT tasks.* FROM tasks
        JOIN traces ON traces.task_id = tasks.task_id
        WHERE traces.session_id = ?
        ORDER BY tasks.created_at DESC
      `)
      .all(sessionId) as TaskRow[];
    return rows.map(mapTask);
  }

  getActiveTraceForSessionTask(sessionId: string, taskId: string): TraceProjection | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM traces
        WHERE session_id = ? AND task_id = ? AND status = 'active'
        ORDER BY started_at DESC LIMIT 1
      `)
      .get(sessionId, taskId) as TraceRow | undefined;
    return row ? mapTrace(row) : undefined;
  }

  getOpenTurn(sessionId: string): TurnProjection | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM turns
        WHERE session_id = ? AND status = 'active'
        ORDER BY started_at DESC LIMIT 1
      `)
      .get(sessionId) as TurnRow | undefined;
    return row ? mapTurn(row) : undefined;
  }

  getActiveTrace(taskId: string): TraceProjection | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM traces
        WHERE task_id = ? AND status = 'active'
        ORDER BY started_at DESC LIMIT 1
      `)
      .get(taskId) as TraceRow | undefined;
    return row ? mapTrace(row) : undefined;
  }

  getTrace(traceId: string): TraceProjection | undefined {
    const row = this.#database
      .prepare("SELECT * FROM traces WHERE trace_id = ?")
      .get(traceId) as TraceRow | undefined;
    return row ? mapTrace(row) : undefined;
  }

  listTraces(limit = 20): TraceSummary[] {
    const rows = this.#database
      .prepare(`
        SELECT traces.*, tasks.title AS task_title
        FROM traces JOIN tasks ON tasks.task_id = traces.task_id
        ORDER BY traces.started_at DESC LIMIT ?
      `)
      .all(limit) as Array<TraceRow & { task_title: string }>;
    return rows.map((row) => ({ ...mapTrace(row), taskTitle: row.task_title }));
  }

  close(): void {
    this.#database.close();
  }
}

interface SessionRow {
  session_id: string;
  claude_session_id: string;
  runtime_instance_id: string;
  project_id: string;
  status: "active" | "ended";
  started_at: string;
  ended_at: string | null;
}

interface TaskRow {
  task_id: string;
  title: string;
  status: TaskProjection["status"];
  created_at: string;
  completed_at: string | null;
}

interface TurnRow {
  turn_id: string;
  session_id: string;
  status: TurnProjection["status"];
  prompt_preview: string;
  started_at: string;
  ended_at: string | null;
}

interface TraceRow {
  trace_id: string;
  task_id: string;
  session_id: string;
  status: TraceProjection["status"];
  current_stage: Stage;
  current_stage_id: string;
  started_at: string;
  ended_at: string | null;
}

function mapSession(row: SessionRow): SessionProjection {
  return {
    sessionId: row.session_id,
    claudeSessionId: row.claude_session_id,
    runtimeInstanceId: row.runtime_instance_id,
    projectId: row.project_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapTask(row: TaskRow): TaskProjection {
  return {
    taskId: row.task_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapTurn(row: TurnRow): TurnProjection {
  return {
    turnId: row.turn_id,
    sessionId: row.session_id,
    status: row.status,
    promptPreview: row.prompt_preview,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapTrace(row: TraceRow): TraceProjection {
  return {
    traceId: row.trace_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    status: row.status,
    currentStage: row.current_stage,
    currentStageId: row.current_stage_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function requiredId(value: string | undefined, event: EventEnvelope): string {
  if (!value) throw new Error(`Missing scope ID in event ${event.eventId}`);
  return value;
}

function requiredString(value: unknown, field: string, event: EventEnvelope): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing ${field} in event ${event.eventId}`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string, event: EventEnvelope): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Missing ${field} in event ${event.eventId}`);
  }
  return value;
}
