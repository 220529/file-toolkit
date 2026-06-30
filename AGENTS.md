# AGENTS.md - File Toolkit

默认中文沟通。这个目录是 Tauri/React 文件工具箱产品仓库，目前在 catalog 中是 medium-risk blocked 资产，主要原因是生成目录和发布边界尚未复核。

## Allowed Work

- 可以修改源码、README、测试、示例和本地验证脚本。
- 修改前先检查 `git status --short`，避免覆盖用户本地改动。
- 生成包、缓存、临时目录和 FFmpeg 二进制不进入 Git。

## Boundaries

- 不提交 `.env`、API key、cookie、完整连接串、私有日志、生产数据或用户文件样本。
- 不把 `node_modules/`、`dist/`、`tmp/`、`src-tauri/target/`、`src-tauri/binaries/`、安装包或本地数据加入 Git。
- 不发布 release、tag、远程 push、签名、上传安装包，除非用户明确确认。

## Verification

```sh
pnpm run verify
python3 /Users/kaixin/ai/catalog/scripts/check_catalog.py
```

如果本机依赖或 Rust/Tauri 环境不完整，至少运行能覆盖本次改动的最小命令并说明缺口。
