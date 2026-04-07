# 小文喵 (File Toolkit)

<p align="center">
  <img src="icon.png" width="128" alt="小文喵">
</p>

<p align="center">
  <b>跨平台文件工具箱</b> —— 文件统计、去重、视频截取、格式转换、去水印
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
| 🔍 文件去重 | xxHash3 快速哈希，并行计算，缩略图预览 |
| ✂️ 视频截取 | 快速模式（无损）/ 精确模式，时间轴预览 |
| 🔄 格式转换 | 批量转换 MOV/MP4/GIF，支持画质选择 |
| ✨ 去水印 | 高斯模糊 / 颜色覆盖，支持取色器 |

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
```

> ⚠️ 如果 `cargo` 命令找不到，需要将 `%USERPROFILE%\.cargo\bin` 添加到系统 PATH

### Linux

参考 macOS 步骤，额外安装依赖：`sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

## 打包

```bash
# 确保 FFmpeg 已下载到 src-tauri/binaries/
pnpm tauri build
```

## 发布新版本

```bash
./tag.sh  # 选择版本号，自动推送 tag，GitHub Actions 自动打包发布
```

## License

MIT
