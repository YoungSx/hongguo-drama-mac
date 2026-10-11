'use strict';
/**
 * Android 端 Electron 兼容层（nodejs-mobile 里跑未改动的 main.js）。
 *
 * 只实现 main.js / preload.js 真正用到的 API；窗口、菜单、托盘等桌面概念在这里是无害空实现。
 * 渲染层由本机 HTTP 桥（127.0.0.1:PORT）供给：静态文件来自 dist-react，
 * IPC 走 POST /ipc，主进程事件走 SSE /events，
 * hongguo-stream:// 与 hongguo-local:// 媒体地址改写成同源 http 地址后交给 protocol.handle 的原始处理函数。
 *
 * ponytail: 只支持单实例、单窗口；够用即可，多窗口需求出现再说。
 * node:worker_threads（src/native/decrypt-worker.cjs，解密用）在 nodejs-mobile 上没在真机验证过；
 * 真不支持时 new Worker 抛错 -> Promise reject -> 上层报错，不会静默走错分支。
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const axios = require('axios');

const HOST = '127.0.0.1';
const PORT = Number(process.env.HONGGUO_PORT) || 47860;
const BRIDGE_SOURCE = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// ===== 目录（由 MainActivity 通过环境变量注入）=====
const dataDir = process.env.HONGGUO_DATA_DIR || path.join(os.homedir(), 'hongguo-data');
const downloadsDir = process.env.HONGGUO_DOWNLOADS || path.join(dataDir, 'downloads');
for (const dir of [dataDir, downloadsDir]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

// ===== app =====
const app = new EventEmitter();
app.commandLine = { appendSwitch() {}, appendArgument() {} };
app.whenReady = () => Promise.resolve();
app.getVersion = () => process.env.HONGGUO_APP_VERSION || '1.1.8';
app.getName = () => '红果短剧';
app.getPath = (name) => {
  if (name === 'userData') return dataDir;
  if (name === 'downloads') return downloadsDir;
  if (name === 'temp') return os.tmpdir();
  throw new Error(`Android 兼容层未实现 app.getPath('${name}')`);
};
app.quit = () => {};
app.exit = () => {};

// ===== ipcMain =====
// main.js 只用 ipcMain.handle（已核对）；不提供 on()，真用到时会立刻报错而不是静默失效。
const ipcHandlers = new Map();
const ipcMain = {
  handle: (channel, handler) => { ipcHandlers.set(channel, handler); },
  removeHandler: (channel) => { ipcHandlers.delete(channel); },
};

// ===== 其余桌面 API 空实现 =====
const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
const shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} };
const session = { defaultSession: { setProxy: async () => {} } };
const Menu = { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) };
class Notification { static isSupported() { return false; } show() {} }

// protocol.handle 的处理函数按 scheme 存下来，桥接请求时原样调用（main.js 逻辑零改动）。
const protocolHandlers = new Map();
const protocol = {
  registerSchemesAsPrivileged: () => {},
  handle: (scheme, handler) => { protocolHandlers.set(scheme, handler); },
};

// ===== 渲染层状态 =====
// 只服务一个窗口：谁调 loadFile，谁提供 dist-react 与 preload。
const state = { staticRoot: null, indexFile: null, preloadPath: null, renderer: null };

// ===== 主进程 -> 渲染层事件（SSE 广播）=====
const sseClients = new Set();
function publish(channel, payload) {
  const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
  for (const client of sseClients) {
    try { client.write(frame); } catch (_) { sseClients.delete(client); }
  }
}

// ===== BrowserWindow =====
class BrowserWindow {
  constructor(options = {}) {
    this.options = options;
    this._url = '';
    this._html = '';
    this._preloadPath = (options.webPreferences && options.webPreferences.preload) || null;
    this._listeners = [];
    this.webContents = {
      send: (channel, payload) => publish(channel, payload),
      executeJavaScript: (code) => this.executeJavaScript(code),
      setWindowOpenHandler: (handler) => { this._windowOpenHandler = handler; },
      on: (event, listener) => this.addListener(event, listener, false),
      once: (event, listener) => this.addListener(event, listener, true),
      isDestroyed: () => false,
      getURL: () => this._url,
    };
  }

  addListener(event, listener, once) {
    this._listeners.push({ event, listener, once });
    return this.webContents;
  }

  /** main.js 只监听 did-finish-load（用来把 storage-error 补发给渲染层）。 */
  emitContentEvent(event) {
    const kept = [];
    for (const entry of this._listeners) {
      if (entry.event !== event) { kept.push(entry); continue; }
      if (!entry.once) kept.push(entry);
      try { entry.listener(); } catch (error) { console.error('[Bridge] 事件回调失败:', error.message); }
    }
    this._listeners = kept;
  }

  // 用 Node 侧抓取代替真实浏览器加载：搜索嗅探只需要页面 HTML。
  // 非 2xx 也保留响应体（浏览器同样会显示错误页），这样上层的 pageTitle 兜底才有意义。
  async loadURL(url, options = {}) {
    this._url = String(url);
    try {
      const response = await axios.get(this._url, {
        headers: { 'User-Agent': (options && options.userAgent) || 'Mozilla/5.0' },
        timeout: 15000,
        responseType: 'text',
        maxContentLength: 8 * 1024 * 1024,
      });
      this._html = String(response.data || '');
    } catch (error) {
      this._html = String((error.response && error.response.data) || '');
      if (!this._html) throw error;
    }
  }

  // 主窗口：记下 dist-react 目录，桥接按此供给静态文件。preload 跟着同一个窗口走。
  async loadFile(filePath) {
    state.indexFile = path.resolve(filePath);
    state.staticRoot = path.dirname(state.indexFile);
    state.preloadPath = this._preloadPath;
    state.renderer = this;
  }

  /**
   * main.js 只注入三段脚本：嗅探卡片(SNIFFER_JS)、分类元数据(BROWSE_META_JS)、document.title。
   * 这里按特征串识别并用纯字符串解析代替 DOM。
   */
  async executeJavaScript(code) {
    const source = String(code || '');
    if (source === 'document.title') return titleOf(this._html);
    if (source.includes('totalPages')) return JSON.stringify(parseBrowseMeta(this._html));
    return JSON.stringify(parseSearchCards(this._html));
  }

  isDestroyed() { return false; }
  show() {} hide() {} focus() {} restore() {} setMenuBarVisibility() {}
  isMinimized() { return false; }
  // 永不触发 'closed'：main.js 的 window-all-closed -> app.quit() 不能生效，否则 Node 会退出。
  on() {}
}

