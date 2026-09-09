#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { STAGES } from "../domain/lifecycle.js";
import type { TraversalStrategy } from "../task-tree/types.js";
import { HarnessService } from "./harness-service.js";
import { harnessDatabasePath } from "./paths.js";

const runtimeInstanceId = process.env.HARNESS_RUNTIME_INSTANCE_ID;
if (!runtimeInstanceId) {
  throw new Error("HARNESS_RUNTIME_INSTANCE_ID is required.");
}

const service = new HarnessService(harnessDatabasePath(), runtimeInstanceId);
const server = new McpServer({ name: "agent-harness", version: "0.1.0" });
const taskNodeInputSchema = z.object({
  nodeId: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  isAtomic: z.boolean().default(false),
});
const traversalStrategySchema = z.enum(["dfs", "bfs"]);

server.registerTool(
  "harness_get_context",
  {
    description:
      "Read the current Harness Task, Trace, lifecycle stage, and recent evidence IDs. Call this before requesting a stage transition.",
    inputSchema: {},
  },
  async () => textResult(service.getContext()),
);

server.registerTool(
  "harness_list_tasks",
  {
    description:
      "List Tasks in the current Session, including which Task is focused and each active lifecycle stage.",
    inputSchema: {},
  },
  async () => textResult(service.listTasks()),
);

server.registerTool(
  "harness_create_task",
  {
    description:
      "Create and focus a new Task when the current user prompt is an independent goal rather than a continuation of the focused Task.",
    inputSchema: {
      title: z.string().min(1).max(160),
      reason: z.string().min(1),
    },
  },
  async ({ title, reason }) => textResult(service.createAndFocusTask(title, reason)),
);

server.registerTool(
  "harness_focus_task",
  {
    description:
      "Focus an existing active Task when the user returns to an earlier goal. Use harness_list_tasks to obtain valid Task IDs.",
    inputSchema: {
      taskId: z.string().min(1),
      reason: z.string().min(1),
    },
  },
  async ({ taskId, reason }) => textResult(service.focusTask(taskId, reason)),
);

server.registerTool(
  "harness_record_observation",
  {
    description:
      "Record a stage-local observation backed by existing Trace evidence. Returns an event ID that can support a lifecycle transition.",
    inputSchema: {
      summary: z.string().min(1),
      evidenceEventIds: z.array(z.string().min(1)).min(1),
    },
  },
  async ({ summary, evidenceEventIds }) =>
    textResult(service.recordObservation(summary, evidenceEventIds)),
);

server.registerTool(
  "harness_transition_stage",
  {
    description:
      "Request a deterministic lifecycle stage transition. The controller rejects skipped stages and nonexistent or out-of-scope evidence.",
    inputSchema: {
      to: z.enum(STAGES),
      reason: z.string().min(1),
      evidenceEventIds: z.array(z.string().min(1)).min(1),
    },
  },
  async ({ to, reason, evidenceEventIds }) =>
    textResult(service.transitionStage(to, reason, evidenceEventIds)),
);

server.registerTool(
  "harness_get_task_tree",
  {
    description:
      "Read the recursive TaskNode tree for the focused Trace, including deterministic DFS and BFS next-node suggestions.",
    inputSchema: {},
  },
  async () => textResult(service.getTaskTree()),
);

server.registerTool(
  "harness_create_task_node_root",
  {
    description:
      "Create the root TaskNode for the focused Trace when the Task needs recursive decomposition tracking.",
    inputSchema: taskNodeInputSchema.shape,
  },
  async (input) => textResult(service.createTaskNodeRoot(normalizeTaskNodeInput(input))),
);

server.registerTool(
  "harness_decompose_task_node",
  {
    description:
      "Record that a TaskNode is too large to execute directly and has been decomposed into child TaskNodes.",
    inputSchema: {
      nodeId: z.string().min(1),
      children: z.array(taskNodeInputSchema).min(1).max(12),
    },
  },
  async ({ nodeId, children }) =>
    textResult(service.decomposeTaskNode(nodeId, children.map(normalizeTaskNodeInput))),
);

