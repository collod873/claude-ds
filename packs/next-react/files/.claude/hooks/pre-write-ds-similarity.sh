#!/usr/bin/env bash
# SIM-* family: check component similarity before writing into design-system/
# Delegates to scripts/similarity-check.ts (lands in Slice F).
# Until Slice F ships, exits 1 (self-error) so the absence is visible without blocking.
set -euo pipefail

source "$(dirname "$0")/lib/read-hook-input.sh"
file="$HOOK_FILE_PATH"
if [ -z "$file" ]; then exit 0; fi

# Only fire for files under design-system/
case "$file" in
  *design-system/*) ;;
  *) exit 0 ;;
esac

similarity_script="scripts/similarity-check.ts"

if [ ! -f "$similarity_script" ]; then
  echo "$file:0: SIM-000: similarity-check.ts not present (expected after Slice F)" >&2
  exit 1
fi

# Slice F is present — delegate and proxy exit code
node --experimental-strip-types "$similarity_script" "$file"
