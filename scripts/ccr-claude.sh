#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${AGENT_HARNESS_CCR_PROFILE:-default-claude-code}"
settings_file="${AGENT_HARNESS_CLAUDE_SETTINGS:-$repo_root/config/claude-model-picker.json}"
rendered_settings=""

if ! command -v ccr >/dev/null 2>&1; then
  printf 'Claude Code Router command `ccr` was not found.\n' >&2
  printf 'Install it with: npm install -g @musistudio/claude-code-router\n' >&2
  exit 2
fi

if [[ "$settings_file" == "$repo_root/config/claude-model-picker.json" ]]; then
  rendered_settings="$(mktemp "${TMPDIR:-/tmp}/agent-harness-claude-settings.XXXXXX.json")"
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const [source, target, helper] = process.argv.slice(1);
    const settings = JSON.parse(readFileSync(source, "utf8"));
    settings.apiKeyHelper = `bash ${helper}`;
    writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
  ' "$settings_file" "$rendered_settings" "$repo_root/scripts/ccr-api-key-helper.sh"
  settings_file="$rendered_settings"
fi

ccr "$profile" cli -- --settings "$settings_file" "$@"
status=$?
if [[ -n "$rendered_settings" ]]; then
  rm -f "$rendered_settings"
fi
exit "$status"
