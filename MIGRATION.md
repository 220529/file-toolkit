# File Toolkit Migration

## Source

`/Users/kaixin/ai/products/file-toolkit`

Remote:

`git@github.com:220529/file-toolkit.git`

## Catalog State

- status: `indexed`
- migration_status: `blocked`
- risk_level: `medium`

## Blockers

- Repository itself is clean, but the working directory contains generated/runtime directories such as `node_modules/`, `dist/`, `tmp/`, `src-tauri/target/`, and local `data/`.
- Product release boundary, signing/notarization, FFmpeg binary handling, and publish workflow need review.

## Decision

Keep indexed but not adopted. README/AGENTS now document release, FFmpeg binary, generated-output, and local data boundaries. Promote to product asset only after generated-output cleanup review, release ownership, signing/notarization, FFmpeg redistribution, and user-file privacy boundaries are accepted.

Project-level `.npmrc` points npm cache, pnpm store, and pnpm state to `/private/tmp` and disables pnpm self-managed version switching so dependency caches and pnpm tools do not become workspace assets or write into the user home directory.

## Next Actions

1. Use `env CARGO_TARGET_DIR=/private/tmp/file-toolkit-cargo-target pnpm run verify` after migration.
2. Confirm generated directories are ignored and not required as source.
3. Decide FFmpeg binary source, license/redistribution policy, signing/notarization, release ownership, and rollback workflow.
4. Update catalog to `adopted` only after checks pass and the stale local `src-tauri/target/` policy is decided.
