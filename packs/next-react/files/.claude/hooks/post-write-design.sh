#!/usr/bin/env bash
# Post-write hook for design-system/** — regenerates manifest + snapshot.
# Slice F (build-manifest.ts) not yet present; stub exits 0.
# Slice H will update this hook once F lands — do not implement regen logic here.
set -euo pipefail

echo "post-write-design: manifest regen pending (Slice F)"
exit 0
