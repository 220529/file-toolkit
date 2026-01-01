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

## 本地开发

```bash
# 环境要求：Node.js 20.19+、pnpm、Rust 1.70+、FFmpeg

git clone https://github.com/220529/file-toolkit.git
cd file-toolkit
pnpm install
pnpm tauri dev
```

## 打包

```bash
# macOS 需要先安装
brew install create-dmg

# 下载 FFmpeg 到 src-tauri/binaries/（见 GitHub Actions 配置）
pnpm tauri build
```

## 发布新版本

```bash
./tag.sh  # 选择版本号，自动推送 tag，GitHub Actions 自动打包发布
```

## License

MIT
