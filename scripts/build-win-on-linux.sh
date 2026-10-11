#!/usr/bin/env bash
#
# 在 Linux 上打 Windows NSIS 安装包（复用系统 makensis，不装 Wine 里的 NSIS）。
# 记录这里的每一步，避免每次重新摸索 electron-builder 在 Linux 上的两个坑。
#
# 坑 1：electron-builder 在非 win32 平台默认调用 wine 里的 makensis；装了系统 makensis 时
#       用 USE_SYSTEM_WINE=true 让它走宿主命令。
# 坑 2：NsisTarget 里判断 "macOS Catalina" 的分支在 Linux 上也会命中，导致去执行只该在
#       Catalina 上跑的逻辑（wine 卸载器生成）；补一个 linux 分支，让它和 Catalina 一样
#       直接走 UninstallerReader。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NSIS_TARGET="node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js"
if [ -f "$NSIS_TARGET" ] && ! grep -q 'process.platform === "linux"' "$NSIS_TARGET"; then
  echo "[patch] NsisTarget.js: 让 Linux 走 UninstallerReader"
  sed -i 's/if ((0, macosVersion_1.isMacOsCatalina)()) {/if ((0, macosVersion_1.isMacOsCatalina)() || process.platform === "linux") {/' "$NSIS_TARGET"
fi

ICONS_TOOLSET="${ELECTRON_BUILDER_ICONS_TOOLSET_DIR:-/tmp/eb-icons-toolset}"
[ -d "$ICONS_TOOLSET" ] || echo "警告: 图标工具集不存在 ($ICONS_TOOLSET)，electron-builder 可能会尝试联网下载"

USE_SYSTEM_WINE=true \
ELECTRON_BUILDER_ICONS_TOOLSET_DIR="$ICONS_TOOLSET" \
npx electron-builder --win nsis --x64 --publish never

ls -lh dist/*.exe | awk '{print "安装包: "$9" ("$5")"}'