// ===== HTML 解析（与 src/native/catalog.js 同一套 _ROUTER_DATA 读取思路）=====
function titleOf(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : '';
}

function readRouterData(html) {
  const text = String(html || '');
  const match = text.match(/(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch (_) { return null; }
    }
  }
  return null;
}

/** 搜索结果在 SSR 数据里：loaderData['search_(keyword)/page'].searchList[].video_data */
function parseSearchCards(html) {
  const router = readRouterData(html);
  const loader = (router && router.loaderData) || {};
  const data = Object.values(loader).find((value) => value && Array.isArray(value.searchList));
  const out = [];
  const seen = new Set();
  for (const item of (data && data.searchList) || []) {
    const video = item && item.video_data;
    const id = String((video && video.series_id) || '');
    if (!/^\d{6,}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      series_id: id,
      series_title: String((video && video.series_title) || '').trim(),
      cover: (video && video.series_cover) || '',
      episode_count: Number(video && video.episode_cnt) || 0,
      tags: (Array.isArray(video && video.category_list) ? video.category_list : [])
        .map((item) => (item && typeof item.name === 'string' ? item.name : ''))
        .filter(Boolean)
        .slice(0, 4),
    });
  }
  return out;
}

/**
 * BROWSE_META_JS 的字符串版。只有搜索页会走这条路（分类页是纯 Node 抓取，不经窗口），
 * 搜索页没有题材筛选链接，所以只还原分页字段，genres 留空数组保持返回结构一致。
 */
function parseBrowseMeta(html) {
  const text = String(html || '');
  const out = { page: 1, totalPages: 0, total: 0, genres: [] };
  const pagination = text.match(/"pagination":\s*\{[^}]*"total":(\d+)[^}]*"pageNum":(\d+)[^}]*"pageSize":(\d+)[^}]*"totalPages":(\d+)/);
  if (pagination) {
    out.total = Number(pagination[1]);
    out.page = Number(pagination[2]);
    out.totalPages = Number(pagination[4]);
  }
  if (!out.totalPages) {
    for (const match of text.matchAll(/[?&]page=(\d+)/g)) out.totalPages = Math.max(out.totalPages, Number(match[1]));
  }
  return out;
}

// ===== 本地 HTTP 桥 =====
function sendText(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendFile(res, filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return sendText(res, 404, 'text/plain; charset=utf-8', 'not found'); }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}

