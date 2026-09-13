# Add Ark Kimi K3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ace:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kimi-k3` as a first-class Ark model in Agent Harness so users can select it from Claude Code `/model` and from the existing Bash shortcuts.

**Architecture:** Agent Harness keeps Claude-first model display constrained through `config/claude-model-picker.json`, while Bash shortcut scripts provide compatibility launch profiles. The new model should reuse the existing Ark URL and `ARK_API_KEY`; only the model id, labels, aliases, tests, and docs need to change.

**Tech Stack:** Bash scripts, JSON Claude settings, Vitest, TypeScript build, Claude Code Router profile configuration.

## Global Constraints

- Keep supported Ark endpoint as `https://ark.cn-beijing.volces.com/api/coding/v3` for CCR-backed `/model` routing.
- Preserve existing `glm-5.3-flash` and `kimi-k2.7-code` behavior.
- Add `kimi-k3`; do not add unrelated models.
- DeepSeek remains official API only.
- Prefer Bash-compatible user workflows.

---

### Task 1: Model Picker And Shortcut Tests

**Files:**
- Modify: `tests/harness-launcher.test.ts`
- Modify: `tests/provider-launcher.test.ts`

**Interfaces:**
- Consumes: `config/claude-model-picker.json` fields `availableModels` and `modelPicker.options`.
- Produces: Test expectations that require `ark/kimi-k3` in the model picker and `ark-kimi3` through provider shortcuts.

- [ ] **Step 1: Write failing model picker test**

In `tests/harness-launcher.test.ts`, update the exact model list assertion to include `ark/kimi-k3` after `ark/kimi-k2.7-code`.

- [ ] **Step 2: Write failing provider shortcut test**

In `tests/provider-launcher.test.ts`, add a test that runs:

```bash
AGENT_HARNESS_DRY_RUN=1 ARK_API_KEY=test-key bash scripts/claude-provider.sh ark-kimi3 --print hi
```

Expected stderr contains `Starting Agent Harness with Volcano Ark (kimi-k3).` and stdout contains `npm run dev -- controlled-run --model kimi-k3 --print hi`.

- [ ] **Step 3: Verify RED**

Run:

```bash
npm test -- tests/harness-launcher.test.ts tests/provider-launcher.test.ts
```

Expected: FAIL because `ark/kimi-k3` and `ark-kimi3` are not implemented yet.

### Task 2: Add Kimi K3 To Runtime Config And Bash Launchers

**Files:**
- Modify: `config/claude-model-picker.json`
- Modify: `scripts/claude-provider.sh`
- Modify: `scripts/claude-provider-menu.sh`
- Modify: `scripts/install-claude-shortcuts.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: Ark key variable `ARK_API_KEY`.
- Produces: `/model ark/kimi-k3`, menu alias `kimi3`, shortcut `kimi3`, and npm scripts `kimi3` / `claude:ark:kimi3`.

- [ ] **Step 1: Add model picker entry**

Add `ark/kimi-k3` to `availableModels` and add a modelPicker option:

```json
{
  "model": "ark/kimi-k3",
  "label": "Kimi K3 (Ark)",
  "description": "Kimi K3 coding model through Volcengine Ark",
  "behavesAs": "claude-sonnet-4-6"
}
```

- [ ] **Step 2: Add provider launcher profile**

Add `ark-kimi3` to `scripts/claude-provider.sh` using provider name `Volcano Ark`, base URL `https://ark.cn-beijing.volces.com/api/coding/v3`, model `kimi-k3`, API key `ARK_API_KEY`.

- [ ] **Step 3: Add menu alias**

Add menu choice `kimi3` in `scripts/claude-provider-menu.sh`, keeping `kimi` mapped to `kimi-k2.7-code`.

- [ ] **Step 4: Add install shortcut and npm scripts**

Add shell shortcut `kimi3` in `scripts/install-claude-shortcuts.sh`; add package scripts `kimi3` and `claude:ark:kimi3`.

- [ ] **Step 5: Verify GREEN for focused tests**

Run:

```bash
npm test -- tests/harness-launcher.test.ts tests/provider-launcher.test.ts
```

Expected: PASS.

### Task 3: Docs And CCR Profile Update

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/claude-code-coverage.md`
- Mutate local user CCR profile store if present.

**Interfaces:**
- Consumes: local CCR profile store on the user's WSL side.
- Produces: Docs that list five supported models and a local CCR profile where `/model` can show `ark/kimi-k3`.

- [ ] **Step 1: Update docs**

Document supported Ark models as `glm-5.3-flash`, `kimi-k2.7-code`, and `kimi-k3`; document new `kimi3` shortcut.

- [ ] **Step 2: Inspect CCR store without printing secrets**

Use a read-only WSL command to locate CCR config and print provider/model names only.

- [ ] **Step 3: Back up and update CCR store**

If a local CCR config database exists, make a timestamped backup, then add `kimi-k3` to the Ark provider model list without printing API keys.

- [ ] **Step 4: Verify real routing if credentials exist**

Run a non-secret smoke command for `ark/kimi-k3`. If upstream credentials reject it, report the HTTP status and which layer rejected it.

### Task 4: Full Verification And Commit

**Files:**
- All changed files.

**Interfaces:**
- Consumes: complete repo tests.
- Produces: committed and pushed branch with verified changes.

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all pass.

- [ ] **Step 2: Commit**

Commit with:

```bash
git add .
git commit -m "feat: add Ark Kimi K3 model"
```

- [ ] **Step 3: Push**

Push branch:

```bash
git push -u origin codex/add-ark-kimi-k3
```
