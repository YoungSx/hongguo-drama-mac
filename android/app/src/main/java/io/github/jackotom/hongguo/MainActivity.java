package io.github.jackotom.hongguo;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.system.Os;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * 外壳：在 nodejs-mobile 里跑未改动的 main.js，用 WebView 显示同一份 dist-react。
 * 两者通过本机 HTTP 桥（127.0.0.1:47860）通信，见 android/shim/electron.js。
 */
public class MainActivity extends Activity {
  private static final String TAG = "HongguoAndroid";
  private static final String BRIDGE_HOST = "127.0.0.1";
  private static final int BRIDGE_PORT = 47860;
  private static final String PROJECT_DIR = "nodejs-project";
  private static final String VERSION_MARKER = ".nodejs-project-version";

  // 进程级：Activity 重建（进程还活着）时不能起第二个 Node，否则两个实例抢同一个端口和数据文件。
  private static boolean nodeStarted = false;

  private WebView webView;

  static {
    System.loadLibrary("node");
    System.loadLibrary("native-lib");
  }

  public static native int startNodeWithArguments(String[] arguments, String modulesPath, boolean redirectOutput);

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);

    final File projectDir = new File(getFilesDir(), PROJECT_DIR);
    try {
      syncProjectAssets(projectDir);
    } catch (IOException error) {
      Log.e(TAG, "内置脚本解压失败", error);
    }

    File downloads = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
    if (downloads == null) downloads = new File(getFilesDir(), "downloads");
    setEnv("TMPDIR", getCacheDir().getAbsolutePath());
    setEnv("HONGGUO_DATA_DIR", getFilesDir().getAbsolutePath());
    setEnv("HONGGUO_DOWNLOADS", downloads.getAbsolutePath());
    setEnv("HONGGUO_APP_VERSION", versionName());
    setEnv("HONGGUO_PORT", String.valueOf(BRIDGE_PORT));

    if (!nodeStarted) {
      nodeStarted = true;
      final String mainScript = new File(projectDir, "main.js").getAbsolutePath();
      final String modulesPath = new File(projectDir, "node_modules").getAbsolutePath();
      new Thread(new Runnable() {
        @Override
        public void run() {
          startNodeWithArguments(new String[]{"node", mainScript}, modulesPath, true);
        }
      }, "nodejs-mobile").start();
    }

    webView = new WebView(this);
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    webView.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (BRIDGE_HOST.equals(uri.getHost())) return false;
        openExternal(uri.toString());
        return true;
      }
    });
    webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
    setContentView(webView, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    // 等桥起来再加载：WebView 早于 Node 就绪时直接 loadUrl 会拿到连接失败页。
    new Thread(new Runnable() {
      @Override
      public void run() {
        if (!waitForBridge()) Log.e(TAG, "本地服务未就绪，仍尝试加载");
        final String url = "http://" + BRIDGE_HOST + ":" + BRIDGE_PORT + "/";
        runOnUiThread(new Runnable() {
          @Override
          public void run() {
            webView.loadUrl(url);
          }
        });
      }
    }, "bridge-wait").start();
  }

  @Override
  public void onBackPressed() {
    if (webView != null && webView.canGoBack()) webView.goBack();
    else super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    if (webView != null) {
      webView.removeJavascriptInterface("AndroidBridge");
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }

  /** 供 bridge.js 调用：打开外部链接（来源页面走系统浏览器）。 */
  private final class Bridge {
    @JavascriptInterface
    public void openExternal(String url) {
      MainActivity.this.openExternal(url);
    }
  }

  private void openExternal(String url) {
    if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    } catch (Exception error) {
      Log.w(TAG, "无法打开链接: " + url);
    }
  }

  private boolean waitForBridge() {
    for (int attempt = 0; attempt < 300; attempt++) {
      Socket socket = new Socket();
      try {
        socket.connect(new InetSocketAddress(BRIDGE_HOST, BRIDGE_PORT), 200);
        return true;
      } catch (IOException retry) {
        SystemClock.sleep(100);
      } finally {
        try { socket.close(); } catch (IOException ignored) {}
      }
    }
    return false;
  }

  /** assets 里的 nodejs-project 解压到 filesDir；版本号变了才重新解压。 */
  private void syncProjectAssets(File projectDir) throws IOException {
    String expected = versionName();
    File marker = new File(projectDir, VERSION_MARKER);
    if (marker.isFile() && expected.equals(readText(marker))) return;
    deleteRecursively(projectDir);
    copyAsset(PROJECT_DIR, projectDir);
    writeText(marker, expected);
  }

  private void copyAsset(String assetPath, File target) throws IOException {
    String[] children = getAssets().list(assetPath);
    if (children == null || children.length == 0) {
      File parent = target.getParentFile();
      if (parent != null) parent.mkdirs();
      InputStream in = getAssets().open(assetPath);
      try {
        OutputStream out = new FileOutputStream(target);
        try {
          byte[] buffer = new byte[65536];
          for (int read = in.read(buffer); read > 0; read = in.read(buffer)) {
            out.write(buffer, 0, read);
          }
        } finally {
          out.close();
        }
      } finally {
        in.close();
      }
      return;
    }
    target.mkdirs();
    for (String child : children) copyAsset(assetPath + "/" + child, new File(target, child));
  }

  private static void deleteRecursively(File file) {
    if (!file.exists()) return;
    File[] children = file.listFiles();
    if (children != null) for (File child : children) deleteRecursively(child);
    file.delete();
  }

  private static String readText(File file) {
    try {
      byte[] data = new byte[(int) file.length()];
      InputStream in = new java.io.FileInputStream(file);
      try {
        int offset = 0;
        while (offset < data.length) {
          int read = in.read(data, offset, data.length - offset);
          if (read <= 0) break;
          offset += read;
        }
        return new String(data, 0, offset, "UTF-8").trim();
      } finally {
        in.close();
      }
    } catch (IOException error) {
      return "";
    }
  }

  private static void writeText(File file, String text) {
    try {
      OutputStream out = new FileOutputStream(file);
      try {
        out.write(text.getBytes("UTF-8"));
      } finally {
        out.close();
      }
    } catch (IOException error) {
      Log.w(TAG, "写入标记失败: " + file.getName());
    }
  }

  private String versionName() {
    try {
      return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
    } catch (Exception error) {
      return "0";
    }
  }

  private static void setEnv(String name, String value) {
    try {
      Os.setenv(name, value, true);
    } catch (Exception error) {
      Log.w(TAG, "setenv 失败: " + name);
    }
  }
}
