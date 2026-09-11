# Harness CCR Entrypoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ace:subagent-driven-development (recommended) or ace:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single `harness` launcher that enters Harness-controlled Claude Code through Claude Code Router, so `/model` can switch between CCR-configured API models.

**Architecture:** Keep provider-specific shortcuts as compatibility paths, but make `harness` the recommended entry. The new launcher starts/reuses CCR, points Claude Code at the CCR gateway, then launches `npm run dev -- controlled-run` without a fixed `--model`, leaving model switching to Claude Code `/model` backed by CCR routing.

**Tech Stack:** Bash, TypeScript CLI, Claude Code, Claude Code Router, Vitest.

## Global Constraints

- Bash / WSL2 remains the primary runtime.
- Harness must start before Claude Code.
- Claude Code remains in `HARNESS_CONTROL_MODE=enforce`.
- API keys are never committed; launcher reads user-owned env files or CCR local configuration.
- Do not remove existing provider shortcuts in this task; only de-emphasize them.

---

## Task 1: Add CCR-backed `harness` launcher

**Files:**
- Create: `scripts/harness.sh`
- Create: `config/harness-router.env.example`
- Test: `tests/harness-launcher.test.ts`

**Interfaces:**
- `scripts/harness.sh [claude args...]`
- Env: `AGENT_HARNESS_CCR_BASE_URL`, `AGENT_HARNESS_CCR_AUTH_TOKEN`, `AGENT_HARNESS_START_CCR`, `AGENT_HARNESS_DRY_RUN`

- [x] **Step 1: Write failing launcher test**
- [x] **Step 2: Implement the script**
- [x] **Step 3: Verify focused test passes**

## Task 2: Install and npm script integration

**Files:**
- Modify: `package.json`
- Modify: `scripts/install-claude-shortcuts.sh`
- Test: `tests/harness-launcher.test.ts`

**Interfaces:**
- `npm run harness`
- installed `~/.local/bin/harness`

- [x] **Step 1: Extend test for shortcut install**
- [x] **Step 2: Install `harness` shortcut without removing legacy shortcuts**
- [x] **Step 3: Verify focused test passes**

## Task 3: Documentation update

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Document `harness -> CCR -> /model` as the default path.
- Mark `glm/kimi/ds/dsp` as legacy direct-provider convenience commands.

- [x] **Step 1: Update user docs**
- [x] **Step 2: Run full verification**
