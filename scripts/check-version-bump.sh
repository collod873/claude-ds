#!/usr/bin/env bash
# check-version-bump.sh — forgot-to-bump detector (#383).
#
# Run on `main` in CI. Fails loudly if main has unreleased `feat`/`fix`
# commits past the latest `v*` tag but `package.json` was never bumped —
# the silent failure mode where `auto-tag.yml` keeps no-op'ing because
# `v$version` already exists, so nothing ever releases.
#
# Logic:
#   - latest = highest semver tag matching `v*` (none → exit 0; nothing
#     to compare against on a fresh repo).
#   - version = package.json `version` field.
#   - If `v$version` != latest, a release is already mid-flight (the bump
#     commit landed; auto-tag will create the matching tag on this push)
#     — exit 0.
#   - Otherwise, scan commit subjects in `$latest..HEAD` for conventional
#     `feat` / `fix` prefixes (with optional scope and `!` breaking
#     marker). One match → fail loud with the message the proposal pinned.
#
# Exit 0 clean; exit 1 on detection; exit 2 on a malformed setup the
# script can't reason about.
set -euo pipefail

# Latest semver tag. `git tag --sort=-v:refname` orders by semver desc;
# `head -n1` gives the highest. `--list 'v*'` keeps non-release tags out.
latest=$(git tag --list 'v*' --sort=-v:refname | head -n1)

if [[ -z "${latest}" ]]; then
  echo "check-version-bump: no v* tags yet — nothing to compare against."
  exit 0
fi

if [[ ! -f package.json ]]; then
  echo "check-version-bump: no package.json at $(pwd)." >&2
  exit 2
fi

version=$(node -p "require('./package.json').version" 2>/dev/null || true)
if [[ -z "${version}" ]]; then
  echo "check-version-bump: could not read version from package.json." >&2
  exit 2
fi

expected_tag="v${version}"

if [[ "${expected_tag}" != "${latest}" ]]; then
  echo "check-version-bump: package.json is at ${version} but latest tag is ${latest} — release in progress, auto-tag will handle it."
  exit 0
fi

# Conventional-commit prefixes that signify a release-worthy change. The
# regex covers `feat:`, `feat(scope):`, `feat!:`, `feat(scope)!:` and the
# same for `fix`. Anything else (docs/chore/test/ci/refactor/style/perf —
# perf could arguably ship, but conventional commits puts it under chore
# discipline; if a perf change is shippable, author it as `feat` or `fix`).
release_commits=$(git log "${latest}..HEAD" --pretty=format:'%s' --no-merges \
  | grep -E '^(feat|fix)(\([^)]+\))?!?:' || true)

if [[ -z "${release_commits}" ]]; then
  echo "check-version-bump: no unreleased feat/fix commits past ${latest} — ok."
  exit 0
fi

count=$(printf '%s\n' "${release_commits}" | wc -l | tr -d ' ')

# Fail-loud message. The proposal pinned the wording — keep it intact.
{
  echo "::error::main has unreleased changes — bump \`package.json\`."
  echo ""
  echo "${count} feat/fix commit(s) past ${latest} with package.json still at ${version}:"
  echo "${release_commits}" | sed 's/^/  - /'
  echo ""
  echo "Resolution: bump \`version\` in package.json (and add a matching"
  echo "\`## [<new>]\` section to CHANGELOG.md), commit, push. auto-tag.yml"
  echo "will cut the tag + GitHub Release + README pin on that push."
} >&2

exit 1
