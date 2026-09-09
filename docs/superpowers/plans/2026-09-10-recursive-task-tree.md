# Recursive Task Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ace:subagent-driven-development (recommended) or ace:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a traceable recursive task tree so a Task can be decomposed into child TaskNodes and traversed with DFS or BFS strategy.

**Architecture:** Keep Claude Code as the execution agent and add Harness-level task tree bookkeeping. TaskNodes are projected from immutable events into SQLite, and traversal strategies are deterministic pure functions over the projected tree.

**Tech Stack:** TypeScript, Node.js 22+, SQLite via better-sqlite3, Vitest, Bash/WSL2.

## Global Constraints

- Do not redefine Task: Task remains the stable user goal; TaskNode is a recursive subgoal inside a Trace.
- Do not model this as generic search optimization; model it as recursive task decomposition plus traversal.
- First implementation is observable and queryable; it does not yet force Claude Code to follow the selected node.
- Preserve append-only Event Ledger semantics and projection replay.
- No new runtime dependency unless existing code cannot reasonably support the feature.

---

## File Structure

- Create `src/task-tree/types.ts`: TaskNode status, traversal strategy, event payload types, projected tree result types.
- Create `src/task-tree/traversal.ts`: deterministic DFS/BFS next-node selection.
- Create `src/task-tree/task-tree-service.ts`: append task-node lifecycle events through EventLedger.
- Modify `src/domain/event-types.ts`: add task node event constants.
- Modify `src/projections/projection-store.ts`: create and maintain `task_nodes` projection table; expose `listTaskNodes`, `getTaskNode`, and `getTaskTree`.
- Modify `src/cli.ts`: add `harness task tree <task-id|trace-id>` and `harness task node <node-id>`.
- Create `tests/task-tree.test.ts`: RED tests for event projection and DFS/BFS traversal.
- Modify `README.md`: document the new task tree commands and current boundary.

## Task 1: Add TaskNode Projection and Traversal Tests

**Files:**
- Create: `tests/task-tree.test.ts`
- Create: `src/task-tree/types.ts`
- Create: `src/task-tree/traversal.ts`
- Modify: `src/domain/event-types.ts`
- Modify: `src/projections/projection-store.ts`

**Interfaces:**
- Produces `TaskNodeProjection`, `TaskTreeProjection`, `TraversalStrategy`, `selectNextTaskNode(nodes, strategy)`.
- Produces projection APIs used by CLI: `listTaskNodes(scope)`, `getTaskNode(nodeId)`, `getTaskTree(scope)`.

- [x] Step 1: Write failing tests for projecting created/decomposed/completed TaskNodes.
- [x] Step 2: Write failing tests for DFS and BFS next-node selection.
- [x] Step 3: Run `npm test -- tests/task-tree.test.ts` and verify missing exports/table behavior fails.
- [x] Step 4: Add minimal types and traversal code.
- [x] Step 5: Add projection table and event handlers.
- [x] Step 6: Run focused tests until green.

## Task 2: Add TaskTree Service

**Files:**
- Create: `src/task-tree/task-tree-service.ts`
- Modify: `tests/task-tree.test.ts`

**Interfaces:**
- Produces `TaskTreeService.createRoot`, `decompose`, `select`, `start`, `complete`, `fail`, `prune`.
- Consumes `EventLedger` and task node event payload types.

- [x] Step 1: Add tests showing service appends deterministic task-node events.
- [x] Step 2: Run focused test and verify service is missing.
- [x] Step 3: Implement service methods with scoped event context.
- [x] Step 4: Run focused tests until green.

## Task 3: Add CLI Tree Inspection

**Files:**
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `tests/task-tree.test.ts` only if CLI behavior needs a focused helper.

**Interfaces:**
- CLI command: `harness task tree <task-id|trace-id>`
- CLI command: `harness task node <node-id>`

- [x] Step 1: Add CLI read paths using ProjectionStore.
- [x] Step 2: Print tree JSON containing `root`, `nodes`, and `next` for DFS/BFS.
- [x] Step 3: Document commands and boundary.
- [x] Step 4: Run `npm run typecheck`, `npm run build`, and `npm test`.

## Self-Review

- Spec coverage: The plan implements recursive TaskNode trees and DFS/BFS traversal without converting the system into a generic search optimizer.
- Placeholder scan: No implementation placeholders remain; each task has concrete files and commands.
- Type consistency: `TaskNodeProjection`, `TaskTreeProjection`, and `TraversalStrategy` are named consistently across tasks.
- Scope: The plan intentionally stops before forcing Claude Code scheduling; that belongs to the next stage after we can observe and replay task trees.
