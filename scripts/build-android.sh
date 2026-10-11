#!/usr/bin/env bash
#
# 打 Android(arm64-v8a) APK：nodejs-mobile 里跑未改动的 main.js，WebView 显示同一份 dist-react。
# 不依赖 Gradle / Android Studio；只需要 platform 的 android.jar + NDK + 打包工具。
#
# 依赖（可用环境变量覆盖）：
#   ANDROID_SDK          默认 /tmp/android-sdk（需含 platforms/android-24/android.jar）
#                        用 sdkmanager "platforms;android-24" 装
#   ANDROID_NDK          默认 $ANDROID_SDK/ndk/27.2.12479018
#   HONGGUO_NODEJS_MOBILE_DIR 已解压的 nodejs-mobile（含 include/node 与 bin/arm64-v8a/libnode.so）
#
# 打包工具用系统的 aapt/zipalign/apksigner（Ubuntu 有 arm64 原生包：
#   sudo apt-get install -y aapt zipalign apksigner）。
# 不用 SDK 的 build-tools：aapt2/zipalign 是 x86_64 二进制，在 arm64 宿主上跑不起来
# （arm64 的 aapt2 只有 Android Studio 自带）。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ANDROID_SDK:-/tmp/android-sdk}"
NDK="${ANDROID_NDK:-$SDK/ndk/27.2.12479018}"
# -I 用 minSdk 那一档的 platform：apt 的 aapt v1 太老，解析不了 android-35 的 resources.arsc
# （报 "No resource identifier found for attribute 'versionCode'"）。targetSdk 仍写 35。
PLATFORM="${ANDROID_PLATFORM_JAR:-$SDK/platforms/android-24/android.jar}"
LLVM_PREBUILT="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
SYSROOT="$LLVM_PREBUILT/sysroot"
# 用宿主 clang 交叉编译，但借用 NDK 的 clang 资源目录（compiler-rt builtins + libc++ 头），
# 否则宿主 clang 会去找不存在的 -lgcc。NDK 自带的 clang 是 x86_64 二进制，在 arm64 宿主上跑不了。
CLANG_RESOURCE_DIR="$(ls -d "$LLVM_PREBUILT"/lib/clang/*/ | head -1)"
NODEJS_MOBILE_VERSION="${NODEJS_MOBILE_VERSION:-18.20.4}"
API=24
ABI=arm64-v8a

AAPT="${AAPT:-aapt}"
ZIPALIGN="${ZIPALIGN:-zipalign}"
APKSIGNER="${APKSIGNER:-apksigner}"

WORK="$ROOT/android/build"
STAGE="$WORK/nodejs-project"
ASSETS="$WORK/assets"
APKROOT="$WORK/apkroot"
CACHE="${HONGGUO_ANDROID_CACHE:-/tmp/hongguo-android-cache}"
KEYSTORE="${HONGGUO_KEYSTORE:-$ROOT/android/keystore/hongguo-debug.keystore}"

VERSION="$(node -p "require('$ROOT/package.json').version")"
VERSION_CODE="$(node -p "const v=require('$ROOT/package.json').version.split('.').map(Number); v[0]*10000+v[1]*100+v[2]")"
PRODUCT="$(node -p "require('$ROOT/package.json').build.productName || 'app'")"
OUT_APK="$ROOT/dist/${PRODUCT}-${VERSION}-android-${ABI}.apk"

for tool in "$AAPT" "$ZIPALIGN" "$APKSIGNER" javac keytool zip; do
  command -v "$tool" >/dev/null || { echo "缺少工具: $tool" >&2; exit 1; }
done
[ -f "$PLATFORM" ] || { echo "缺少 platform: $PLATFORM" >&2; exit 1; }
[ -d "$SYSROOT" ] || { echo "缺少 NDK sysroot: $SYSROOT" >&2; exit 1; }

# ---- nodejs-mobile（头文件 + libnode.so）----
NODE_DIR="${HONGGUO_NODEJS_MOBILE_DIR:-$CACHE/nodejs-mobile}"
if [ ! -f "$NODE_DIR/include/node/node.h" ] || [ ! -f "$NODE_DIR/bin/$ABI/libnode.so" ]; then
  echo "[1/8] 下载 nodejs-mobile $NODEJS_MOBILE_VERSION"
  mkdir -p "$NODE_DIR"
  curl -fsSL -o "$CACHE/nodejs-mobile.tgz" \
    "https://registry.npmjs.org/nodejs-mobile-react-native/-/nodejs-mobile-react-native-${NODEJS_MOBILE_VERSION}.tgz"
  # 只取 android 那份预编译 libnode。头文件和 bin/<abi>/libnode.so 都在 package/android/libnode 下，
  # 剥掉这三层正好是 NODE_DIR 该有的布局（整包 100MB，iOS / React-Native 那部分用不上）。
  tar -xzf "$CACHE/nodejs-mobile.tgz" -C "$NODE_DIR" --strip-components=3 package/android/libnode
fi
[ -f "$NODE_DIR/include/node/node.h" ] && [ -f "$NODE_DIR/bin/$ABI/libnode.so" ] \
  || { echo "nodejs-mobile 不完整（缺 include/node 或 bin/$ABI/libnode.so）: $NODE_DIR" >&2; exit 1; }

# ---- 渲染层 ----
echo "[2/8] 构建渲染层"
(cd "$ROOT" && npm run build:react >/dev/null)

