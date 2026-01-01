# File Toolkit

<p align="center">
  <img src="public/tauri.svg" width="80" alt="File Toolkit">
</p>

<p align="center">
  跨平台文件工具箱 - 文件统计、去重、视频截取
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.0-blue" alt="Tauri">
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="React">
  <img src="https://img.shields.io/badge/Rust-1.70+-orange" alt="Rust">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 📊 文件统计 | 递归扫描文件夹，按类型统计数量和大小 |
| 🔍 文件去重 | xxHash3 快速哈希，并行计算，缩略图预览，智能选择 |
| ✂️ 视频截取 | 快速模式（无损）/ 精确模式（重编码），时间轴预览 |

## 📦 下载安装

### 方式一：直接下载（推荐）

前往 [Releases](https://github.com/yourname/file-toolkit/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| macOS | `File Toolkit.dmg` |
| Windows | `File Toolkit.msi` |
| Linux | `File Toolkit.deb` |

> 安装包已内嵌 FFmpeg，下载即用，无需额外安装。

### 方式二：从源码构建

见下方「开发指南」。

---

## 🛠 开发指南

### 环境要求

| 依赖 | 版本 | 安装方式 |
|------|------|----------|
| Node.js | 20.19+ 或 22.12+ | [nvm](https://github.com/nvm-sh/nvm) |
| pnpm | 8+ | `npm install -g pnpm` |
| Rust | 1.70+ | [rustup](https://rustup.rs/) |
| FFmpeg | 5+ | 见下方说明 |

### 1. 克隆项目

```bash
git clone https://github.com/yourname/file-toolkit.git
cd file-toolkit
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 安装 FFmpeg（开发模式需要）

开发模式下，应用会使用系统的 FFmpeg：

```bash
# macOS
brew install ffmpeg

# Windows (Chocolatey)
choco install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# 验证安装
ffmpeg -version
```

### 4. 启动开发服务

```bash
pnpm tauri dev
```

首次启动会编译 Rust 代码，需要几分钟。之后热更新很快。

---

## 📦 打包发布

### 1. 下载 FFmpeg 静态版本

打包时需要将 FFmpeg 内嵌到应用中，需要下载静态编译版本：

<details>
<summary><b>macOS (Intel x86_64)</b></summary>

```bash
mkdir -p src-tauri/binaries
curl -L "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" -o /tmp/ffmpeg.zip
curl -L "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o /tmp/ffprobe.zip
unzip -o /tmp/ffmpeg.zip -d src-tauri/binaries/
unzip -o /tmp/ffprobe.zip -d src-tauri/binaries/
mv src-tauri/binaries/ffmpeg src-tauri/binaries/ffmpeg-x86_64-apple-darwin
mv src-tauri/binaries/ffprobe src-tauri/binaries/ffprobe-x86_64-apple-darwin
chmod +x src-tauri/binaries/*
```
</details>

<details>
<summary><b>macOS (Apple Silicon arm64)</b></summary>

```bash
mkdir -p src-tauri/binaries
curl -L "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" -o /tmp/ffmpeg.zip
curl -L "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o /tmp/ffprobe.zip
unzip -o /tmp/ffmpeg.zip -d src-tauri/binaries/
unzip -o /tmp/ffprobe.zip -d src-tauri/binaries/
mv src-tauri/binaries/ffmpeg src-tauri/binaries/ffmpeg-aarch64-apple-darwin
mv src-tauri/binaries/ffprobe src-tauri/binaries/ffprobe-aarch64-apple-darwin
chmod +x src-tauri/binaries/*
```
</details>

<details>
<summary><b>Windows</b></summary>

1. 下载 [FFmpeg Windows 版本](https://www.gyan.dev/ffmpeg/builds/)（选择 release-essentials）
2. 解压后将 `ffmpeg.exe` 和 `ffprobe.exe` 复制到 `src-tauri/binaries/`
3. 重命名为：
   - `ffmpeg-x86_64-pc-windows-msvc.exe`
   - `ffprobe-x86_64-pc-windows-msvc.exe`
</details>

<details>
<summary><b>Linux</b></summary>

```bash
mkdir -p src-tauri/binaries
# 下载静态编译版本
curl -L "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" -o /tmp/ffmpeg.tar.xz
tar -xf /tmp/ffmpeg.tar.xz -C /tmp/
cp /tmp/ffmpeg-*-amd64-static/ffmpeg src-tauri/binaries/ffmpeg-x86_64-unknown-linux-gnu
cp /tmp/ffmpeg-*-amd64-static/ffprobe src-tauri/binaries/ffprobe-x86_64-unknown-linux-gnu
chmod +x src-tauri/binaries/*
```
</details>

### 2. 执行打包

```bash
pnpm tauri build
```

### 3. 获取产物

| 平台 | 产物位置 |
|------|----------|
| macOS | `src-tauri/target/release/bundle/macos/File Toolkit.app` |
| macOS DMG | `src-tauri/target/release/bundle/dmg/File Toolkit_x.x.x_x64.dmg` |
| Windows | `src-tauri/target/release/bundle/msi/File Toolkit_x.x.x_x64.msi` |
| Linux | `src-tauri/target/release/bundle/deb/file-toolkit_x.x.x_amd64.deb` |

> 如果 DMG 打包失败，可以手动创建：
> ```bash
> hdiutil create -volname "File Toolkit" -srcfolder "src-tauri/target/release/bundle/macos/File Toolkit.app" -ov -format UDZO "File Toolkit.dmg"
> ```

---

## 🏗 技术架构

```
┌─────────────────────────────────────────────────────┐
│                    Frontend                          │
│         React 19 + TypeScript + Tailwind CSS        │
├─────────────────────────────────────────────────────┤
│                   Tauri IPC                          │
├─────────────────────────────────────────────────────┤
│                    Backend                           │
│                  Rust + Tauri 2.0                   │
│  ┌─────────────┬─────────────┬─────────────────┐   │
│  │ file_stats  │    dedup    │     video       │   │
│  │  walkdir    │  xxHash3    │    FFmpeg       │   │
│  │             │  rayon      │                 │   │
│  │             │  memmap2    │                 │   │
│  └─────────────┴─────────────┴─────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 性能优化

- **xxHash3**：比 MD5 快 5-10 倍
- **rayon**：并行计算，充分利用多核 CPU
- **memmap2**：内存映射，零拷贝读取
- **大文件采样**：只读头部 + 中间 + 尾部，避免全量读取

---

## 📁 项目结构

```
file-toolkit/
├── src/                        # 前端代码
│   ├── components/             # 通用组件
│   │   └── DropZone.tsx        # 拖拽选择组件
│   ├── pages/                  # 页面组件
│   │   ├── FileStats.tsx       # 文件统计
│   │   ├── Dedup.tsx           # 文件去重
│   │   └── VideoCut.tsx        # 视频截取
│   ├── utils/                  # 工具函数
│   ├── App.tsx                 # 主应用
│   └── index.css               # 全局样式
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── commands/           # Tauri 命令
│   │   │   ├── file_stats.rs   # 文件统计
│   │   │   ├── dedup.rs        # 文件去重
│   │   │   └── video.rs        # 视频处理
│   │   └── lib.rs              # 入口
│   ├── binaries/               # FFmpeg（打包用，gitignore）
│   ├── Cargo.toml              # Rust 依赖
│   └── tauri.conf.json         # Tauri 配置
├── docs/                       # 文档
└── package.json
```

---

## 📄 License

MIT © 2024
