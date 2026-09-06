export const EVENT_TYPES = {
  SESSION_STARTED: "session.started",
  SESSION_RESUMED: "session.resumed",
  SESSION_ENDED: "session.ended",
  SESSION_DELETED: "session.deleted",
  TASK_CREATED: "task.created",
  TASK_STATUS_CHANGED: "task.status_changed",
  TURN_STARTED: "turn.started",
  TURN_LINKED_TO_TASK: "turn.linked_to_task",
  TURN_ENDED: "turn.ended",
  TRACE_STARTED: "trace.started",
  TRACE_ENDED: "trace.ended",
  STAGE_TRANSITIONED: "stage.transitioned",
  RESULT_EVALUATED: "result.evaluated",
} as const;

export type HarnessEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