server.registerTool(
  "harness_select_next_task_node",
  {
    description:
      "Select and mark the next executable TaskNode according to DFS or BFS traversal for the focused Trace.",
    inputSchema: {
      strategy: traversalStrategySchema,
      reason: z.string().min(1),
    },
  },
  async ({ strategy, reason }) =>
    textResult(service.selectNextTaskNode(strategy as TraversalStrategy, reason)),
);

server.registerTool(
  "harness_start_task_node",
  {
    description: "Mark a focused-Trace TaskNode as running before working on that recursive subgoal.",
    inputSchema: {
      nodeId: z.string().min(1),
      reason: z.string().min(1),
    },
  },
  async ({ nodeId, reason }) => textResult(service.startTaskNode(nodeId, reason)),
);

server.registerTool(
  "harness_complete_task_node",
  {
    description: "Mark a focused-Trace TaskNode as completed with a concrete result summary.",
    inputSchema: {
      nodeId: z.string().min(1),
      resultSummary: z.string().min(1),
    },
  },
  async ({ nodeId, resultSummary }) =>
    textResult(service.completeTaskNode(nodeId, resultSummary)),
);

server.registerTool(
  "harness_fail_task_node",
  {
    description: "Mark a focused-Trace TaskNode as failed with the observed reason or result.",
    inputSchema: {
      nodeId: z.string().min(1),
      resultSummary: z.string().min(1),
    },
  },
  async ({ nodeId, resultSummary }) => textResult(service.failTaskNode(nodeId, resultSummary)),
);

server.registerTool(
  "harness_prune_task_node",
  {
    description:
      "Mark a focused-Trace TaskNode as pruned when it is duplicate, unnecessary, blocked by policy, or no longer relevant.",
    inputSchema: {
      nodeId: z.string().min(1),
      resultSummary: z.string().min(1),
    },
  },
  async ({ nodeId, resultSummary }) => textResult(service.pruneTaskNode(nodeId, resultSummary)),
);

server.registerTool(
  "harness_recall",
  {
    description:
      "Recall globally shared usable Experiences and completed Skills for the current Task and stage. Call at RECALL, after substantive plan changes, and after tool or test failures.",
    inputSchema: {
      technologies: z.array(z.string().min(1)).default(["typescript", "node"]),
      errorContext: z.string().optional(),
      tokenBudget: z.number().int().min(128).max(8192).default(2048),
      disabled: z.boolean().default(false),
    },
  },
  async ({ technologies, errorContext, tokenBudget, disabled }) =>
    textResult(service.recall({
      technologies,
      tokenBudget,
      disabled,
      ...(errorContext ? { errorContext } : {}),
    })),
);

server.registerTool(
  "harness_record_recall_feedback",
  {
    description: "Record whether a recalled Experience or Skill was adopted and why.",
    inputSchema: {
      recallEventId: z.string().min(1),
      assetId: z.string().min(1),
      adopted: z.boolean(),
      reason: z.string().min(1),
    },
  },
  async ({ recallEventId, assetId, adopted, reason }) =>
    textResult(service.recordRecallFeedback(recallEventId, assetId, adopted, reason)),
);

server.registerTool(
  "harness_evaluate_project",
  {
    description:
      "Run the configured or automatically discovered deterministic typecheck, build, and test graders. Only available in VERIFY or REVIEW.",
    inputSchema: {},
  },
  async () =>
    textResult(
      service.evaluateProject(process.env.HARNESS_PROJECT_DIR ?? process.cwd()),
    ),
);

process.on("SIGINT", () => {
  service.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  service.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function normalizeTaskNodeInput(input: {
  nodeId?: string | undefined;
  title: string;
  description: string;
  isAtomic: boolean;
}) {
  return {
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    title: input.title,
    description: input.description,
    isAtomic: input.isAtomic,
  };
}
