# 小文喵 (File Toolkit)

<p align="center">
  <img src="icon.png" width="128" alt="小文喵">
</p>

<p align="center">
  <b>跨平台文件工具箱</b> —— 文件统计、文件归类、批量重命名、去重、视频处理、图像工具
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.0-blue" alt="Tauri">
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="React">
  <img src="https://img.shields.io/badge/Rust-1.70+-orange" alt="Rust">
</p>

## 功能

| 功能 | 说明 |
|------|------|
| 📊 文件统计 | 递归扫描，按类型统计数量和大小 |
| 🗂️ 文件归类 | 手动选择或拖入文件，按日期、类型、扩展名预览后移动归档，提前标记目标冲突，支持撤销最近一次归类 |
| 📝 批量重命名 | 多文件预览重命名，支持前后缀、查找替换、序号、大小写规则、目标冲突预检和撤销最近一次重命名 |
| 🔍 文件去重 | xxHash3 快速哈希，并行计算，缩略图预览 |
| ✂️ 视频截取 | 快速模式（无损）/ 精确模式，时间轴预览 |
| 🔄 格式转换 | 批量转换 MOV/MP4/GIF，支持画质选择 |
| 🖼️ 文生图 | 支持 OpenAI 兼容图片生成接口、默认配置读取、连接/权限自检和历史记录 |
| ✨ 去水印 | 高斯模糊 / 颜色覆盖，支持取色器 |
| 🧾 运行日志 | 最近日志查看、搜索、模块筛选、错误/警告计数和复制 |

## 下载

前往 [Releases](https://github.com/220529/file-toolkit/releases) 下载：

| 平台 | 文件 |
|------|------|
| macOS (Intel) | `小文喵_x.x.x_x64.dmg` |
| macOS (Apple Silicon) | `小文喵_x.x.x_aarch64.dmg` |
| Windows | `小文喵_x.x.x_x64-setup.exe` |
| Linux | `小文喵_x.x.x_amd64.deb` |

> 安装包已内嵌 FFmpeg，下载即用。
>
> macOS 提示：
> - Apple Silicon 机型请下载 `aarch64` 版本，Intel 机型请下载 `x64` 版本。
> - macOS 版本未签名，首次打开如果提示“已损坏”或“无法验证开发者”，请先将 App 拖到“应用程序”，再执行：
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/小文喵.app
> ```
>
> - 如果仍被拦截，也可以在 Finder 中右键应用，选择“打开”。

## 本地开发

### 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 20.19+ 或 22.12+ | 推荐使用 nvm 管理 |
| pnpm | 最新版 | `npm install -g pnpm` |
| Rust | 1.70+ | [rustup.rs](https://rustup.rs) |
| FFmpeg | 最新版 | 需放到 `src-tauri/binaries/` |

### macOS

```bash
# 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 克隆项目
git clone https://github.com/220529/file-toolkit.git
cd file-toolkit
pnpm install

# 下载 FFmpeg 到 binaries 目录
mkdir -p src-tauri/binaries
curl -L "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" -o /tmp/ffmpeg.zip
curl -L "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o /tmp/ffprobe.zip
unzip -o /tmp/ffmpeg.zip -d /tmp/
unzip -o /tmp/ffprobe.zip -d /tmp/

# 根据你的 Mac 类型选择（二选一）
# Intel Mac:
cp /tmp/ffmpeg src-tauri/binaries/ffmpeg-x86_64-apple-darwin
cp /tmp/ffprobe src-tauri/binaries/ffprobe-x86_64-apple-darwin

# Apple Silicon Mac:
cp /tmp/ffmpeg src-tauri/binaries/ffmpeg-aarch64-apple-darwin
cp /tmp/ffprobe src-tauri/binaries/ffprobe-aarch64-apple-darwin

chmod +x src-tauri/binaries/*

# 启动开发
pnpm tauri dev

# 完整验证
pnpm run verify
```

### Windows

Windows 需要额外安装 MSVC 编译工具链：

```powershell
# 1. 安装 Rust
winget install Rustlang.Rustup

# 2. 安装 Visual Studio Build Tools（必须，约 2-3GB）
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 3. 重启终端，确认 cargo 可用
cargo -V

# 4. 克隆项目
git clone https://github.com/220529/file-toolkit.git
cd file-toolkit
pnpm install

# 5. 下载 FFmpeg 到 binaries 目录
# 从 https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip 下载
# 解压后将 bin/ffmpeg.exe 和 bin/ffprobe.exe 复制到 src-tauri/binaries/
# 并重命名为：
#   - ffmpeg-x86_64-pc-windows-msvc.exe
#   - ffprobe-x86_64-pc-windows-msvc.exe

# 6. 启动开发
pnpm tauri dev

# 7. 完整验证
pnpm run verify
```

> ⚠️ 如果 `cargo` 命令找不到，需要将 `%USERPROFILE%\.cargo\bin` 添加到系统 PATH

### Linux

参考 macOS 步骤，额外安装依赖：`sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

## 打包

```bash
# 发布前本地检查
pnpm run verify

# 确保 FFmpeg 已下载到 src-tauri/binaries/
pnpm tauri build
```

> 打包会读取本机 Tauri/Rust 环境和 `src-tauri/binaries/` 下的 FFmpeg 二进制。Agent 不得自动下载 FFmpeg、签名、notarize、上传安装包或执行发布流程，除非用户明确确认。

## 文生图配置

文生图默认读取本机 Codex 配置作为初始服务地址和 Key 来源：

- 默认配置目录优先级：`CODEX_HOME`、`~/.codex`、`~/.codex-erp`
- App 内的 Base URL 和 API Key 可以临时覆盖默认配置
- Base URL 会自动补齐为 `/v1/images/generations`
- “测试连接”会检查模型列表、所选图片模型和图片生成权限

如果测试返回 `Image generation is not enabled for this group`，说明当前 Key 或中转分组尚未开通图片生成权限。

## 发布新版本

```bash
./tag.sh  # 选择版本号，自动推送 tag，GitHub Actions 自动打包发布
```

`tag.sh` 会创建/删除 tag、push 远程并触发 GitHub Actions。Agent 不得自动执行该脚本、创建 release、上传安装包、签名或更改远程仓库。

## 工作区状态与边界

- catalog 状态：`indexed` product candidate，尚未 adopted。
- 项目级 `.npmrc` 将 npm cache、pnpm store 和 pnpm state 指向 `/private/tmp`，并关闭 pnpm 自管理版本切换。
- 文生图功能可以读取本机 Codex 配置来判断默认 Base URL 和 Key 来源，但不得把真实 API key、Codex 配置内容、生成历史或本地路径写入 README、日志、catalog 或测试快照。
- `node_modules/`、`dist/`、`tmp/`、`src-tauri/target/`、`src-tauri/binaries/`、安装包、本地生成图片和 `.DS_Store` 都是生成物或运行态文件，不进入资产索引。
- 发布前仍需确认 FFmpeg 二进制来源、许可证/再分发边界、macOS 签名/notarization、Windows 安装包签名、更新/回滚策略和用户文件隐私边界。

## License

MIT
