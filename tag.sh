#!/bin/bash

# 获取最新 tag
LATEST=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
echo "📌 当前版本: $LATEST"

# 解析版本号
VERSION=${LATEST#v}
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 计算新版本
NEW_PATCH="v$MAJOR.$MINOR.$((PATCH + 1))"
NEW_MINOR="v$MAJOR.$((MINOR + 1)).0"
NEW_MAJOR="v$((MAJOR + 1)).0.0"

echo ""
echo "选择操作:"
echo "  1) 补丁版本 $NEW_PATCH (bug修复)"
echo "  2) 次版本   $NEW_MINOR (新功能)"
echo "  3) 主版本   $NEW_MAJOR (重大更新)"
echo "  4) 自定义版本"
echo "  5) 🔄 重新发布 $LATEST (覆盖当前版本)"
echo ""
read -p "请选择 [1-5]: " CHOICE

FORCE_RELEASE=false

case $CHOICE in
  1) NEW_VERSION=$NEW_PATCH ;;
  2) NEW_VERSION=$NEW_MINOR ;;
  3) NEW_VERSION=$NEW_MAJOR ;;
  4) read -p "输入版本号 (如 v1.0.0): " NEW_VERSION ;;
  5) NEW_VERSION=$LATEST; FORCE_RELEASE=true ;;
  *) echo "❌ 无效选择"; exit 1 ;;
esac

# 去掉 v 前缀用于配置文件
VERSION_NUM=${NEW_VERSION#v}

echo ""
if [ "$FORCE_RELEASE" = true ]; then
  echo "🔄 重新发布版本: $NEW_VERSION"
  echo "⚠️  这将删除远程 tag 并重新创建，触发新的构建"
else
  echo "🏷️  发布版本: $NEW_VERSION"
fi

read -p "确认? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "❌ 已取消"
  exit 0
fi

# 更新 tauri.conf.json 版本号
echo "📝 更新 tauri.conf.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION_NUM\"/" src-tauri/tauri.conf.json

# 更新 package.json 版本号
echo "📝 更新 package.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION_NUM\"/" package.json

# 更新 Cargo.toml 版本号
echo "📝 更新 Cargo.toml..."
sed -i '' "0,/^version = \"[^\"]*\"/s//version = \"$VERSION_NUM\"/" src-tauri/Cargo.toml

# 同步 Cargo.lock 中的本地包版本
echo "📝 更新 Cargo.lock..."
cargo check --manifest-path src-tauri/Cargo.toml >/dev/null

# 检查是否有变更需要提交
if ! git diff --quiet src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock; then
  git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock
  git commit -m "chore: bump version to $NEW_VERSION"
fi

# 重新发布：删除旧 tag
if [ "$FORCE_RELEASE" = true ]; then
  echo "🗑️  删除旧 tag..."
  git tag -d "$NEW_VERSION" 2>/dev/null
  git push origin --delete "$NEW_VERSION" 2>/dev/null
fi

# 创建并推送
git tag "$NEW_VERSION"
git push origin master --tags

echo ""
echo "✅ 完成！GitHub Actions 将自动打包"
echo "📦 查看进度: https://github.com/220529/file-toolkit/actions"
