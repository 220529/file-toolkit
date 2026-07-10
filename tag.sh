#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

TAG="${1:-}"
if [[ ! "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Usage: ./tag.sh vMAJOR.MINOR.PATCH" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree must be clean before preparing a release version." >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/tags/$TAG"; then
  echo "Tag already exists locally: $TAG" >&2
  exit 1
fi

node scripts/release-version.mjs set "$TAG"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/file-toolkit-cargo-target}"
cargo check --manifest-path src-tauri/Cargo.toml
pnpm run verify
node scripts/release-version.mjs check "$TAG"
git diff --check

echo
echo "Release version $TAG is prepared and verified locally."
echo "No commit, tag, push, workflow, upload, or release action was performed."
echo "Review the version diff and release blockers before requesting those actions explicitly."
git status --short
git diff --stat