# ---- 组装 nodejs-project（Node 端代码 + Electron 兼容层）----
echo "[3/8] 组装 nodejs-project"
rm -rf "$STAGE" "$ASSETS" "$APKROOT"
mkdir -p "$STAGE/node_modules/electron" "$ASSETS"
cp "$ROOT/main.js" "$ROOT/preload.js" "$STAGE/"
cp -r "$ROOT/src" "$ROOT/dist-react" "$STAGE/"
node "$ROOT/android/scripts/collect-modules.js" "$ROOT" "$STAGE/node_modules" axios
cp "$ROOT/android/shim/electron.js" "$STAGE/node_modules/electron/index.js"
cp "$ROOT/android/shim/bridge.js" "$STAGE/node_modules/electron/bridge.js"
printf '{"name":"electron","version":"0.0.0","main":"index.js"}\n' > "$STAGE/node_modules/electron/package.json"

# 可选：放 build/ffmpeg/android-arm64/{ffmpeg,ffprobe}（aarch64-linux-android 静态构建）就一起打包，
# main.js 的 resolveFfmpeg 正好找这个目录。没有就跳过：合并/转码会按既有逻辑返回
# 「未找到完整 FFmpeg」，下载等其余功能不受影响。二进制不入库（见 .gitignore）。
if [ -d "$ROOT/build/ffmpeg/android-arm64" ]; then
  echo "  附带 ffmpeg: build/ffmpeg/android-arm64"
  mkdir -p "$STAGE/build/ffmpeg"
  cp -r "$ROOT/build/ffmpeg/android-arm64" "$STAGE/build/ffmpeg/"
fi

cp -r "$STAGE" "$ASSETS/nodejs-project"

# ---- 资源（图标 + 清单用到的 values/xml）----
echo "[4/8] 生成资源"
mkdir -p "$WORK/res"
cp -r "$ROOT/android/app/src/main/res/." "$WORK/res/"
for entry in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  density="${entry%%:*}"; size="${entry##*:}"
  mkdir -p "$WORK/res/mipmap-$density"
  ffmpeg -y -loglevel error -i "$ROOT/build/icon.png" -vf "scale=$size:$size" "$WORK/res/mipmap-$density/ic_launcher.png"
done

# ---- 原生库 ----
echo "[5/8] 编译 native-lib"
mkdir -p "$WORK/jni/lib/$ABI" "$WORK/classes" "$WORK/dex"
clang++ --target="aarch64-linux-android$API" --sysroot="$SYSROOT" \
  -resource-dir="$CLANG_RESOURCE_DIR" -rtlib=compiler-rt \
  -shared -fPIC -O2 -std=c++17 -Wall \
  -I"$NODE_DIR/include/node" \
  "$ROOT/android/app/src/main/cpp/native-lib.cpp" \
  -o "$WORK/jni/lib/$ABI/libnative-lib.so" \
  -L"$NODE_DIR/bin/$ABI" -lnode -llog
cp "$NODE_DIR/bin/$ABI/libnode.so" "$WORK/jni/lib/$ABI/"
cp "$SYSROOT/usr/lib/aarch64-linux-android/libc++_shared.so" "$WORK/jni/lib/$ABI/"

# ---- Java ----
echo "[6/8] 编译 Java"
javac -encoding UTF-8 -source 8 -target 8 -nowarn -classpath "$PLATFORM" -d "$WORK/classes" \
  $(find "$ROOT/android/app/src/main/java" -name '*.java')
# d8 是 JVM 工具（java -jar），与宿主架构无关：优先 build-tools，缺失则用 apt 的 d8。
D8="${D8:-$SDK/build-tools/35.0.0/d8}"
command -v "$D8" >/dev/null || D8=d8
mkdir -p "$WORK/dex"
"$D8" --release --min-api "$API" --lib "$PLATFORM" --output "$WORK/dex" \
  $(find "$WORK/classes" -name '*.class')

# ---- 打包 ----
# 用 aapt v1（apt 的 arm64 原生包）：aapt2 只有 x86_64 二进制，在 arm64 宿主上跑不起来。
echo "[7/8] 打包 APK"
"$AAPT" package -f -M "$ROOT/android/app/AndroidManifest.xml" \
  -S "$WORK/res" -A "$ASSETS" -I "$PLATFORM" \
  --min-sdk-version "$API" --target-sdk-version 35 \
  --version-code "$VERSION_CODE" --version-name "$VERSION" \
  -F "$WORK/unsigned.apk"

mkdir -p "$APKROOT/lib/$ABI"
cp "$WORK/dex/classes.dex" "$APKROOT/"
cp "$WORK/jni/lib/$ABI/"*.so "$APKROOT/lib/$ABI/"
(cd "$APKROOT" && zip -q -X "$WORK/unsigned.apk" classes.dex "lib/$ABI/libnode.so" "lib/$ABI/libnative-lib.so" "lib/$ABI/libc++_shared.so")

"$ZIPALIGN" -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"

# ---- 签名 ----
echo "[8/8] 签名"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -alias hongguo -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass android -keypass android -dname "CN=Hongguo, OU=Android, O=Hongguo" >/dev/null
fi
mkdir -p "$ROOT/dist"
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --v1-signing-enabled true --v2-signing-enabled true --v4-signing-enabled false \
  --out "$OUT_APK" "$WORK/aligned.apk"
"$APKSIGNER" verify "$OUT_APK"

ls -lh "$OUT_APK" | awk '{print "APK: "$9" ("$5")"}'
