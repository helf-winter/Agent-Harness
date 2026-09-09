import Database from "better-sqlite3";
import { EVENT_TYPES } from "../domain/event-types.js";
import type { EventEnvelope } from "../domain/events.js";
import type { Stage } from "../domain/lifecycle.js";
import type { EventLedger, StoredEvent } from "../storage/event-ledger.js";
import type {
  TaskNodeProjection,
  TaskNodeStatus,
  TaskTreeProjection,
} from "../task-tree/types.js";

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

      CREATE TABLE IF NOT EXISTS task_nodes (
        node_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        parent_node_id TEXT,
        depth INTEGER NOT NULL,
        child_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        is_atomic INTEGER NOT NULL,
        result_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS traces_by_task ON traces(task_id, started_at);
      CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id, started_at);
      CREATE INDEX IF NOT EXISTS task_nodes_by_task ON task_nodes(task_id, created_at);
      CREATE INDEX IF NOT EXISTS task_nodes_by_trace ON task_nodes(trace_id, created_at);
      CREATE INDEX IF NOT EXISTS task_nodes_by_parent ON task_nodes(parent_node_id, child_index);
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

      case EVENT_TYPES.TASK_NODE_CREATED:
        this.#insertTaskNode(event, null, 0, 0);
        break;

      case EVENT_TYPES.TASK_NODE_DECOMPOSED:
        this.#decomposeTaskNode(event);
        break;

      case EVENT_TYPES.TASK_NODE_SELECTED:
        this.#updateTaskNodeStatus(event, "selected");
        break;

      case EVENT_TYPES.TASK_NODE_STARTED:
        this.#updateTaskNodeStatus(event, "running");
        break;

      case EVENT_TYPES.TASK_NODE_COMPLETED:
        this.#updateTaskNodeStatus(event, "completed", optionalString(event.payload.resultSummary));
        break;

      case EVENT_TYPES.TASK_NODE_FAILED:
        this.#updateTaskNodeStatus(event, "failed", optionalString(event.payload.resultSummary));
        break;

      case EVENT_TYPES.TASK_NODE_PRUNED:
        this.#updateTaskNodeStatus(event, "pruned", optionalString(event.payload.resultSummary));
        break;

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

  #insertTaskNode(
    event: EventEnvelope,
    parentNodeId: string | null,
    depth: number,
    childIndex: number,
  ): void {
    this.#database
      .prepare(`
        INSERT OR IGNORE INTO task_nodes(
          node_id, task_id, trace_id, parent_node_id, depth, child_index,
          title, description, status, is_atomic, result_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)
      `)
      .run(
        requiredString(event.payload.nodeId, "nodeId", event),
        requiredId(event.taskId, event),
        requiredId(event.traceId, event),
        parentNodeId,
        depth,
        childIndex,
        requiredString(event.payload.title, "title", event),
        requiredString(event.payload.description, "description", event),
        event.payload.isAtomic === true ? 1 : 0,
        event.occurredAt,
        event.occurredAt,
      );
  }

  #decomposeTaskNode(event: EventEnvelope): void {
    const nodeId = requiredString(event.payload.nodeId, "nodeId", event);
    const parent = this.#database
      .prepare("SELECT * FROM task_nodes WHERE node_id = ?")
      .get(nodeId) as TaskNodeRow | undefined;
    if (!parent) throw new Error(`TaskNode not found for decomposition: ${nodeId}`);

    this.#database
      .prepare("UPDATE task_nodes SET status = 'decomposed', updated_at = ? WHERE node_id = ?")
      .run(event.occurredAt, nodeId);

    const children = requiredChildren(event.payload.children, event);
    children.forEach((child, index) => {
      const childEvent: EventEnvelope = {
        ...event,
        payload: {
          nodeId: child.nodeId,
          title: child.title,
          description: child.description,
          isAtomic: child.isAtomic,
        },
      };
      this.#insertTaskNode(childEvent, nodeId, parent.depth + 1, index);
    });
  }

  #updateTaskNodeStatus(
    event: EventEnvelope,
    status: TaskNodeStatus,
    resultSummary?: string,
  ): void {
    this.#database
      .prepare(`
        UPDATE task_nodes
        SET status = ?,
            result_summary = COALESCE(?, result_summary),
            updated_at = ?
        WHERE node_id = ?
      `)
      .run(
        status,
        resultSummary ?? null,
        event.occurredAt,
        requiredString(event.payload.nodeId, "nodeId", event),
      );
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

  getTaskNode(nodeId: string): TaskNodeProjection | undefined {
    const row = this.#database
      .prepare("SELECT * FROM task_nodes WHERE node_id = ?")
      .get(nodeId) as TaskNodeRow | undefined;
    return row ? mapTaskNode(row) : undefined;
  }

  listTaskNodes(scope: { taskId?: string; traceId?: string }): TaskNodeProjection[] {
    if (!scope.taskId && !scope.traceId) throw new Error("taskId or traceId is required");
    const rows = scope.traceId
      ? this.#database
          .prepare("SELECT * FROM task_nodes WHERE trace_id = ?")
          .all(scope.traceId) as TaskNodeRow[]
      : this.#database
          .prepare("SELECT * FROM task_nodes WHERE task_id = ?")
          .all(scope.taskId) as TaskNodeRow[];
    return orderTaskNodes(rows.map(mapTaskNode));
  }

  getTaskTree(scope: { taskId?: string; traceId?: string }): TaskTreeProjection {
    const nodes = this.listTaskNodes(scope);
    return {
      root: nodes.find((node) => node.parentNodeId === null) ?? null,
      nodes,
    };
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

interface TaskNodeRow {
  node_id: string;
  task_id: string;
  trace_id: string;
  parent_node_id: string | null;
  depth: number;
  child_index: number;
  title: string;
  description: string;
  status: TaskNodeStatus;
  is_atomic: number;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskNodeChildPayload {
  nodeId: string;
  title: string;
  description: string;
  isAtomic?: boolean;
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

function mapTaskNode(row: TaskNodeRow): TaskNodeProjection {
  return {
    nodeId: row.node_id,
    taskId: row.task_id,
    traceId: row.trace_id,
    parentNodeId: row.parent_node_id,
    depth: row.depth,
    childIndex: row.child_index,
    title: row.title,
    description: row.description,
    status: row.status,
    isAtomic: row.is_atomic === 1,
    resultSummary: row.result_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orderTaskNodes(nodes: TaskNodeProjection[]): TaskNodeProjection[] {
  const childrenByParent = new Map<string | null, TaskNodeProjection[]>();
  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parentNodeId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentNodeId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => {
      if (left.childIndex !== right.childIndex) return left.childIndex - right.childIndex;
      const created = left.createdAt.localeCompare(right.createdAt);
      if (created !== 0) return created;
      return left.nodeId.localeCompare(right.nodeId);
    });
  }

  const ordered: TaskNodeProjection[] = [];
  const visit = (node: TaskNodeProjection): void => {
    ordered.push(node);
    for (const child of childrenByParent.get(node.nodeId) ?? []) visit(child);
  };
  for (const root of childrenByParent.get(null) ?? []) visit(root);

  const orderedIds = new Set(ordered.map((node) => node.nodeId));
  for (const node of nodes) {
    if (!orderedIds.has(node.nodeId)) ordered.push(node);
  }
  return ordered;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredChildren(value: unknown, event: EventEnvelope): TaskNodeChildPayload[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Missing children in event ${event.eventId}`);
  }
  return value.map((child, index) => {
    if (!child || typeof child !== "object") {
      throw new Error(`Invalid child at index ${index} in event ${event.eventId}`);
    }
    const candidate = child as Record<string, unknown>;
    return {
      nodeId: requiredString(candidate.nodeId, `children[${index}].nodeId`, event),
      title: requiredString(candidate.title, `children[${index}].title`, event),
      description: requiredString(candidate.description, `children[${index}].description`, event),
      isAtomic: candidate.isAtomic === true,
    };
  });
}
