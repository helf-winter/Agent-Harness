# Task Tree MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ace:subagent-driven-development (recommended) or ace:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose recursive TaskNode tree operations through HarnessService and MCP so Claude Code can record decomposition and follow DFS/BFS traversal suggestions during managed execution.

**Architecture:** Reuse the existing `TaskTreeService` for event writes and `ProjectionStore` for replayed tree reads. `HarnessService` becomes the policy boundary for current Trace scoping, while `mcp-server.ts` exposes narrow tools that operate only on the focused Task/Trace.

**Tech Stack:** TypeScript, Node.js 22+, MCP SDK, SQLite via better-sqlite3, Vitest, Bash/WSL2.

## Global Constraints

- Task remains the stable user goal; TaskNode remains the recursive subgoal inside the current Trace.
- MCP tools must only operate on the focused Task's active Trace.
- DFS/BFS provide deterministic next-node suggestions; they do not yet force Claude Code scheduling.
- All TaskNode mutations must be append-only ledger events, then replayed into projections.
- No new runtime dependency.

---

## File Structure

- Modify `src/integration/harness-service.ts`: add focused Trace TaskNode APIs and scope validation.
- Modify `src/integration/mcp-server.ts`: register MCP tools for tree read, root creation, decomposition, traversal selection, and node status changes.
- Modify `plugin/managed-prompt.md`: instruct Claude Code to record recursive decomposition in managed mode.
- Modify `tests/harness-service.test.ts`: add RED tests for service-level TaskNode operations.
- Modify `README.md`: document MCP-managed recursive task tree support.

## Task 1: HarnessService TaskNode API

**Files:**
- Modify: `tests/harness-service.test.ts`
- Modify: `src/integration/harness-service.ts`

**Interfaces:**
- `getTaskTree()`
- `createTaskNodeRoot(input)`
- `decomposeTaskNode(nodeId, children)`
- `selectNextTaskNode(strategy, reason)`
- `startTaskNode(nodeId, reason)`
- `completeTaskNode(nodeId, resultSummary)`
- `failTaskNode(nodeId, resultSummary)`
- `pruneTaskNode(nodeId, resultSummary)`

- [x] Step 1: Write a failing service test that creates a root, decomposes children, selects DFS/BFS, and completes a node.
- [x] Step 2: Run `npm test -- tests/harness-service.test.ts` and verify missing methods fail.
- [x] Step 3: Implement service methods using `TaskTreeService` and focused Trace scope.
- [x] Step 4: Run focused tests until green.

## Task 2: MCP Tool Exposure

**Files:**
- Modify: `src/integration/mcp-server.ts`

**Interfaces:**
- `harness_get_task_tree`
- `harness_create_task_node_root`
- `harness_decompose_task_node`
- `harness_select_next_task_node`
- `harness_start_task_node`
- `harness_complete_task_node`
- `harness_fail_task_node`
- `harness_prune_task_node`

- [x] Step 1: Add narrow zod schemas for TaskNode inputs and traversal strategy.
- [x] Step 2: Register tools and route to HarnessService methods.
- [x] Step 3: Run `npm run typecheck` and `npm run build`.

## Task 3: Prompt and Docs

**Files:**
- Modify: `plugin/managed-prompt.md`
- Modify: `README.md`

**Interfaces:**
- Managed prompt tells Claude when to create/decompose/select/complete TaskNodes.
- README documents the observable boundary and CLI/MCP split.

- [x] Step 1: Add concise managed-mode rules for recursive decomposition.
- [x] Step 2: Add README bullets for MCP TaskNode tools.
- [x] Step 3: Run `npm test`, `npm run typecheck`, and `npm run build`.

## Self-Review

- Spec coverage: The plan connects the already implemented recursive TaskNode tree to Harness MCP and managed prompt behavior.
- Placeholder scan: No placeholders or unspecified commands remain.
- Type consistency: Method names and MCP tool names are defined explicitly and reused consistently.
- Scope: This does not implement forced Claude scheduling; it enables controlled, traceable TaskNode bookkeeping and traversal suggestions first.
