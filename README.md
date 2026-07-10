# 小文喵 File Toolkit

本地桌面文件工具箱，基于 Tauri 2、React 19 和 Rust。当前定位是个人本地产品：文件统计、归类、批量重命名、文件去重、视频截取、批量去片头、格式转换和水印处理。

<p align="center">
  <img src="icon.png" width="128" alt="小文喵">
</p>

## 功能范围

| 模块 | 能力 | 关键边界 |
| --- | --- | --- |
| 文件统计 | 递归扫描目录，按类型统计数量和大小 | 可取消；只读扫描，不移动文件 |
| 文件归类 | 按日期、类型、扩展名预览后移动归档 | 执行前预检冲突；不覆盖已有文件；支持撤销最近一次归类 |
| 批量重命名 | 前后缀、查找替换、序号、大小写规则 | 执行前预览和冲突检查；不覆盖已有文件；支持撤销最近一次重命名 |
| 文件去重 | 默认媒体范围，大小分组 + 快速指纹筛候选 + 完整 xxHash3 确认，缩略图预览 | 快速指纹不直接判重；删除走回收站；执行前二次确认；支持取消扫描 |
| 视频截取 | 时间轴预览，精确导出默认开启，快速导出可选 | 精确导出会重编码；快速导出只适合关键帧附近起点，并带结果时长校验 |
| 批量去头 | 批量裁掉视频开头片段，输出到源目录或指定目录 | 支持取消；输出路径自动避让已有文件 |
| 格式转换 | 常见视频格式转换和画质选择 | 依赖 FFmpeg；长任务可取消 |
| 水印处理 | 单图/批量水印处理，支持基础覆盖、模糊和修复 | 大选区修复成本高，需先预览和确认 |
| 运行日志 | 最近日志查看、搜索、级别筛选、模块筛选和复制 | 只用于本地排障，不写敏感数据 |

已移除：文生图模块。当前产品边界聚焦本地文件和媒体处理，不接入外部图片生成服务。

## 交互约定

- 左侧栏按「文件 / 视频 / 图像」分组，宽屏显示文字，窄屏自动收为图标栏。
- 左侧底部「重置全部」会重置所有模块的临时状态。
- 顶部「重置当前」只重置当前模块。
- 任意任务运行中不能重置全部；当前模块任务运行中不能重置当前模块。
- 文件写入类操作默认不覆盖已有文件，必须先预览或确认。

## 本地开发

### 环境要求

| 依赖 | 版本/说明 |
| --- | --- |
| Node.js | `>=20.19.0 || >=22.12.0` |
| pnpm | `10.28.1`，仓库声明在 `package.json` |
| Rust | 稳定版工具链 |
| FFmpeg/FFprobe | 开发时可使用系统 PATH；打包时按 `src-tauri/src/commands/ffmpeg_utils.rs` 的平台命名放入 `src-tauri/binaries/` |

项目通过 `scripts/tauri.mjs` 将 Cargo target 隔离到 `/private/tmp/file-toolkit-cargo-target/<仓库哈希>`，避免仓库移动后复用旧生成路径。

```bash
pnpm install
pnpm dev
```

如果只跑前端：

```bash
pnpm exec vite dev --port 1420
```

## 验证

提交前推荐完整验证：

```bash
env CARGO_TARGET_DIR=/private/tmp/file-toolkit-cargo-target pnpm run verify
```

当前 `pnpm run verify` 覆盖：

- `pnpm exec tsc --noEmit`
- `pnpm test`
- `pnpm exec vite build --outDir /tmp/file-toolkit-vite-build --emptyOutDir`
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`

变更较小时也可以先跑最小集，例如：

```bash
pnpm exec tsc --noEmit
pnpm run test -- src/pages/videoCut/utils.test.ts
cargo check --manifest-path src-tauri/Cargo.toml --target-dir /private/tmp/file-toolkit-cargo-target
pnpm run build
```

## 目录结构

```text
src/
├── App.tsx                    # 壳层、导航、重置、日志入口
├── api/                       # Tauri command 的 TypeScript 封装
├── components/                # 通用组件、任务中心、日志查看、基础 UI
├── pages/                     # 各功能模块页面
└── utils/                     # 路径、格式化、事件监听等工具

src-tauri/src/
├── commands/                  # Rust command 模块
├── lib.rs                     # 插件和 command 注册
└── main.rs                    # 桌面入口

docs/
├── 架构设计.md
├── 开发指南.md
├── 设计思路.md
├── 技术选型.md
└── design/                    # 当前 UI 设计稿和说明
```

## 发布边界

本仓库当前仍按个人本地产品维护。Agent 或脚本不得在没有明确确认时执行以下操作：

- 下载或替换 FFmpeg 二进制。
- 执行 `tag.sh`、创建 tag、push 远程、触发 GitHub Actions。
- 签名、notarize、上传安装包或发布 release。
- 把 `node_modules/`、`dist/`、`tmp/`、`src-tauri/target/`、`src-tauri/binaries/`、安装包、本地媒体样本或运行日志加入 Git。

发布前仍需确认 FFmpeg 二进制来源、许可证/再分发边界、macOS 签名/notarization、Windows 安装包签名、更新/回滚策略和用户文件隐私边界。

## 相关文档

- [架构设计](docs/架构设计.md)
- [开发指南](docs/开发指南.md)
- [设计思路](docs/设计思路.md)
- [当前交接](docs/handoff-2026-07-04.md)
