# 小文喵 File Toolkit

本地桌面文件工具箱，基于 Tauri 2、React 19 和 Rust。当前定位是个人本地产品：文件统计、归类、批量重命名、文件去重、视频截取、批量去片头、格式转换和水印处理。

<p align="center">
  <img src="icon.png" width="128" alt="小文喵">
</p>

## 功能范围

| 模块 | 能力 | 关键边界 |
| --- | --- | --- |
| 文件统计 | 递归扫描目录，按类型统计数量和大小 | 可取消；只读扫描，不移动文件 |
| 文件归类 | 按日期、类型、扩展名预览后移动归档 | 仅处理绝对路径普通文件；不跟随符号链接；原子移动且不覆盖；跨卷时保留源文件并提示 |
| 批量重命名 | 前后缀、查找替换、序号、大小写规则 | 前后端双重冲突检查；不覆盖已有项或悬空链接；支持同卷大小写重命名和最近一次撤销 |
| 文件去重 | 默认媒体范围，大小分组 + 快速指纹筛候选 + 完整 xxHash3 确认，缩略图预览 | 删除前重新完整哈希待删文件和保留副本；变化即停止；始终保留至少一份并进入回收站 |
| 视频截取 | 时间轴预览，精确导出默认开启，快速导出可选 | 精确导出会重编码；快速导出只适合关键帧附近起点，并带结果时长校验 |
| 批量去头 | 批量裁掉视频开头片段，输出到源目录或指定目录 | 后缀不能包含路径字符；取消会保留并展示已完成项；输出路径自动避让已有项 |
| 格式转换 | 常见视频格式转换和画质选择 | FFmpeg/FFprobe 均纳入任务取消；先写同目录私有临时文件，再无覆盖提交 |
| 水印处理 | 单图/批量水印处理，支持基础覆盖、模糊和修复 | 处理中锁定编辑；CPU 修复与 FFmpeg 可取消；批量取消后保留完成/失败/未处理统计 |
| 运行日志 | 最近日志查看、搜索、级别筛选、模块筛选和复制 | 不记录文件名或路径；保留 7 天并限制为 5MB，查看器最多加载最近 256KB/1000 行 |

已移除：文生图模块。当前产品边界聚焦本地文件和媒体处理，不接入外部图片生成服务。

## 交互约定

- 左侧栏按「文件 / 视频 / 图像」分组，宽屏显示文字，窄屏自动收为图标栏。
- 左侧底部「重置全部」会重置所有模块的临时状态。
- 顶部「重置当前」只重置当前模块。
- 任意任务运行中不能重置全部；当前模块任务运行中不能重置当前模块。
- 文件选择、目标路径确认和保存对话框等准备阶段也会锁定对应编辑与重置入口，避免旧任务在页面重置后继续运行。
- 文件写入类操作默认不覆盖已有文件，必须先预览或确认。
- 归类和重命名只使用同一文件系统内的原子移动；跨卷不会退化为复制后删除。

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

2026-07-10 本地完整验证结果：前端 40 项、Rust 42 项既有测试全部通过，TypeScript、Vite build、Rust fmt 和 clippy 通过。本轮没有新增测试用例。

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
│   ├── file_ops.rs            # 路径校验、无覆盖移动、私有临时输出与原子提交
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

本仓库当前仍按个人本地产品维护。`tag.sh` 现在只做本地版本准备和完整验证：

```bash
./tag.sh v0.1.0
```

它不会 commit、创建/删除 tag、push、触发工作流或发布 Release。远端 Release 工作流也只允许手动触发，并要求现有 tag、四个平台独立的 HTTPS FFmpeg 包及 SHA-256、再分发确认；产物固定为 unsigned prerelease draft，并绑定 `release-draft` environment。

Agent 或脚本不得在没有明确确认时执行以下操作：

- 下载或替换 FFmpeg 二进制。
- 执行 `tag.sh`、创建 tag、push 远程、触发 GitHub Actions。
- 签名、notarize、上传安装包或发布 release。
- 把 `node_modules/`、`dist/`、`tmp/`、`src-tauri/target/`、`src-tauri/binaries/`、安装包、本地媒体样本或运行日志加入 Git。

仓库当前没有可用于公开分发决策的 `LICENSE`、`NOTICE` 或第三方许可清单。公开发布仍被以下事项阻塞：应用许可证选择、FFmpeg 来源与再分发材料、macOS 签名/notarization、Windows 安装包签名、发布/回滚责任人和安装包实机验收。不得把 draft 直接转为公开 Release。

## 相关文档

- [架构设计](docs/架构设计.md)
- [开发指南](docs/开发指南.md)
- [设计思路](docs/设计思路.md)
- [当前交接](docs/handoff-2026-07-10.md)
