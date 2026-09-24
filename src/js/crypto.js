/* Encipherer · crypto — 密钥派生与加解密层
 * 方案:PBKDF2-HMAC-SHA256(600k) → master → HKDF 派生三把子钥
 *   kMap   HMAC-SHA256:确定性占位符种子派生
 *   kStore AES-GCM:工作区文件加密
 *   kCheck HMAC-SHA256:密码校验子
 * 全部基于 WebCrypto(浏览器与 Node ≥18 一致)。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Encipherer = root.Encipherer || {}; root.Encipherer.crypto = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var subtle = (typeof crypto !== 'undefined' && crypto.subtle) || (typeof msCrypto !== 'undefined' && msCrypto.subtle);
  if (!subtle) throw new Error('当前环境不支持 WebCrypto');

  var DEFAULT_ITER = 600000;             // OWASP 2023 建议 PBKDF2-SHA256 ≥ 600k
  var VERIFIER_MSG = 'encipherer-v1-verify';
  var INFO_MAP = new TextEncoder().encode('encipherer/map');
  var INFO_STORE = new TextEncoder().encode('encipherer/store');
  var INFO_CHECK = new TextEncoder().encode('encipherer/check');

  function randomBytes(n) { var u8 = new Uint8Array(n); crypto.getRandomValues(u8); return u8; }
  function randomSaltB64() {
    var u = randomBytes(16), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(u).toString('base64');
  }

  // PBKDF2 → master 32B(raw) → HKDF 三方向
  async function deriveKeys(password, saltB64, iter) {
    iter = iter || DEFAULT_ITER;
    var saltU8;
    if (typeof atob === 'function') {
      var s = atob(saltB64); saltU8 = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) saltU8[i] = s.charCodeAt(i);
    } else saltU8 = new Uint8Array(Buffer.from(saltB64, 'base64'));

    var pwKey = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    var masterBits = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltU8, iterations: iter }, pwKey, 256);
    var masterKey = await subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits']);

    async function hkdf(info) {
      var bits = await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: info }, masterKey, 256);
      return bits; // ArrayBuffer 32B
    }
    var kMap = await subtle.importKey('raw', await hkdf(INFO_MAP), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var kStore = await subtle.importKey('raw', await hkdf(INFO_STORE), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    var kCheck = await subtle.importKey('raw', await hkdf(INFO_CHECK), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return { kMap: kMap, kStore: kStore, kCheck: kCheck };
  }

  async function hmacHex(key, message) {
    var sig = await subtle.sign('HMAC', key, new TextEncoder().encode(message));
    var u8 = new Uint8Array(sig), out = '';
    for (var i = 0; i < u8.length; i++) out += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return out;
  }

  function toB64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
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

  async function encryptJSON(kStore, obj) {
    var plain = new TextEncoder().encode(JSON.stringify(obj));
    var nonce = randomBytes(12);
    var ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, kStore, plain);
    return { n: toB64(nonce), c: toB64(new Uint8Array(ct)) };
  }

  async function decryptJSON(kStore, sealed) {
    var pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(sealed.n), tagLength: 128 }, kStore, fromB64(sealed.c));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // 尽力清除密钥引用(不可导出的 CryptoKey 无法真正零化,解除引用交给 GC)
  function zeroize(keys) {
    if (!keys) return;
    keys.kMap = null; keys.kStore = null; keys.kCheck = null;
  }

  return {
    DEFAULT_ITER: DEFAULT_ITER, VERIFIER_MSG: VERIFIER_MSG,
    randomSaltB64: randomSaltB64, deriveKeys: deriveKeys,
    hmacHex: hmacHex, encryptJSON: encryptJSON, decryptJSON: decryptJSON,
    zeroize: zeroize, _toB64: toB64, _fromB64: fromB64
  };
});
