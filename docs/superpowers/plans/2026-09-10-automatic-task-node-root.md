# Automatic TaskNode Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ace:subagent-driven-development (recommended) or ace:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically create one root TaskNode whenever Harness creates a new Trace.

**Architecture:** Hook-created and MCP-created Tasks both append a `task_node.created` event immediately after `trace.started`. The root node uses the Task title as its title and keeps TaskNode decomposition inside the Trace instead of creating new Tasks.

**Tech Stack:** TypeScript, Node.js 22+, Vitest, SQLite EventLedger, Bash/WSL2.

## Global Constraints

- Only one root TaskNode may exist per Trace.
- Root creation must be append-only and replayed through ProjectionStore.
- Existing manual `createTaskNodeRoot` remains available for old Traces without a root.
- No migration or dependency change.

---

## Task 1: RED Tests

**Files:**
- Modify: `tests/hook-processor.test.ts`
- Modify: `tests/harness-service.test.ts`

- [x] Step 1: Assert HookProcessor creates a root TaskNode for the first UserPromptSubmit Trace.
- [x] Step 2: Assert HarnessService-created Tasks also have a root TaskNode.
- [x] Step 3: Run focused tests and verify failure.

## Task 2: Implementation

**Files:**
- Modify: `src/integration/hook-processor.ts`
- Modify: `src/integration/harness-service.ts`
- Modify: `plugin/managed-prompt.md`

- [x] Step 1: Append root TaskNode after `LifecycleController.startTrace` in HookProcessor.
- [x] Step 2: Append root TaskNode after `LifecycleController.startTrace` in HarnessService task creation.
- [x] Step 3: Update managed prompt to say root is normally pre-created.
- [x] Step 4: Run focused tests until green.

## Task 3: Verification

- [x] Step 1: Run `npm run typecheck`.
- [x] Step 2: Run `npm run build`.
- [x] Step 3: Run `npm test`.
