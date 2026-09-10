# Controlled Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ace:subagent-driven-development (recommended) or ace:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the runtime posture from Claude-controlled bookkeeping to Harness-controlled execution gates.

**Architecture:** Keep Claude Code as the worker process, but make Harness the runtime launcher and policy authority. `harness run` injects enforced control mode; Hook `PreToolUse` records and blocks disallowed worker actions by lifecycle stage; managed prompt tells Claude it is a worker, not the controller.

**Tech Stack:** TypeScript, Node.js 22+, Claude Code Hook plugin, Vitest, SQLite EventLedger.

## Global Constraints

- Preserve the current provider profiles and Bash-first workflow.
- Do not save complete underlying model request/response payloads.
- Use Git worktree isolation for Case and Skill validation.
- Keep EventLedger append-only.
- Build the first enforced path for TypeScript reproducible test repair.

---

## Task 1: Add Hook policy gate

**Files:**
- Create: `src/integration/tool-policy.ts`
- Modify: `src/integration/hook-processor.ts`
- Test: `tests/hook-policy.test.ts`

**Interfaces:**
- Produces: `evaluateToolPolicy(input, context, mode): ToolPolicyDecision`
- Consumes: current `ClaudeHookInput`, projected lifecycle `Stage`

- [x] **Step 1: Write failing tests**

Test denied write tools in `INTAKE`, allowed read tools in `INTAKE`, denied all tools after `COMPLETE`, and stage-specific Bash allowance.

- [x] **Step 2: Run focused tests and observe RED**

Run: `npm test -- tests/hook-policy.test.ts`

Expected: fails because policy module does not exist.

- [x] **Step 3: Implement minimal policy**

Add `tool-policy.ts` with explicit allow/deny rules. Integrate it into `HookProcessor.process()` for `PreToolUse`.

- [x] **Step 4: Run focused tests and observe GREEN**

Run: `npm test -- tests/hook-policy.test.ts`

Expected: pass.

## Task 2: Make run mode enforce Harness gates

**Files:**
- Modify: `src/cli.ts`
- Modify: `scripts/claude-provider.sh`
- Test: `tests/provider-launcher.test.ts`

**Interfaces:**
- `harness run` and `harness controlled-run` both launch Claude with `HARNESS_CONTROL_MODE=enforce`.
- Dry-run provider output makes the Harness-first command visible.

- [x] **Step 1: Write/update failing test**

Extend provider launcher test to assert dry-run includes `controlled-run`.

- [x] **Step 2: Implement CLI alias and env injection**

Add `controlled-run` command and set `HARNESS_CONTROL_MODE=enforce` inside `runClaude()`.

- [x] **Step 3: Run focused test**

Run: `npm test -- tests/provider-launcher.test.ts`

Expected: pass.

## Task 3: Reframe managed prompt and docs

**Files:**
- Modify: `plugin/managed-prompt.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`

**Interfaces:**
- Prompt states Claude is a worker under Harness control.
- Docs distinguish hard Hook gate from soft MCP bookkeeping.

- [x] **Step 1: Update prompt**

Replace controller language with worker-only obligations.

- [x] **Step 2: Update docs**

Document `Harness -> policy Hook gate -> Claude worker`.

- [x] **Step 3: Run full verification**

Run: `npm run typecheck`, `npm run build`, `npm test`.

Expected: all pass.
