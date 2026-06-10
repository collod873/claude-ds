#!/usr/bin/env bash
# Smoke-test a packed claude-ds tarball exactly like a consumer install.
#
# Single source for the tarball smoke (#525, #526): install-smoke.yml runs it
# on every push/PR, and release.yml's publish job runs it against the exact
# tarball that ships to npm. Reuse, don't fork — a smoke that drifts between
# the two stops proving the publish artifact works.
#
# Usage: bash scripts/smoke-tarball.sh <path-to-tarball>
# Must run from the repo root (reads package.json for the expected version).
# The caller owns the tarball — this script never deletes it.
set -euo pipefail

TARBALL=${1:?usage: smoke-tarball.sh <path-to-tarball>}
# Absolutize before cd'ing into the scratch consumer.
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
test -f "$TARBALL" || { echo "FAIL: tarball $TARBALL not found"; exit 1; }
EXPECTED="v$(node -p "require('./package.json').version")"
echo "checkpoint: smoking $TARBALL, expecting $EXPECTED"

SCRATCH=$(mktemp -d)
# Fresh npm cache: a persistent cache (e.g. on a self-hosted runner) must not
# be able to satisfy the install with a previously built copy.
npm_config_cache=$(mktemp -d)
export npm_config_cache
trap 'rm -rf "$SCRATCH" "$npm_config_cache"' EXIT

# Next-shaped scratch consumer (#525): src/app router tree + tsconfig
# path alias, enough for framework-facing behavior (app-dir detection)
# to trigger on the real install path. Deep framework behavior stays
# owned by tests/integration/next-fixture.test.ts — keep this shallow.
git -C "$SCRATCH" init -q
printf '{"name":"scratch-consumer","private":true}\n' > "$SCRATCH/package.json"
mkdir -p "$SCRATCH/src/app"
printf 'export default function RootLayout({ children }) { return children; }\n' > "$SCRATCH/src/app/layout.tsx"
printf 'export default function Home() { return null; }\n' > "$SCRATCH/src/app/page.tsx"
printf '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}\n' > "$SCRATCH/tsconfig.json"
printf 'node_modules/\n' > "$SCRATCH/.gitignore"
cd "$SCRATCH"
echo "checkpoint: Next-shaped scratch consumer repo ready"

npm install --no-save "$TARBALL"
GOT=$(npx --no-install claude-ds -V)
if [ "$GOT" != "$EXPECTED" ]; then
  echo "FAIL: version mismatch — got '$GOT', expected '$EXPECTED'"
  exit 1
fi
echo "OK: CLI ran from tarball install and printed $GOT"

# Declare next/react AFTER the tarball install: detection reads
# package.json, not node_modules, and declaring them earlier would
# make `npm install` pull all of Next through the cold cache on
# every run — this is a smoke, keep it cheap.
node -e "const f='package.json',p=require('./'+f);p.dependencies={next:'^15.0.0',react:'^19.0.0','react-dom':'^19.0.0'};require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"

# Commit the consumer state so adopt's clean-tree guard sees what a
# real consumer has: project files + install committed, no
# --allow-dirty escape hatch.
git add -A
git -c user.name=smoke -c user.email=smoke@invalid commit -qm "next-shaped scratch consumer"

# The real consumer entry path: adopt reads the pack manifest and
# copies pack files out of the installed package, so a runtime file
# missing from the `files` allowlist fails here (#477) — and the
# Next shape makes framework detection run from the tarball (#525).
npx --no-install claude-ds adopt --pack next-react
if [ ! -f .claude-ds.json ]; then
  echo "FAIL: adopt exited 0 but wrote no .claude-ds.json"
  exit 1
fi
if [ ! -f .claude/hooks/atom-imports.sh ]; then
  echo "FAIL: adopt exited 0 but laid down no pack hook files"
  exit 1
fi
APP_DIR=$(node -p "JSON.parse(require('fs').readFileSync('.claude-ds.json','utf8')).app_dir")
if [ "$APP_DIR" != "src/app" ]; then
  echo "FAIL: expected app_dir 'src/app' (Next shape not detected), got '$APP_DIR'"
  exit 1
fi
echo "OK: adopt scaffolded the Next-shaped consumer (app_dir=$APP_DIR)"

# Never-break-a-consumer: installing the package must NOT touch the
# consumer repo's git config (tarball installs don't run `prepare`,
# and this proves it stays that way).
if HOOKSPATH=$(git config core.hookspath); then
  echo "FAIL: install set consumer core.hookspath to '$HOOKSPATH'"
  exit 1
fi
echo "OK: consumer core.hookspath untouched"
