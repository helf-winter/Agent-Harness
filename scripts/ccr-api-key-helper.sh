#!/usr/bin/env bash
set -euo pipefail

identity_file="${ANTHROPIC_IDENTITY_TOKEN_FILE:-}"

if [[ -z "$identity_file" || ! -r "$identity_file" ]]; then
  printf 'CCR profile identity file is unavailable. Start Claude through `harness`.\n' >&2
  exit 2
fi

identity="$(tr -d '\r\n' < "$identity_file")"
if [[ -z "$identity" ]]; then
  printf 'CCR profile identity file is empty. Restart CCR, then run `harness` again.\n' >&2
  exit 2
fi

printf '%s\n' "$identity"
