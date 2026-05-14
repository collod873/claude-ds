#!/usr/bin/env bash
# Append a structured failure entry. Args: rule_id file line hint
set -euo pipefail
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf -- "- %s | %s | %s:%s | %s\n" "$ts" "$1" "$2" "$3" "$4" >> failure-log.md
