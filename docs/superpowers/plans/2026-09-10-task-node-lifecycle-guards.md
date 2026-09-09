# TaskNode Lifecycle Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ace:subagent-driven-development (recommended) or ace:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent MCP-managed TaskNode operations from mutating terminal nodes or nodes outside the focused Trace.

**Architecture:** Keep low-level EventLedger append-only and enforce user-facing policy in `HarnessService`, the MCP boundary. Focused Trace scope validation returns the current node projection, and mutation methods reject terminal `completed` and `pruned` nodes.

**Tech Stack:** TypeScript, Node.js 22+, Vitest, SQLite projections, Bash/WSL2.

## Global Constraints

- Projection replay remains descriptive and does not reject historical events.
- HarnessService is the policy boundary for MCP-driven TaskNode mutations.
- Terminal TaskNodes are `completed` and `pruned`.
- Failed nodes can still be retried or decomposed.

---

## Task 1: RED Test

**Files:**
- Modify: `tests/harness-service.test.ts`

- [x] Step 1: Complete a TaskNode.
- [x] Step 2: Assert decomposing, starting, failing, or pruning the completed node throws a terminal-state error.
- [x] Step 3: Run focused test and verify failure.

## Task 2: Implementation

**Files:**
- Modify: `src/integration/harness-service.ts`

- [x] Step 1: Make focused-node validation return the node projection.
- [x] Step 2: Add terminal-node guard.
- [x] Step 3: Apply guard before every mutating TaskNode method except read and root creation.
- [x] Step 4: Run focused tests until green.

## Task 3: Verification

- [x] Step 1: Run `npm run typecheck`.
- [x] Step 2: Run `npm run build`.
- [x] Step 3: Run `npm test`.
