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
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 📊 文件统计 | 递归扫描文件夹，按类型统计数量和大小 |
| 🔍 文件去重 | xxHash3 快速哈希，并行计算，缩略图预览，智能选择 |
| ✂️ 视频截取 | 快速模式（无损）/ 精确模式（重编码），时间轴预览 |
| 🔄 格式转换 | 批量转换 MOV/MP4/GIF，支持画质选择（高/中/低） |
| ✨ 去水印 | 高斯模糊 / 颜色覆盖，支持取色器，一键去除 |

## 📖 背景故事

整理电脑文件时发现大量重复的照片和视频，占了几十 GB。市面上的去重工具要么收费，要么功能臃肿，于是决定自己做一个。

做着做着，需求就多了：

- 有时候只想要视频的一小段，不想装 PR → **视频截取**
- iPhone 录的 MOV 想转 MP4，有些视频想转 GIF → **格式转换**
- 想给应用换个图标，用豆包 AI 生成了一张，结果有水印。去网上搜"去水印"，要么收费要么要注册 → **去水印**

于是就有了「小文喵」。

## 📦 下载安装

### 方式一：直接下载（推荐）

前往 [Releases](https://github.com/220529/file-toolkit/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| macOS (Intel) | `小文喵_x.x.x_x64.dmg` |
| macOS (Apple Silicon) | `小文喵_x.x.x_aarch64.dmg` |
| Windows | `小文喵_x.x.x_x64-setup.exe` |
| Linux | `小文喵_x.x.x_amd64.deb` |

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
git clone https://github.com/220529/file-toolkit.git
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

打包时需要将 FFmpeg 内嵌到应用中：

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
curl -L "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" -o /tmp/ffmpeg.tar.xz
tar -xf /tmp/ffmpeg.tar.xz -C /tmp/
cp /tmp/ffmpeg-*-amd64-static/ffmpeg src-tauri/binaries/ffmpeg-x86_64-unknown-linux-gnu
cp /tmp/ffmpeg-*-amd64-static/ffprobe src-tauri/binaries/ffprobe-x86_64-unknown-linux-gnu
chmod +x src-tauri/binaries/*
```
</details>

### 2. 安装 DMG 打包工具（macOS）

```bash
brew install create-dmg
```

### 3. 执行打包

```bash
pnpm tauri build
```

### 4. 获取产物

| 平台 | 产物位置 |
|------|----------|
| macOS | `src-tauri/target/release/bundle/dmg/小文喵_x.x.x_x64.dmg` |
| Windows | `src-tauri/target/release/bundle/msi/小文喵_x.x.x_x64.msi` |
| Linux | `src-tauri/target/release/bundle/deb/小文喵_x.x.x_amd64.deb` |

---

## 🐛 踩坑记录

### 1. macOS 图标白底问题

macOS Big Sur 开始，所有 App 图标强制使用 squircle（圆角方形）形状。如果图标有透明背景，系统会自动加白底。

**解决方案**：图标设计时直接使用带背景色的 squircle 形状，不要用透明背景。

### 2. DMG 打包失败

报错：`failed to run bundle_dmg.sh`

**原因**：缺少 `create-dmg` 工具。

**解决方案**：
```bash
brew install create-dmg
```

### 3. FFmpeg 滤镜语法

高斯模糊需要用 `-filter_complex` 而不是 `-vf`：

```bash
# 错误 ❌
ffmpeg -i input.jpg -vf "split[a][b];[b]boxblur=20[blur];[a][blur]overlay" output.jpg

# 正确 ✅
ffmpeg -i input.jpg -filter_complex "[0:v]crop=100:30:0:0,boxblur=15:3[blur];[0:v][blur]overlay=0:0" output.jpg
```

### 4. 颜色格式转换

FFmpeg 的 `drawbox` 滤镜不认 `#ffffff` 格式，需要转成 `0xffffff`：

```rust
let ffmpeg_color = if color.starts_with('#') {
    format!("0x{}", &color[1..])
} else {
    color.clone()
};
```

### 5. Dev 模式 Dock 显示英文名

开发模式下 macOS Dock 显示的是 Cargo 包名（英文），这是正常的。打包后会显示 `tauri.conf.json` 中配置的中文名。

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
│  ┌──────────┬────────┬────────┬─────────┬────────┐ │
│  │file_stats│ dedup  │ video  │ convert │watermark│ │
│  │ walkdir  │xxHash3 │ FFmpeg │ FFmpeg  │ FFmpeg  │ │
│  │          │ rayon  │        │         │         │ │
│  └──────────┴────────┴────────┴─────────┴────────┘ │
└─────────────────────────────────────────────────────┘
```

---

## 📄 License

MIT © 2024
