# Harness-First Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ace:subagent-driven-development (recommended) or ace:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cc`, `kimi`, `glm`, `ds`, and `dsp` enter Agent Harness first, with Harness then launching Claude Code in managed mode.

**Architecture:** Provider scripts still choose model provider environment variables, but their final exec target changes from `claude --model ...` to `npm run dev -- run --model ...`. This preserves provider selection while ensuring Hook/MCP/managed prompt are always attached by `HarnessService.runClaude`.

**Tech Stack:** Bash, TypeScript/Vitest, Node.js 22+, WSL2.

## Global Constraints

- Do not remove direct `claude` support from the user's machine; only change project shortcuts.
- Provider selection must still support Ark GLM, Ark Kimi, DeepSeek Flash, and DeepSeek Pro.
- Shortcuts installed by `scripts/install-claude-shortcuts.sh` should inherit Harness-first behavior through the provider scripts.
- Keep existing `npm run claude:*` aliases compatible, but their behavior becomes Harness-managed.

---

## Task 1: RED Test for Provider Launcher

**Files:**
- Create: `tests/provider-launcher.test.ts`

- [x] Step 1: Run `scripts/claude-provider.sh ark-kimi` with a fake key and fake `claude` binary in PATH.
- [x] Step 2: Assert dry-run output says it would launch `npm run dev -- run --model kimi-k2.7-code`.
- [x] Step 3: Assert output does not use direct `claude --model`.
- [x] Step 4: Run focused test and verify it fails against current direct-Claude behavior.

## Task 2: Implement Harness-First Provider Script

**Files:**
- Modify: `scripts/claude-provider.sh`

- [x] Step 1: Change startup message to `Starting Agent Harness with ...`.
- [x] Step 2: Add `AGENT_HARNESS_DRY_RUN=1` diagnostic path for tests and user troubleshooting.
- [x] Step 3: Replace final `exec claude --model "$model" "$@"` with `exec npm run dev -- run --model "$model" "$@"`.
- [x] Step 4: Run focused test until green.

## Task 3: Docs and Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [x] Step 1: Document that `cc/kimi/glm/ds/dsp` are Harness-first managed launchers.
- [x] Step 2: Run `npm run typecheck`.
- [x] Step 3: Run `npm run build`.
- [x] Step 4: Run `npm test`.
