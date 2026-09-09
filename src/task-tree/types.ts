export type TaskNodeStatus =
  | "pending"
  | "decomposed"
  | "selected"
  | "running"
  | "completed"
  | "failed"
  | "pruned";

export type TraversalStrategy = "dfs" | "bfs";

export interface TaskNodeInput {
  nodeId?: string;
  title: string;
  description: string;
  isAtomic?: boolean;
}

export interface TaskNodeProjection {
  nodeId: string;
  taskId: string;
  traceId: string;
  parentNodeId: string | null;
  depth: number;
  childIndex: number;
  title: string;
  description: string;
  status: TaskNodeStatus;
  isAtomic: boolean;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTreeProjection {
  root: TaskNodeProjection | null;
  nodes: TaskNodeProjection[];
}

export interface TaskNodeCreatedPayload {
  nodeId: string;
  parentNodeId?: string;
  title: string;
  description: string;
  isAtomic?: boolean;
}

export interface TaskNodeDecomposedPayload {
  nodeId: string;
  children: TaskNodeInput[];
}
