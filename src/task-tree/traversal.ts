import type { TaskNodeProjection, TaskNodeStatus, TraversalStrategy } from "./types.js";

type TraversalCandidate = Pick<TaskNodeProjection, "nodeId" | "depth" | "status" | "createdAt">;

const EXECUTABLE_STATUSES = new Set<TaskNodeStatus>(["pending", "selected", "failed"]);

export function selectNextTaskNode<T extends TraversalCandidate>(
  nodes: readonly T[],
  strategy: TraversalStrategy,
): T | null {
  const candidates = nodes.filter((node) => EXECUTABLE_STATUSES.has(node.status as TaskNodeStatus));
  if (candidates.length === 0) return null;

  return [...candidates].sort((left, right) => {
    if (strategy === "dfs" && left.depth !== right.depth) return right.depth - left.depth;
    if (strategy === "bfs" && left.depth !== right.depth) return left.depth - right.depth;
    const created = left.createdAt.localeCompare(right.createdAt);
    if (created !== 0) return created;
    return left.nodeId.localeCompare(right.nodeId);
  })[0] ?? null;
}
