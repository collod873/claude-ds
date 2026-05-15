#!/usr/bin/env bash
# SIM-* family: check component similarity before writing into design-system/
# Delegates to scripts/similarity-check.ts (lands in Slice F).
# Until Slice F ships, exits 1 (self-error) so the absence is visible without blocking.
set -euo pipefail

file="$1"

similarity_script="scripts/similarity-check.ts"

if [ ! -f "$similarity_script" ]; then
  echo "$file:0: SIM-000: similarity-check.ts not present (expected after Slice F)" >&2
  exit 1
fi

# Slice F is present — delegate and proxy exit code
npx ts-node "$similarity_script" "$file"
