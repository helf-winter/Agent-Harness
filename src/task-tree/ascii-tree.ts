import type { TaskNodeProjection, TaskTreeProjection } from "./types.js";

const STATUS_GLYPH: Record<TaskNodeProjection["status"], string> = {
  pending: "·",
  decomposed: "+",
  selected: ">",
  running: "*",
  completed: "✓",
  failed: "✗",
  pruned: "–",
};

export function renderTaskTreeAscii(tree: TaskTreeProjection): string {
  if (!tree.root) return "(no TaskNode tree)";
  const childrenOf = new Map<string | null, TaskNodeProjection[]>();
  for (const node of [...tree.nodes].sort((a, b) => a.childIndex - b.childIndex)) {
    const siblings = childrenOf.get(node.parentNodeId) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentNodeId, siblings);
  }

  const lines: string[] = [];
  renderNode(tree.root, "", false, childrenOf, lines);
  return lines.join("\n");
}

function renderNode(
  node: TaskNodeProjection,
  prefix: string,
  isLastChild: boolean,
  childrenOf: Map<string | null, TaskNodeProjection[]>,
  lines: string[],
): void {
  const glyph = STATUS_GLYPH[node.status] ?? "?";
  const connector = node.parentNodeId === null ? "" : isLastChild ? "└── " : "├── ";
  const summary = node.resultSummary ? ` · ${truncate(node.resultSummary, 60)}` : "";
  lines.push(`${prefix}${connector}${glyph} ${node.title}${summary}`);

  const children = childrenOf.get(node.nodeId) ?? [];
  children.forEach((child, index) => {
    const childPrefix =
      node.parentNodeId === null ? "" : prefix + (isLastChild ? "    " : "│   ");
    renderNode(child, childPrefix, index === children.length - 1, childrenOf, lines);
  });
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
