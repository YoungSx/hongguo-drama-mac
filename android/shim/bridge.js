/*
 * Android 端 preload 的运行环境：在 WebView 里实现 preload.js 需要的 Electron API。
 * preload.js 本身不做任何改动，它 require('electron') 拿到的就是下面这套桥。
 * 用 ES5 语法写，避免老 WebView 解析失败。
 */
(function () {
  var ORIGIN = location.origin;
  var SCHEME = /hongguo-(stream|local):\/\//g;
  var listeners = {};
  var source = null;

  // hongguo-stream://play/x -> http://127.0.0.1:PORT/hongguo-stream/play/x（同源，CSP 的 media-src 'self' 放行）
  function rewrite(value) {
    if (typeof value === 'string') return value.replace(SCHEME, ORIGIN + '/hongguo-$1/');
    if (value && typeof value === 'object') {
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) value[key] = rewrite(value[key]);
      }
    }
    return value;
  }

  function ensureEvents() {
    if (source) return;
    source = new EventSource(ORIGIN + '/events');
    source.onmessage = function (event) {
      var frame;
      try { frame = JSON.parse(event.data); } catch (error) { return; }
      var set = listeners[frame.channel];
      if (!set) return;
      var payload = rewrite(frame.payload);
      for (var i = 0; i < set.length; i++) {
        try { set[i](null, payload); } catch (error) {}
      }
    };
  }

  // 安卓没有可显示的内嵌浏览器窗口，来源页面交给系统浏览器。
  function openExternal(url) {
    var value = String(url || '');
    if (window.AndroidBridge && /^https?:\/\//.test(value)) {
      try { window.AndroidBridge.openExternal(value); } catch (error) {}
    }
  }

  var ipcRenderer = {
    invoke: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (channel === 'open-external-url') {
        openExternal(args[0]);
        return Promise.resolve({ success: true });
      }
      if (channel === 'search-window-show') {
        if (args[0]) openExternal(args[1]);
        return Promise.resolve({ success: true });
      }
      return fetch(ORIGIN + '/ipc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channel, args: args })
      }).then(function (response) {
        if (!response.ok) throw new Error('IPC 调用失败 (' + response.status + ')');
        return response.json();
      }).then(rewrite);
    },
    on: function (channel, listener) {
      if (!listeners[channel]) listeners[channel] = [];
      listeners[channel].push(listener);
      ensureEvents();
      return ipcRenderer;
    },
    removeListener: function (channel, listener) {
      var set = listeners[channel];
      if (set) {
        var index = set.indexOf(listener);
        if (index >= 0) set.splice(index, 1);
      }
      return ipcRenderer;
    }
  };

  // preload.js 第一件事就是 require('electron')，之后只调一次 exposeInMainWorld 把 API 挂上去。
  // 借此在 preload 用完的瞬间删掉 window.require：桌面端开了 contextIsolation，页面里根本没有
  // require，这里保持同等暴露面，免得页面脚本能拿到任意 IPC channel。
  window.require = function (module) {
    if (module === 'electron') {
      return {
        contextBridge: {
          exposeInMainWorld: function (name, api) {
            window[name] = api;
            try { delete window.require; } catch (error) { window.require = undefined; }
          }
        },
        ipcRenderer: ipcRenderer
      };
    }
    throw new Error('Android 端不支持 require("' + module + '")');
  };
})();
