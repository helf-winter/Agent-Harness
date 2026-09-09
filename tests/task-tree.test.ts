import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "../src/domain/event-types.js";
import type { CapturedEvent } from "../src/domain/events.js";
import { ProjectionStore } from "../src/projections/projection-store.js";
import { EventLedger } from "../src/storage/event-ledger.js";
import { TaskTreeService } from "../src/task-tree/task-tree-service.js";
import { selectNextTaskNode } from "../src/task-tree/traversal.js";

const resources: Array<{ ledger: EventLedger; projection: ProjectionStore; directory: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.projection.close();
    resource.ledger.close();
    const target = resolve(resource.directory);
    if (!target.startsWith(resolve(tmpdir()))) throw new Error(`Unsafe test path: ${target}`);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "agent-harness-task-tree-"));
  const databasePath = join(directory, "harness.sqlite");
  const ledger = new EventLedger(databasePath);
  const projection = new ProjectionStore(databasePath);
  resources.push({ ledger, projection, directory });
  return { ledger, projection };
}

function base(overrides: Partial<CapturedEvent>): CapturedEvent {
  return {
    eventType: "test.event",
    runtimeInstanceId: "runtime-task-tree",
    sessionId: "session-task-tree",
    taskId: "task-task-tree",
    traceId: "trace-task-tree",
    correlationId: "trace-task-tree",
    actor: { type: "controller", id: "task-tree-test" },
    source: { adapter: "test", adapterVersion: "1.0.0" },
    policyVersion: "test-policy",
    payload: {},
    ...overrides,
  };
}

describe("recursive TaskNode tree", () => {
  it("projects recursive decomposition events into a replayable task tree", () => {
    const { ledger, projection } = setup();
    ledger.append(
      base({
        eventType: EVENT_TYPES.TASK_NODE_CREATED,
        eventId: "evt-root-created",
        payload: {
          nodeId: "node-root",
          title: "Repair TypeScript test failure",
          description: "Top-level task node for the Trace.",
        },
      }),
    );
    ledger.append(
      base({
        eventType: EVENT_TYPES.TASK_NODE_DECOMPOSED,
        eventId: "evt-root-decomposed",
        payload: {
          nodeId: "node-root",
          children: [
            {
              nodeId: "node-locate",
              title: "Locate failing assertion",
              description: "Read test output and find the assertion.",
            },
            {
              nodeId: "node-repair",
              title: "Repair implementation",
              description: "Patch the narrow implementation after locating the cause.",
            },
          ],
        },
      }),
    );
    ledger.append(
      base({
        eventType: EVENT_TYPES.TASK_NODE_DECOMPOSED,
        eventId: "evt-locate-decomposed",
        payload: {
          nodeId: "node-locate",
          children: [
            {
              nodeId: "node-read-output",
              title: "Read failing output",
              description: "Inspect deterministic failure output.",
            },
          ],
        },
      }),
    );
    ledger.append(
      base({
        eventType: EVENT_TYPES.TASK_NODE_COMPLETED,
        eventId: "evt-read-output-completed",
        payload: { nodeId: "node-read-output", resultSummary: "Assertion mismatch found." },
      }),
    );

    expect(projection.projectPending(ledger)).toBe(4);
    const tree = projection.getTaskTree({ traceId: "trace-task-tree" });

    expect(tree.root?.nodeId).toBe("node-root");
    expect(tree.nodes.map((node) => [node.nodeId, node.parentNodeId, node.depth, node.status])).toEqual([
      ["node-root", null, 0, "decomposed"],
      ["node-locate", "node-root", 1, "decomposed"],
      ["node-read-output", "node-locate", 2, "completed"],
      ["node-repair", "node-root", 1, "pending"],
    ]);
    expect(projection.getTaskNode("node-read-output")).toMatchObject({
      nodeId: "node-read-output",
      resultSummary: "Assertion mismatch found.",
    });
  });

  it("selects the next executable TaskNode with DFS or BFS traversal", () => {
    const nodes = [
      { nodeId: "node-root", parentNodeId: null, depth: 0, status: "decomposed", createdAt: "2026-09-10T00:00:00.000Z" },
      { nodeId: "node-a", parentNodeId: "node-root", depth: 1, status: "decomposed", createdAt: "2026-09-10T00:00:01.000Z" },
      { nodeId: "node-a1", parentNodeId: "node-a", depth: 2, status: "pending", createdAt: "2026-09-10T00:00:02.000Z" },
      { nodeId: "node-b", parentNodeId: "node-root", depth: 1, status: "pending", createdAt: "2026-09-10T00:00:03.000Z" },
    ] as const;

    expect(selectNextTaskNode(nodes, "dfs")?.nodeId).toBe("node-a1");
    expect(selectNextTaskNode(nodes, "bfs")?.nodeId).toBe("node-b");
  });

  it("appends task tree events through the service", () => {
    const { ledger, projection } = setup();
    const service = new TaskTreeService(ledger, {
      runtimeInstanceId: "runtime-task-tree",
      sessionId: "session-task-tree",
      taskId: "task-task-tree",
      traceId: "trace-task-tree",
      actor: { type: "controller", id: "task-tree-service" },
      source: { adapter: "harness-core", adapterVersion: "0.1.0" },
      policyVersion: "test-policy",
    });

    service.createRoot({
      nodeId: "node-root",
      title: "Repair TypeScript test failure",
      description: "Top-level recursive task node.",
    });
    service.decompose("node-root", [
      {
        nodeId: "node-locate",
        title: "Locate failing assertion",
        description: "Find the failing assertion before editing code.",
      },
    ]);
    service.complete("node-locate", "The failing assertion was identified.");

    projection.projectPending(ledger);
    expect(projection.getTaskTree({ taskId: "task-task-tree" }).nodes).toMatchObject([
      { nodeId: "node-root", status: "decomposed" },
      { nodeId: "node-locate", status: "completed", resultSummary: "The failing assertion was identified." },
    ]);
  });
});