function resolveStatic(rootDir, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch (_) { return null; }
  const target = path.resolve(rootDir, '.' + path.posix.normalize(decoded));
  if (target !== rootDir && !target.startsWith(rootDir + path.sep)) return null;
  return target;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let rendererReady = false;
function sseHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
  // main.js 靠 did-finish-load 判断「现在能把 storage-error 发给渲染层了吗」。
  // 本桥里渲染层订阅事件的时刻就是它连上 SSE 的时刻，比 index.html 返回更准（不会早于订阅）。
  if (!rendererReady && state.renderer) {
    rendererReady = true;
    state.renderer.emitContentEvent('did-finish-load');
  }
}

async function ipcRequest(req, res) {
  const body = await readBody(req, 1024 * 1024);
  let message;
  try { message = JSON.parse(body || '{}'); } catch (_) { return sendText(res, 400, 'text/plain; charset=utf-8', 'bad json'); }
  const handler = ipcHandlers.get(message.channel);
  if (!handler) return sendText(res, 404, 'text/plain; charset=utf-8', `no handler: ${message.channel}`);
  try {
    const result = await handler({ sender: null }, ...(message.args || []));
    sendText(res, 200, 'application/json; charset=utf-8', JSON.stringify(result === undefined ? null : result));
  } catch (error) {
    console.error(`[IPC] ${message.channel} 失败:`, error.message);
    sendText(res, 500, 'application/json; charset=utf-8', JSON.stringify({ success: false, error: error.message }));
  }
}

/** 媒体请求：还原成原 scheme URL，交给 main.js 注册的 protocol 处理函数，再回灌到 http 响应。 */
async function mediaRequest(req, res, target) {
  const handler = protocolHandlers.get(target.slice(0, target.indexOf(':')));
  if (!handler) return sendText(res, 404, 'text/plain; charset=utf-8', 'no handler');
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  // 鸭子类型的 Request：main.js 只用到 url / method / signal / headers.get。
  const request = {
    url: target,
    method: req.method,
    signal: controller.signal,
    headers: { get: (name) => req.headers[String(name).toLowerCase()] || null },
  };
  let response;
  try {
    response = await handler(request);
  } catch (error) {
    console.error('[Bridge] 媒体处理失败:', error.message);
    return sendText(res, 502, 'text/plain; charset=utf-8', 'media error');
  }
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  if (!response.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
}

// whenReady 回调在 main.js 同步体之后才执行，WebView 可能先连上来，这里等一下再报未就绪。
async function waitForStatic(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!state.staticRoot && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function staticRequest(res, pathname) {
  await waitForStatic();
  if (!state.staticRoot) return sendText(res, 503, 'text/plain; charset=utf-8', 'not ready');
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(state.indexFile, 'utf8');
    // 注入桥 + preload（都是同源脚本，CSP 的 script-src 'self' 放行）。
    const injected = html.includes('<head>')
      ? html.replace('<head>', '<head>\n    <script src="/__bridge.js"></script>\n    <script src="/__preload.js"></script>')
      : html;
    return sendText(res, 200, MIME['.html'], injected);
  }
  const file = resolveStatic(state.staticRoot, pathname);
  if (!file) return sendText(res, 404, 'text/plain; charset=utf-8', 'not found');
  return sendFile(res, file);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  if (pathname === '/events') return sseHandler(req, res);
  if (pathname === '/ipc' && req.method === 'POST') return ipcRequest(req, res);
  if (pathname === '/__bridge.js') return sendText(res, 200, MIME['.js'], BRIDGE_SOURCE);
  if (pathname === '/__preload.js') {
    if (!state.preloadPath) return sendText(res, 404, 'text/plain; charset=utf-8', 'no preload');
    return sendFile(res, state.preloadPath);
  }
  const media = /^\/(hongguo-stream|hongguo-local)\/(.+)$/.exec(pathname);
  if (media) return mediaRequest(req, res, `${media[1]}://${media[2]}`);
  return staticRequest(res, pathname);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[Bridge] 请求失败:', error.message);
    try { sendText(res, 500, 'text/plain; charset=utf-8', 'bridge error'); } catch (_) {}
  });
});
server.on('error', (error) => {
  // 端口被占用说明同进程已有实例在服务（Activity 重建），沿用旧实例即可，不退出。
  console.error('[Bridge] 监听失败:', error.message);
});
server.listen(PORT, HOST, () => console.log(`[Bridge] http://${HOST}:${PORT}`));

module.exports = { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, Menu, Notification };
