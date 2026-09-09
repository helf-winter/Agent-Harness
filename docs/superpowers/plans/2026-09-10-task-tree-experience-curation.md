# Task Tree Experience Curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ace:subagent-driven-development (recommended) or ace:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve successful recursive TaskNode decomposition as reusable Experience strategy text and evidence.

**Architecture:** Keep Experience schema unchanged for this stage and enrich the existing `strategy` string with a deterministic TaskNode path summary. The curator reads projected TaskNodes for the successful Trace, includes TaskNode lifecycle event IDs as evidence, and lets Skill generation inherit the strategy unchanged.

**Tech Stack:** TypeScript, Node.js 22+, SQLite projection store, Vitest, Bash/WSL2.

## Global Constraints

- Do not add a schema migration for Experience in this step.
- TaskNode-derived strategy must be deterministic and compact.
- Only completed successful Trace curation should emit positive Experience.
- Existing observation-based strategy remains supported when no TaskNode tree exists.

---

## Task 1: RED Test for TaskNode Strategy Curation

**Files:**
- Modify: `tests/skill-lifecycle.test.ts`

**Interfaces:**
- Existing `ExperienceCurator.curate(traceId)` should include TaskNode path detail in `experience.strategy`.

- [x] Step 1: Add TaskNode events to the successful Trace fixture.
- [x] Step 2: Assert the curated Experience strategy includes a root-to-leaf recursive path.
- [x] Step 3: Assert TaskNode evidence event IDs are attached.
- [x] Step 4: Run `npm test -- tests/skill-lifecycle.test.ts` and verify failure.

## Task 2: Implement Deterministic TaskNode Summary

**Files:**
- Modify: `src/experiences/experience-curator.ts`

**Interfaces:**
- Internal helper `taskTreeStrategy(nodes)` returns compact lines such as `Recursive TaskNode path: Root -> Child -> Leaf`.
- Internal helper `taskNodeEvidence(events)` returns TaskNode event IDs.

- [x] Step 1: Read TaskNodes from `ProjectionStore.getTaskTree({ traceId })`.
- [x] Step 2: Build completed leaf paths ordered by depth and child index.
- [x] Step 3: Append summary to observation strategy.
- [x] Step 4: Include task_node event IDs in source evidence.
- [x] Step 5: Run focused test until green.

## Task 3: Verify and Document

**Files:**
- Modify: `README.md`

**Interfaces:**
- README states successful TaskNode paths can now be mined into Experience/Skill strategy.

- [x] Step 1: Add a concise README bullet.
- [x] Step 2: Run `npm run typecheck`, `npm run build`, and `npm test`.

## Self-Review

- Spec coverage: This connects recursive task traversal to the existing Experience/Skill lifecycle.
- Placeholder scan: No placeholders remain.
- Type consistency: No public schema change is required.
- Scope: This does not attempt model-based summarization; it uses deterministic projected TaskNode data.
