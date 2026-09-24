/* Encipherer · workspace — “一次工作”的映射保险库
 * - 同一工作区内:类型+原值 → 唯一且稳定的占位符(跨文件、跨会话)
 * - 全部映射经 AES-GCM 加密持久化(.ecw 文件 / IndexedDB 本地副本)
 * - localStorage 仅存最近列表元数据,无任何明文秘密
 * 依赖:Encipherer.crypto / Encipherer.fakery / Encipherer.util(Node 测试需先注入 fakery) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var crypto = require('./crypto.js'); crypto = crypto.crypto || crypto;
    var fakery = require('./fakery.js'); fakery = fakery.fakery || fakery;
    var util = require('./util.js'); util = util.util || util;
    module.exports = factory(crypto, fakery, util, null);
  } else {
    root.Encipherer = root.Encipherer || {};
    root.Encipherer.workspace = factory(root.Encipherer.crypto, root.Encipherer.fakery, root.Encipherer.util, root);
  }
})(typeof self !== 'undefined' ? self : this, function (crypto, fakery, util, root) {
  'use strict';

  var ECW_FORMAT = 'ECW';
  var DEFAULT_SETTINGS = { theme: 'auto', autoLockMin: 10, genericStyle: 'short', keepEmailDomain: true };

  /* ================= 本地存储 =================
   * 降级链:IndexedDB(file:// 下 Chrome/Firefox 会拒绝)→ localStorage → 纯内存
   * localStorage/内存模式存 base64 密文;api.storageKind 暴露当前模式供 UI 提示 */
  function createIdbStoreReal() {
    var db = null;
    function open() {
      if (db) return Promise.resolve(db);
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open('encipherer', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('workspaces', { keyPath: 'id' }); };
        req.onsuccess = function () { db = req.result; resolve(db); };
        req.onerror = function () { reject(req.error); };
      });
    }
    function withStore(mode, fn) {
      return open().then(function (d) {
        return new Promise(function (resolve, reject) {
          var t = d.transaction('workspaces', mode);
          var st = t.objectStore('workspaces');
          var req = fn(st);
          t.oncomplete = function () { resolve(req ? req.result : undefined); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error); };
        });
      });
    }
    return {
      put: function (rec) { return withStore('readwrite', function (st) { return st.put(rec); }); },
      get: function (id) { return withStore('readonly', function (st) { return st.get(id); }); },
      delete: function (id) { return withStore('readwrite', function (st) { return st.delete(id); }); }
    };
  }

  // localStorage 适配(值存 base64 密文)
  function createLSStore() {
    function key(id) { return 'ec_ws_' + id; }
    function toB64(u8OrBuf) {
      var u8 = u8OrBuf instanceof Uint8Array ? u8OrBuf : new Uint8Array(u8OrBuf);
      var s = '';
      for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return typeof btoa === 'function' ? btoa(s) : Buffer.from(u8).toString('base64');
    }
    function fromB64(str) {
      if (typeof atob === 'function') {
        var s = atob(str), u8 = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
        return u8;
      }
      return new Uint8Array(Buffer.from(str, 'base64'));
    }
    return {
      put: function (rec) {
        try {
          localStorage.setItem(key(rec.id), JSON.stringify({
            id: rec.id, name: rec.name, updatedAt: rec.updatedAt,
            b64: toB64(rec.blob instanceof Uint8Array ? rec.blob : new Uint8Array(rec.blob))
          }));
          return Promise.resolve();
        } catch (e) { return Promise.reject(e); }
      },
      get: function (id) {
        try {
          var raw = localStorage.getItem(key(id));
          if (!raw) return Promise.resolve(null);
          var o = JSON.parse(raw);
          return Promise.resolve({ id: o.id, name: o.name, updatedAt: o.updatedAt, blob: fromB64(o.b64) });
        } catch (e) { return Promise.resolve(null); }
      },
      delete: function (id) { try { localStorage.removeItem(key(id)); } catch (e) { } return Promise.resolve(); }
    };
  }

  // 内存存储兜底(Node / 无任何持久化环境)
  function createMemStore() {
    var map = {};
    return {
      put: function (rec) { map[rec.id] = rec; return Promise.resolve(); },
      get: function (id) { return Promise.resolve(map[id] || null); },
      delete: function (id) { delete map[id]; return Promise.resolve(); },
      _map: map
    };
  }
  // 探测可用存储:IndexedDB 打开失败(file:// 场景)→ localStorage → 内存
  var _storePromise = null;
  function resolveStore() {
    if (_storePromise) return _storePromise;
    _storePromise = new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined') {
        resolve(typeof localStorage !== 'undefined' ? Object.assign(createLSStore(), { kind: 'localstorage' })
                                                   : Object.assign(createMemStore(), { kind: 'memory' }));
        return;
      }
      var idb = Object.assign(createIdbStoreReal(), { kind: 'indexeddb' });
      idb.put({ id: '__probe__', blob: new ArrayBuffer(1), updatedAt: 0, name: '' })
        .then(function () { return idb.delete('__probe__'); })
        .then(function () { resolve(idb); })
        .catch(function () {
          // localStorage 访问器在部分环境(禁用/隐私/file: 策略)会直接抛异常
          try {
            if (typeof localStorage !== 'undefined') {
              resolve(Object.assign(createLSStore(), { kind: 'localstorage' }));
              return;
            }
          } catch (e) { /* 访问被拒 → 内存 */ }
          resolve(Object.assign(createMemStore(), { kind: 'memory' }));
        });
    });
    return _storePromise;
  }
  // 同步外观(api._localStore),内部等待探测完成
  var localStore = {
    put: function (rec) { return resolveStore().then(function (s) { return s.put(rec); }); },
    get: function (id) { return resolveStore().then(function (s) { return s.get(id); }); },
    delete: function (id) { return resolveStore().then(function (s) { return s.delete(id); }); }
  };
  var storageKind = '探测中';
  resolveStore().then(function (s) { storageKind = s.kind || 'unknown'; });


  /* ================= 最近列表(localStorage,仅元数据) ================= */
  var recentsApi = (function () {
    var mem = [];
    var hasLS = typeof localStorage !== 'undefined';
    function read() {
      try { return hasLS ? JSON.parse(localStorage.getItem('ec_recents') || '[]') : mem; }
      catch (e) { return []; }
    }
    function write(list) {
      try { if (hasLS) localStorage.setItem('ec_recents', JSON.stringify(list)); else mem = list; } catch (e) { }
    }
    return {
      list: read,
      upsert: function (info) {
        var l = read().filter(function (r) { return r.id !== info.id; });
        l.unshift(info);
        write(l.slice(0, 8));
      },
      remove: function (id) { write(read().filter(function (r) { return r.id !== id; })); }
    };
  })();

  /* ================= Ws 对象 ================= */
  function Ws(init) {
    // init: {id,name,createdAt,updatedAt,iter,saltB64,verifier,keys,sealed,settings,maps,occurrences}
    this.id = init.id; this.name = init.name;
    this.createdAt = init.createdAt; this.updatedAt = init.updatedAt || init.createdAt;
    this.iter = init.iter; this.saltB64 = init.saltB64; this.verifier = init.verifier;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, init.settings || {});
    this._keys = init.keys || null;            // 加锁后为 null
    this._sealed = init.sealed || null;        // 最近一次密文(锁定状态下保留以便解锁)
    this._byType = init.maps || {};            // {type: Map(norm -> {p:占位符, d:首见原值})}
    this._reverse = {};                        // {占位符 -> {norm, type}}(解锁时重建)
    this._occ = init.occurrences || {};        // {type|norm -> 次数}
    this._rebuildReverse();
  }
  Ws.prototype._rebuildReverse = function () {
    var rev = {};
    Object.keys(this._byType).forEach(function (type) {
      this._byType[type].forEach(function (rec, norm) { rev[rec.p] = { norm: norm, type: type }; });
    }, this);
    this._reverse = rev;
  };
  Ws.prototype.isLocked = function () { return !this._keys; };

  /* —— 核心:脱敏(确定性 + 唯一性兜底) —— */
  Ws.prototype.mask = async function (piiType, valueStr) {
    if (this.isLocked()) throw new Error('工作区已锁定');
    var norm = fakery.normalize(piiType, String(valueStr == null ? '' : valueStr));
    if (!norm) return { placeholder: '', isNew: false, skipped: true, type: piiType };
    if (!this._byType[piiType]) this._byType[piiType] = new Map();
    var bucket = this._byType[piiType];
    var hit = bucket.get(norm);
    if (hit) {
      var ok = piiType + '|' + norm;
      this._occ[ok] = (this._occ[ok] || 0) + 1;
      return { placeholder: hit.p, isNew: false, type: piiType };
    }
    // 未命中:确定性派生;冲突则 counter 递增重派生
    var ph = null, counter = 0;
    while (ph === null) {
      var seed = await crypto.hmacHex(this._keys.kMap, piiType + '|' + norm + (counter ? '\u0001' + counter : ''));
      var cand = fakery.generate(piiType, seed, String(valueStr), this.settings);
      var taken = this._reverse[cand] !== undefined || cand === norm;
      if (!taken) { ph = cand; } else if (++counter > 64) { throw new Error('占位符派生冲突过多'); }
    }
    bucket.set(norm, { p: ph, d: String(valueStr) });
    this._reverse[ph] = { norm: norm, type: piiType };
    this._occ[piiType + '|' + norm] = 1;
    this.updatedAt = Date.now();
    return { placeholder: ph, isNew: true, type: piiType };
  };

  /* —— 预览(无副作用):已登记返回登记值,未登记按相同算法演算但不写入 —— */
  Ws.prototype.peek = async function (piiType, valueStr) {
    if (this.isLocked()) throw new Error('工作区已锁定');
    var norm = fakery.normalize(piiType, String(valueStr == null ? '' : valueStr));
    if (!norm) return { placeholder: '', skipped: true, isNew: false, type: piiType };
    if (this._byType[piiType]) {
      var hit = this._byType[piiType].get(norm);
      if (hit) return { placeholder: hit.p, isNew: false, type: piiType };
    }
    var seed = await crypto.hmacHex(this._keys.kMap, piiType + '|' + norm);
    return { placeholder: fakery.generate(piiType, seed, String(valueStr), this.settings), isNew: true, type: piiType };
  };

  /* —— 核心:还原 —— */
  Ws.prototype.unmask = function (placeholderText) {
    if (this.isLocked()) return null;
    var hit = this._reverse[String(placeholderText)];
    if (!hit) return null;
    var rec = this._byType[hit.type].get(hit.norm);
    return { value: rec ? rec.d : hit.norm, norm: hit.norm, type: hit.type };
  };

  Ws.prototype.countHit = function (placeholderText) {
    var hit = this._reverse[String(placeholderText)];
    if (!hit) return 0;
    return this._occ[hit.type + '|' + hit.norm] || 0;
  };

  /* —— 映射表浏览 —— */
  Ws.prototype.listMappings = function (opts) {
    opts = opts || {};
    var rows = [];
    Object.keys(this._byType).forEach(function (type) {
      if (opts.type && type !== opts.type) return;
      this._byType[type].forEach(function (rec, norm) {
        if (opts.q) {
          var q = opts.q.toLowerCase();
          if (rec.d.toLowerCase().indexOf(q) < 0 && rec.p.toLowerCase().indexOf(q) < 0) return;
        }
        rows.push({
          type: type, original: rec.d, placeholder: rec.p,
          count: this._occ[type + '|' + norm] || 1
        });
      }, this);
    }, this);
    rows.sort(function (a, b) { return b.count - a.count || (a.original < b.original ? -1 : 1); });
    var offset = opts.offset || 0, limit = opts.limit || 100;
    return { total: rows.length, rows: rows.slice(offset, offset + limit) };
  };

  Ws.prototype.stats = function () {
    var entries = 0, byType = {}, totalHits = 0;
    Object.keys(this._byType).forEach(function (type) {
      var n = this._byType[type].size;
      entries += n; byType[type] = n;
      this._byType[type].forEach(function (_, norm) {
        totalHits += this._occ[type + '|' + norm] || 1;
      }, this);
    }, this);
    return { entries: entries, byType: byType, totalHits: totalHits };
  };

  /* —— 序列化 / 持久化 —— */
  Ws.prototype._serializePlain = function () {
    var maps = {};
    Object.keys(this._byType).forEach(function (type) {
      var o = {};
      this._byType[type].forEach(function (rec, norm) { o[norm] = rec; });
      maps[type] = o;
    }, this);
    return {
      v: 1, name: this.name, createdAt: this.createdAt, updatedAt: this.updatedAt,
      settings: this.settings, maps: maps, occurrences: this._occ
    };
  };
  Ws.prototype._seal = async function () {
    if (!this._keys) throw new Error('工作区已锁定');
    this._sealed = await crypto.encryptJSON(this._keys.kStore, this._serializePlain());
    return this._sealed;
  };
  Ws.prototype._header = function () {
    return {
      format: ECW_FORMAT, v: 1, name: this.name,
      kdf: { salt: this.saltB64, iter: this.iter }, verifier: this.verifier,
      createdAt: this.createdAt, updatedAt: this.updatedAt
    };
  };
  Ws.prototype._ecwBytes = async function () {
    await this._seal();
    var file = JSON.stringify({ header: this._header(), sealed: this._sealed });
    return new TextEncoder().encode(file);
  };
  Ws.prototype.saveLocal = async function () {
    var bytes = await this._ecwBytes();
    await localStore.put({
      id: this.id, blob: bytes.buffer, updatedAt: this.updatedAt,
      name: this.name, iter: this.iter
    });
    recentsApi.upsert({ id: this.id, name: this.name, updatedAt: this.updatedAt, hasLocal: true });
    return true;
  };
  Ws.prototype.exportFile = async function () {
    var bytes = await this._ecwBytes();
    var ext = '.ecw';
    return new Blob([bytes], { type: 'application/octet-stream' });
  };
  Ws.prototype.suggestedFileName = function () { return this.name + '.ecw'; };

  /* —— 锁定 / 解锁 —— */
  Ws.prototype.lock = function () {
    if (!this._keys) return;
    crypto.zeroize(this._keys);
    this._keys = null; this._byType = {}; this._occ = {}; this._reverse = {};
    if (root && root.Encipherer && root.Encipherer.util) root.Encipherer.util.bus.emit('workspace:locked', { id: this.id });
  };
  Ws.prototype.unlock = async function (password) {
    if (!this._sealed) throw new Error('无密文可解锁');
    var keys = await crypto.deriveKeys(password, this.saltB64, this.iter);
    var v = await crypto.hmacHex(keys.kCheck, crypto.VERIFIER_MSG);
    if (v !== this.verifier) return false;
    var plain = await crypto.decryptJSON(keys.kStore, this._sealed);
    this._keys = keys;
    this.name = plain.name; this.settings = Object.assign({}, DEFAULT_SETTINGS, plain.settings);
    this.createdAt = plain.createdAt; this.updatedAt = plain.updatedAt;
    var maps = {};
    Object.keys(plain.maps || {}).forEach(function (type) {
      var m = new Map();
      Object.keys(plain.maps[type]).forEach(function (norm) { m.set(norm, plain.maps[type][norm]); });
      maps[type] = m;
    });
    this._byType = maps; this._occ = plain.occurrences || {};
    this._rebuildReverse();
    if (root && root.Encipherer && root.Encipherer.util) root.Encipherer.util.bus.emit('workspace:unlocked', { id: this.id });
    return true;
  };

  /* —— 管理操作 —— */
  Ws.prototype.rename = function (name) { this.name = name; this.updatedAt = Date.now(); };
  Ws.prototype.changePassword = async function (oldPw, newPw) {
    if (this.isLocked()) throw new Error('工作区已锁定');
    // 验证旧密码
    var test = await crypto.deriveKeys(oldPw, this.saltB64, this.iter);
    var v = await crypto.hmacHex(test.kCheck, crypto.VERIFIER_MSG);
    if (v !== this.verifier) return false;
    // 新盐 + 新钥重新封装
    var salt = await crypto.randomSaltB64();
    var keys = await crypto.deriveKeys(newPw, salt, this.iter);
    crypto.zeroize(test);
    this.saltB64 = salt;
    this.verifier = await crypto.hmacHex(keys.kCheck, crypto.VERIFIER_MSG);
    this._keys = keys;
    this.updatedAt = Date.now();
    return true;
  };
  Ws.prototype.destroy = async function () {
    await localStore.delete(this.id);
    recentsApi.remove(this.id);
    this.lock();
  };
  Ws.prototype.forgetLocal = async function () {
    await localStore.delete(this.id);
    recentsApi.remove(this.id);
  };

  /* ================= 模块级 API ================= */
  var api = {
    current: null,
    _localStore: localStore, // 测试可替换
    _recents: recentsApi,
    storageKind: function () { return storageKind; },

    recents: function () { return recentsApi.list(); },

    _install: function (ws) {
      api.current = ws;
      localStore.get(ws.id).then(function (rec) {
        recentsApi.upsert({ id: ws.id, name: ws.name, updatedAt: ws.updatedAt, hasLocal: !!rec });
      }, function () {
        recentsApi.upsert({ id: ws.id, name: ws.name, updatedAt: ws.updatedAt, hasLocal: false });
      });
      return ws;
    },

    create: async function (name, password, settingsOverride) {
      var salt = await crypto.randomSaltB64();
      var iter = crypto.DEFAULT_ITER;
      var keys = await crypto.deriveKeys(password, salt, iter);
      var verifier = await crypto.hmacHex(keys.kCheck, crypto.VERIFIER_MSG);
      var ws = new Ws({
        id: util.uid('ws'), name: name, createdAt: Date.now(), updatedAt: Date.now(),
        iter: iter, saltB64: salt, verifier: verifier, keys: keys,
        settings: Object.assign({}, DEFAULT_SETTINGS, settingsOverride || {}),
        maps: {}, occurrences: {}
      });
      await ws.saveLocal();
      return api._install(ws);
    },

    _fromFileObject: async function (header, sealed, password) {
      if (header.format !== ECW_FORMAT) throw new Error('不是有效的 Encipherer 工作区文件');
      var keys = await crypto.deriveKeys(password, header.kdf.salt, header.kdf.iter);
      var v = await crypto.hmacHex(keys.kCheck, crypto.VERIFIER_MSG);
      if (v !== header.verifier) return null; // 密码错误
      var plain = await crypto.decryptJSON(keys.kStore, sealed);
      var maps = {};
      Object.keys(plain.maps || {}).forEach(function (type) {
        var m = new Map();
        Object.keys(plain.maps[type]).forEach(function (norm) { m.set(norm, plain.maps[type][norm]); });
        maps[type] = m;
      });
      var ws = new Ws({
        id: header.id || util.uid('ws'), name: plain.name, createdAt: plain.createdAt, updatedAt: plain.updatedAt,
        iter: header.kdf.iter, saltB64: header.kdf.salt, verifier: header.verifier,
        keys: keys, sealed: sealed,
        settings: Object.assign({}, DEFAULT_SETTINGS, plain.settings),
        maps: maps, occurrences: plain.occurrences || {}
      });
      return ws;
    },

    openFromBlob: async function (blob, password) {
      var text = new TextDecoder().decode(await blob.arrayBuffer());
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) { throw new Error('文件解析失败,可能已损坏'); }
      if (!parsed || !parsed.header) throw new Error('不是有效的 Encipherer 工作区文件');
      var ws = await api._fromFileObject(parsed.header, parsed.sealed, password);
      if (!ws) return null;
      return api._install(ws);
    },

    openFromLocal: async function (id, password) {
      var rec = await localStore.get(id);
      if (!rec) return null;
      var text = new TextDecoder().decode(rec.blob instanceof Uint8Array ? rec.blob : new Uint8Array(rec.blob));
      var parsed = JSON.parse(text);
      var ws = await api._fromFileObject(parsed.header, parsed.sealed, password);
      if (!ws) return null;
      ws.id = id; // 本地副本以存储 id 为准
      return api._install(ws);
    },

    removeLocal: async function (id) {
      await localStore.delete(id);
      recentsApi.remove(id);
      if (api.current && api.current.id === id) api.current = null;
    },

    /* —— 自动锁定(浏览器) —— */
    _lockTimer: null,
    _lastActive: Date.now(),
    startAutoLock: function () {
      if (typeof document === 'undefined') return;
      ['mousedown', 'keydown', 'touchstart'].forEach(function (evt) {
        document.addEventListener(evt, function () { api._lastActive = Date.now(); }, { passive: true });
      });
      if (api._lockTimer) clearInterval(api._lockTimer);
      api._lockTimer = setInterval(function () {
        var ws = api.current;
        if (!ws || ws.isLocked()) return;
        var min = ws.settings.autoLockMin || 0;
        if (min > 0 && Date.now() - api._lastActive > min * 60000) ws.lock();
      }, 5000);
    }
  };
  return api;
});
