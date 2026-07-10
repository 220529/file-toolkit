# File Toolkit Migration

## Source

`/Users/kaixin/ai/products/file-toolkit`

Remote:

`git@github.com:220529/file-toolkit.git`

## Catalog State

- status: `indexed`
- migration_status: `index_only`
- risk_level: `medium`

公开发布 readiness 仍为 `blocked`，不要与目录迁移状态混用。

## Blockers

- 仓库尚无 `LICENSE`、`NOTICE` 或第三方许可清单，不能据此公开分发应用或 FFmpeg。
- FFmpeg 固定来源、版本/架构清单和再分发依据仍需人工确认。
- macOS 签名/notarization、Windows 签名、发布责任人、实机验收和回滚流程尚未确认。

## Decision

Keep indexed but not adopted. 2026-07-10 已完成文件操作安全、任务取消、日志隐私、Tauri asset scope、手动 draft release 和生成物清理。发布工作流不会因 tag push 自动公开 Release，但外部许可、签名和责任边界仍阻止 adopted/public release。

Project-level `.npmrc` points npm cache, pnpm store, and pnpm state to `/private/tmp` and disables pnpm self-managed version switching so dependency caches and pnpm tools do not become workspace assets or write into the user home directory.

## Cleanup Result

- 已删除仓库内旧 `src-tauri/target/`（约 12GB）、`dist/`、`tmp/`、`src-tauri/gen/` 和 `.DS_Store`。
- 已删除约 18MB 的无引用本地水印样本、旧差异图、两个无引用设计导出和误用 `.jpg` 扩展名的 PNG 截图。
- 保留被 README/设计文档引用的 `icon.png` 与 `docs/design/exports/file-toolkit-antd-v1-board.png`。
- `node_modules/` 保留用于本地开发；`src-tauri/binaries/` 当前为空。两者均继续忽略，不构成源码资产。

## Verification

2026-07-10：

```bash
env CARGO_TARGET_DIR=/private/tmp/file-toolkit-cargo-target pnpm run verify
```

结果：TypeScript、Vite build、Rust fmt/clippy 通过；40 个前端既有测试和 42 个 Rust 既有测试全部通过。

## Next Actions

1. 由 owner 选择应用许可证，并准备 `LICENSE`、`NOTICE`/第三方许可清单。
2. 固定每个平台 FFmpeg 构建来源、版本、架构、SHA-256 和再分发依据。
3. 配置受保护的 `release-draft` environment、平台签名/notarization、实机安装验收和回滚 owner。
4. 以上完成前保持 `indexed / index_only / medium`，不要升级为 adopted 或公开发布。
