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
echo "  4) 覆盖当前 $LATEST"
echo "  5) 自定义版本"
echo ""
read -p "请选择 [1-5]: " CHOICE

case $CHOICE in
  1) NEW_VERSION=$NEW_PATCH ;;
  2) NEW_VERSION=$NEW_MINOR ;;
  3) NEW_VERSION=$NEW_MAJOR ;;
  4) NEW_VERSION=$LATEST ;;
  5) read -p "输入版本号 (如 v1.0.0): " NEW_VERSION ;;
  *) echo "❌ 无效选择"; exit 1 ;;
esac

echo ""
echo "🏷️  发布版本: $NEW_VERSION"
read -p "确认? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "❌ 已取消"
  exit 0
fi

# 删除旧 tag（如果覆盖）
if [ "$NEW_VERSION" = "$LATEST" ]; then
  git tag -d "$NEW_VERSION" 2>/dev/null
  git push origin ":$NEW_VERSION" 2>/dev/null
fi

# 创建并推送
git tag "$NEW_VERSION"
git push origin "$NEW_VERSION"

echo ""
echo "✅ 完成！GitHub Actions 将自动打包"
echo "📦 查看进度: https://github.com/220529/file-toolkit/actions"
