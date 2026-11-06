/* 非对称登录密码学（小程序端，纯 JS，无 Web Crypto 依赖）。
 *
 * 与 Rust 服务端 `src/crypto.rs`、浏览器端 `src/assets/auth.js` 使用同一套协议：
 *
 *   私钥 = PBKDF2-HMAC-SHA256(password, "smart-campus/auth/v1:" + 小写用户名, 210000)
 *   公钥 = X25519(私钥, basepoint)
 *   挑战 = X25519-ECIES：临时公钥(32) || nonce(12) || AES-256-GCM(challenge, tag 16)
 *   回答 = nonce(12) || AES-256-GCM(challenge, tag 16)
 *
 * 小程序运行环境没有 `crypto.subtle`，也没有 Node 的 `crypto`，因此这里自带
 * SHA-256 / HMAC / PBKDF2 / X25519 / HKDF / AES-256-GCM 的最小实现。
 * X25519 使用 TweetNaCl 风格的 16×16 位肢体运算，不依赖 BigInt，
 * 兼容 iOS 上较老的 JavaScriptCore。
 *
 * 随机数：优先使用 `crypto.getRandomValues`（开发者工具 / Node 测试），
 * 其次 `wx.getRandomValues`（异步，见 randomBytesAsync），最后退化到
 * SHA-256 混合熵的兜底实现（仅用于本地模拟的 nonce，不用于密钥生成）。
 */

var KEY_LEN = 32;
var NONCE_LEN = 12;
var TAG_LEN = 16;
var CHALLENGE_LEN = 32;
var KDF_ITERATIONS = 210000;
var KDF_SALT_PREFIX = "smart-campus/auth/v1:";
var CHALLENGE_INFO = "smart-campus/challenge/v1";

// ---------------------------------------------------------------------------
// 编码工具
// ---------------------------------------------------------------------------

function utf8(text) {
  var str = String(text === null || text === undefined ? "" : text);
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      var c2 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 63),
          0x80 | ((cp >> 6) & 63),
          0x80 | (cp & 63)
        );
      } else {
        out.push(0xef, 0xbf, 0xbd);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return new Uint8Array(out);
}

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_LOOKUP = null;
function b64Lookup() {
  if (B64_LOOKUP) return B64_LOOKUP;
  B64_LOOKUP = new Int16Array(128);
  for (var i = 0; i < 128; i++) B64_LOOKUP[i] = -1;
  for (i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;
  B64_LOOKUP["-".charCodeAt(0)] = 62;
  B64_LOOKUP["_".charCodeAt(0)] = 63;
  return B64_LOOKUP;
}

/** 标准 base64（带 padding）。 */
function b64encode(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    var n = (b0 << 16) | (b1 << 8) | b2;
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : "=";
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : "=";
  }
  return out;
}

/** 标准 / URL-safe base64，忽略空白与 padding，与服务端 b64_decode 一致。 */
function b64decode(text) {
  var raw = String(text === null || text === undefined ? "" : text).replace(/\s+/g, "").replace(/=+$/, "");
  var lookup = b64Lookup();
  var out = new Uint8Array(Math.floor((raw.length * 3) / 4));
  var acc = 0;
  var bits = 0;
  var pos = 0;
  for (var i = 0; i < raw.length; i++) {
    var code = raw.charCodeAt(i);
    var v = code < 128 ? lookup[code] : -1;
    if (v < 0) throw new Error("invalid base64 character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new Error("invalid base64 padding");
  return out.subarray(0, pos);
}

function concatBytes(parts) {
  var total = 0;
  for (var i = 0; i < parts.length; i++) total += parts[i].length;
  var out = new Uint8Array(total);
  var off = 0;
  for (i = 0; i < parts.length; i++) {
    out.set(parts[i], off);
    off += parts[i].length;
  }
  return out;
}

function bytesToHex(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return out;
}

function hexToBytes(hex) {
  var text = String(hex || "").replace(/\s+/g, "");
  if (text.length % 2 !== 0) throw new Error("invalid hex");
  var out = new Uint8Array(text.length / 2);
  for (var i = 0; i < out.length; i++) {
    var v = parseInt(text.slice(i * 2, i * 2 + 2), 16);
    if (isNaN(v)) throw new Error("invalid hex");
    out[i] = v;
  }
  return out;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// SHA-256 / HMAC / PBKDF2
// ---------------------------------------------------------------------------

var SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

var SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

var shaW = new Int32Array(64);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/** 压缩一个 64 字节块；block 可以是 Uint8Array，blockOffset 指定起点。 */
function sha256Compress(h, block, blockOffset) {
  var off = blockOffset || 0;
  var w = shaW;
  for (var i = 0; i < 16; i++) {
    var p = off + i * 4;
    w[i] = (block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3];
  }
  for (i = 16; i < 64; i++) {
    var x = w[i - 15];
    var y = w[i - 2];
    var s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
    var s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  var a = h[0] | 0, b = h[1] | 0, c = h[2] | 0, d = h[3] | 0;
  var e = h[4] | 0, f = h[5] | 0, g = h[6] | 0, hh = h[7] | 0;
  for (i = 0; i < 64; i++) {
    var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    var ch = (e & f) ^ (~e & g);
    var t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0;
    var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    var maj = (a & b) ^ (a & c) ^ (b & c);
    var t2 = (S0 + maj) | 0;
    hh = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0;
  h[1] = (h[1] + b) | 0;
  h[2] = (h[2] + c) | 0;
  h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0;
  h[5] = (h[5] + f) | 0;
  h[6] = (h[6] + g) | 0;
  h[7] = (h[7] + hh) | 0;
}

function stateToBytes(h, out, offset) {
  var o = offset || 0;
  for (var i = 0; i < 8; i++) {
    var v = h[i];
    out[o + i * 4] = (v >>> 24) & 0xff;
    out[o + i * 4 + 1] = (v >>> 16) & 0xff;
    out[o + i * 4 + 2] = (v >>> 8) & 0xff;
    out[o + i * 4 + 3] = v & 0xff;
  }
}

function writeBitLength(buf, end, byteLen) {
  var bitsHi = Math.floor(byteLen / 0x20000000);
  var bitsLo = (byteLen << 3) >>> 0;
  buf[end - 8] = (bitsHi >>> 24) & 0xff;
  buf[end - 7] = (bitsHi >>> 16) & 0xff;
  buf[end - 6] = (bitsHi >>> 8) & 0xff;
  buf[end - 5] = bitsHi & 0xff;
  buf[end - 4] = (bitsLo >>> 24) & 0xff;
  buf[end - 3] = (bitsLo >>> 16) & 0xff;
  buf[end - 2] = (bitsLo >>> 8) & 0xff;
  buf[end - 1] = bitsLo & 0xff;
}

/** 处理任意长度消息并收尾；prefixLen 是状态里已经吸收的字节数（HMAC ipad 为 64）。 */
function sha256Final(h, msg, out, prefixLen) {
  var total = ((msg.length + 9 + 63) >> 6) << 6;
  var buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  writeBitLength(buf, total, (prefixLen || 0) + msg.length);
  for (var off = 0; off < total; off += 64) sha256Compress(h, buf, off);
  stateToBytes(h, out, 0);
}

function sha256(bytes) {
  var h = new Uint32Array(SHA256_INIT);
  var out = new Uint8Array(32);
  sha256Final(h, bytes, out, 0);
  return out;
}

/** HMAC 预计算：返回内层 / 外层已压缩 ipad、opad 的状态。 */
function hmacInit(keyBytes) {
  var key = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes;
  var ipad = new Uint8Array(64);
  var opad = new Uint8Array(64);
  for (var i = 0; i < 64; i++) {
    var k = i < key.length ? key[i] : 0;
    ipad[i] = k ^ 0x36;
    opad[i] = k ^ 0x5c;
  }
  var st = {
    inner: new Uint32Array(SHA256_INIT),
    outer: new Uint32Array(SHA256_INIT),
    bufIn: new Uint8Array(64),
    bufOut: new Uint8Array(64),
    hInner: new Uint32Array(8),
    hOuter: new Uint32Array(8),
  };
  sha256Compress(st.inner, ipad, 0);
  sha256Compress(st.outer, opad, 0);
  return st;
}

/** 固定 32 字节消息的 HMAC（PBKDF2 热路径），结果写入 out。 */
function hmac32(st, data, out) {
  var block = st.bufIn;
  block.set(data.subarray(0, 32));
  block[32] = 0x80;
  for (var i = 33; i < 56; i++) block[i] = 0;
  writeBitLength(block, 64, 64 + 32);
  st.hInner.set(st.inner);
  sha256Compress(st.hInner, block, 0);

  var outer = st.bufOut;
  stateToBytes(st.hInner, outer, 0);
  outer[32] = 0x80;
  for (i = 33; i < 56; i++) outer[i] = 0;
  writeBitLength(outer, 64, 64 + 32);
  st.hOuter.set(st.outer);
  sha256Compress(st.hOuter, outer, 0);
  stateToBytes(st.hOuter, out, 0);
}

/** 任意长度消息的 HMAC，返回 32 字节。 */
function hmacSha256(keyBytes, msg) {
  var st = hmacInit(keyBytes);
  var inner = new Uint32Array(st.inner);
  var digest = new Uint8Array(32);
  sha256Final(inner, msg, digest, 64);
  var outer = new Uint32Array(st.outer);
  var block = new Uint8Array(64);
  block.set(digest);
  block[32] = 0x80;
  writeBitLength(block, 64, 64 + 32);
  sha256Compress(outer, block, 0);
  var out = new Uint8Array(32);
  stateToBytes(outer, out, 0);
  return out;
}

/** PBKDF2-HMAC-SHA256，输出 dkLen（默认 32）字节。 */
function pbkdf2(passwordBytes, saltBytes, iterations, dkLen) {
  var st = hmacInit(passwordBytes);
  var first = concatBytes([saltBytes, new Uint8Array([0, 0, 0, 1])]);
  var inner = new Uint32Array(st.inner);
  var digest = new Uint8Array(32);
  sha256Final(inner, first, digest, 64);
  var outer = new Uint32Array(st.outer);
  var block = new Uint8Array(64);
  block.set(digest);
  block[32] = 0x80;
  writeBitLength(block, 64, 64 + 32);
  sha256Compress(outer, block, 0);
  var u = new Uint8Array(32);
  stateToBytes(outer, u, 0);
  var t = new Uint8Array(u);
  var next = new Uint8Array(32);
  var i;
  for (var j = 1; j < iterations; j++) {
    hmac32(st, u, next);
    for (i = 0; i < 32; i++) t[i] ^= next[i];
    var tmp = u; u = next; next = tmp;
  }
  return dkLen && dkLen < 32 ? t.subarray(0, dkLen) : t;
}

function derivePrivateKey(password, salt, iterations) {
  if (!password) throw new Error("PASSWORD_REQUIRED");
  if (!salt) throw new Error("SALT_REQUIRED");
  return pbkdf2(utf8(password), utf8(salt), iterations || KDF_ITERATIONS, KEY_LEN);
}

function defaultSalt(username) {
  return KDF_SALT_PREFIX + String(username || "").trim().toLowerCase();
}

function hkdf(ikm, salt, info, len) {
  var prk = hmacSha256(salt && salt.length ? salt : new Uint8Array(32), ikm);
  var outLen = len || KEY_LEN;
  var okm = new Uint8Array(outLen);
  var prev = new Uint8Array(0);
  var pos = 0;
  for (var counter = 1; pos < outLen; counter++) {
    var msg = concatBytes([prev, info, new Uint8Array([counter])]);
    var block = hmacSha256(prk, msg);
    var take = Math.min(block.length, outLen - pos);
    okm.set(block.subarray(0, take), pos);
    pos += take;
    prev = block;
  }
  return okm;
}

// ---------------------------------------------------------------------------
// X25519（RFC 7748，TweetNaCl 风格 16×16 位肢体）
// ---------------------------------------------------------------------------

function gf(init) {
  var r = new Float64Array(16);
  if (init) for (var i = 0; i < init.length; i++) r[i] = init[i];
  return r;
}

var GF_121665 = gf([0xdb41, 1]);

function gfAdd(o, a, b) {
  for (var i = 0; i < 16; i++) o[i] = a[i] + b[i];
}

function gfSub(o, a, b) {
  for (var i = 0; i < 16; i++) o[i] = a[i] - b[i];
}

function gfCarry(o) {
  for (var i = 0; i < 16; i++) {
    var v = o[i] + 65536;
    var c = Math.floor(v / 65536);
    o[i] = v - c * 65536;
    if (i < 15) {
      o[i + 1] += c - 1;
    } else {
      // 与 C 版一致：第 15 个肢体进位同时落到 o[0]（c-1）与 37*(c-1)。
      o[0] += 38 * (c - 1);
    }
  }
}

function gfMul(o, a, b) {
  var t = new Float64Array(31);
  for (var i = 0; i < 16; i++) {
    for (var j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
  }
  for (i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
  for (i = 0; i < 16; i++) o[i] = t[i];
  gfCarry(o);
  gfCarry(o);
}

function gfSquare(o, a) {
  gfMul(o, a, a);
}

function gfSelect(p, q, b) {
  var c = ~(b - 1);
  for (var i = 0; i < 16; i++) {
    var t = c & (p[i] ^ q[i]);
    p[i] ^= t;
    q[i] ^= t;
  }
}

function gfPack(o, n) {
  var m = gf();
  var t = gf();
  for (var i = 0; i < 16; i++) t[i] = n[i];
  gfCarry(t);
  gfCarry(t);
  gfCarry(t);
  for (var j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
      m[i - 1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    var b = (m[15] >> 16) & 1;
    m[14] &= 0xffff;
    gfSelect(t, m, 1 - b);
  }
  for (i = 0; i < 16; i++) {
    o[2 * i] = t[i] & 0xff;
    o[2 * i + 1] = (t[i] >> 8) & 0xff;
  }
}

function gfUnpack(o, n) {
  for (var i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
  o[15] &= 0x7fff;
}

function gfInvert(o, i) {
  var c = gf();
  var a;
  for (a = 0; a < 16; a++) c[a] = i[a];
  for (a = 253; a >= 0; a--) {
    gfSquare(c, c);
    if (a !== 2 && a !== 4) gfMul(c, c, i);
  }
  for (a = 0; a < 16; a++) o[a] = c[a];
}

function x25519(scalar, point) {
  if (!scalar || scalar.length !== KEY_LEN) throw new Error("invalid X25519 scalar");
  if (!point || point.length !== KEY_LEN) throw new Error("invalid X25519 public key");
  var z = new Uint8Array(32);
  for (var i = 0; i < 31; i++) z[i] = scalar[i];
  z[31] = (scalar[31] & 127) | 64;
  z[0] &= 248;

  var x = new Float64Array(80);
  gfUnpack(x, point);
  var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();
  for (i = 0; i < 16; i++) {
    b[i] = x[i];
    d[i] = a[i] = c[i] = 0;
  }
  a[0] = d[0] = 1;

  for (i = 254; i >= 0; --i) {
    var r = (z[i >>> 3] >>> (i & 7)) & 1;
    gfSelect(a, b, r);
    gfSelect(c, d, r);
    gfAdd(e, a, c);
    gfSub(a, a, c);
    gfAdd(c, b, d);
    gfSub(b, b, d);
    gfSquare(d, e);
    gfSquare(f, a);
    gfMul(a, c, a);
    gfMul(c, b, e);
    gfAdd(e, a, c);
    gfSub(a, a, c);
    gfSquare(b, a);
    gfSub(c, d, f);
    gfMul(a, c, GF_121665);
    gfAdd(a, a, d);
    gfMul(c, c, a);
    gfMul(a, d, f);
    gfMul(d, b, x);
    gfSquare(b, e);
    gfSelect(a, b, r);
    gfSelect(c, d, r);
  }
  for (i = 0; i < 16; i++) {
    x[i + 16] = a[i];
    x[i + 32] = c[i];
    x[i + 48] = b[i];
    x[i + 64] = d[i];
  }
  var x32 = x.subarray(32, 48);
  var x16 = x.subarray(16, 32);
  gfInvert(x32, x32);
  gfMul(x16, x16, x32);
  var out = new Uint8Array(32);
  gfPack(out, x16);
  return out;
}

var X25519_BASEPOINT = (function () {
  var p = new Uint8Array(32);
  p[0] = 9;
  return p;
})();

function publicKey(privateBytes) {
  return x25519(privateBytes, X25519_BASEPOINT);
}

function sharedSecret(privateBytes, peerPublic) {
  return x25519(privateBytes, peerPublic);
}

/** 低阶点校验：与随机标量做一次 ECDH，全零结果说明公钥不可用。 */
function validatePublicKey(pub) {
  if (!pub || pub.length !== KEY_LEN) return false;
  var probe = sha256(concatBytes([pub, new Uint8Array([1])])).subarray(0, 32);
  var shared = x25519(probe, pub);
  var acc = 0;
  for (var i = 0; i < 32; i++) acc |= shared[i];
  return acc !== 0;
}

// ---------------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------------

var AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

var AES_RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

function aesExpandKey(key) {
  var w = new Uint32Array(60);
  var i;
  for (i = 0; i < 8; i++) {
    w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  }
  for (i = 8; i < 60; i++) {
    var t = w[i - 1];
    if (i % 8 === 0) {
      t = ((t << 8) | (t >>> 24)) >>> 0; // RotWord
      t = ((AES_SBOX[(t >>> 24) & 0xff] << 24) |
        (AES_SBOX[(t >>> 16) & 0xff] << 16) |
        (AES_SBOX[(t >>> 8) & 0xff] << 8) |
        AES_SBOX[t & 0xff]) >>> 0;
      t = (t ^ (AES_RCON[i / 8 - 1] << 24)) >>> 0;
    } else if (i % 8 === 4) {
      t = ((AES_SBOX[(t >>> 24) & 0xff] << 24) |
        (AES_SBOX[(t >>> 16) & 0xff] << 16) |
        (AES_SBOX[(t >>> 8) & 0xff] << 8) |
        AES_SBOX[t & 0xff]) >>> 0;
    }
    w[i] = (w[i - 8] ^ t) >>> 0;
  }
  return w;
}

function aesAddRoundKey(s, w, round) {
  for (var c = 0; c < 4; c++) {
    var k = w[round * 4 + c];
    s[4 * c] ^= (k >>> 24) & 0xff;
    s[4 * c + 1] ^= (k >>> 16) & 0xff;
    s[4 * c + 2] ^= (k >>> 8) & 0xff;
    s[4 * c + 3] ^= k & 0xff;
  }
}

function aesSubBytes(s) {
  for (var i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
}

function aesShiftRows(s) {
  var t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
  t = s[2]; s[2] = s[10]; s[10] = t;
  t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[3]; s[3] = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = t;
}

function xtime(b) {
  return ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff;
}

function aesMixColumns(s) {
  for (var c = 0; c < 4; c++) {
    var i = 4 * c;
    var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    var t = a0 ^ a1 ^ a2 ^ a3;
    var u = a0;
    s[i] ^= t ^ xtime(a0 ^ a1);
    s[i + 1] ^= t ^ xtime(a1 ^ a2);
    s[i + 2] ^= t ^ xtime(a2 ^ a3);
    s[i + 3] ^= t ^ xtime(a3 ^ u);
  }
}

function aesEncryptBlock(w, input, out) {
  var s = new Uint8Array(16);
  s.set(input);
  aesAddRoundKey(s, w, 0);
  for (var round = 1; round < 14; round++) {
    aesSubBytes(s);
    aesShiftRows(s);
    aesMixColumns(s);
    aesAddRoundKey(s, w, round);
  }
  aesSubBytes(s);
  aesShiftRows(s);
  aesAddRoundKey(s, w, 14);
  out.set(s);
}

function ghashXor(a, b) {
  for (var i = 0; i < 16; i++) a[i] ^= b[i];
}

function ghashMul(x, y) {
  var z = new Uint8Array(16);
  var v = new Uint8Array(y);
  for (var i = 0; i < 128; i++) {
    if ((x[i >> 3] >> (7 - (i & 7))) & 1) ghashXor(z, v);
    var lsb = v[15] & 1;
    for (var j = 15; j > 0; j--) v[j] = ((v[j] >>> 1) | ((v[j - 1] & 1) << 7)) & 0xff;
    v[0] = v[0] >>> 1;
    if (lsb) v[0] ^= 0xe1;
  }
  return z;
}

function ghash(h, aad, ciphertext) {
  var y = new Uint8Array(16);
  var i;
  for (i = 0; i < aad.length; i += 16) {
    var ab = new Uint8Array(16);
    ab.set(aad.subarray(i, Math.min(i + 16, aad.length)));
    ghashXor(y, ab);
    y = ghashMul(y, h);
  }
  for (i = 0; i < ciphertext.length; i += 16) {
    var cb = new Uint8Array(16);
    cb.set(ciphertext.subarray(i, Math.min(i + 16, ciphertext.length)));
    ghashXor(y, cb);
    y = ghashMul(y, h);
  }
  var lenBlock = new Uint8Array(16);
  var aadBits = aad.length * 8;
  var ctBits = ciphertext.length * 8;
  lenBlock[4] = (aadBits >>> 24) & 0xff;
  lenBlock[5] = (aadBits >>> 16) & 0xff;
  lenBlock[6] = (aadBits >>> 8) & 0xff;
  lenBlock[7] = aadBits & 0xff;
  lenBlock[12] = (ctBits >>> 24) & 0xff;
  lenBlock[13] = (ctBits >>> 16) & 0xff;
  lenBlock[14] = (ctBits >>> 8) & 0xff;
  lenBlock[15] = ctBits & 0xff;
  ghashXor(y, lenBlock);
  return ghashMul(y, h);
}

function inc32(block) {
  for (var i = 15; i >= 12; i--) {
    block[i] = (block[i] + 1) & 0xff;
    if (block[i] !== 0) break;
  }
}

/** AES-256-GCM 加密，返回 ciphertext || tag(16)。 */
function aesGcmSeal(key, nonce, plaintext) {
  if (key.length !== KEY_LEN) throw new Error("invalid AES-256-GCM key");
  if (nonce.length !== NONCE_LEN) throw new Error("invalid AES-GCM nonce");
  var w = aesExpandKey(key);
  var h = new Uint8Array(16);
  aesEncryptBlock(w, new Uint8Array(16), h);
  var j0 = new Uint8Array(16);
  j0.set(nonce);
  j0[15] = 1;
  var counter = new Uint8Array(j0);
  var ciphertext = new Uint8Array(plaintext.length);
  var keystream = new Uint8Array(16);
  for (var off = 0; off < plaintext.length; off += 16) {
    inc32(counter);
    aesEncryptBlock(w, counter, keystream);
    for (var i = 0; i < 16 && off + i < plaintext.length; i++) {
      ciphertext[off + i] = plaintext[off + i] ^ keystream[i];
    }
  }
  var s = ghash(h, new Uint8Array(0), ciphertext);
  var tagMask = new Uint8Array(16);
  aesEncryptBlock(w, j0, tagMask);
  var tag = new Uint8Array(16);
  for (i = 0; i < 16; i++) tag[i] = s[i] ^ tagMask[i];
  var out = new Uint8Array(ciphertext.length + TAG_LEN);
  out.set(ciphertext);
  out.set(tag, ciphertext.length);
  return out;
}

/** AES-256-GCM 解密；data 为 ciphertext || tag(16)，认证失败抛错。 */
function aesGcmOpen(key, nonce, data) {
  if (data.length < TAG_LEN) throw new Error("invalid AES-GCM data");
  var ciphertext = data.subarray(0, data.length - TAG_LEN);
  var tag = data.subarray(data.length - TAG_LEN);
  var w = aesExpandKey(key);
  var h = new Uint8Array(16);
  aesEncryptBlock(w, new Uint8Array(16), h);
  var j0 = new Uint8Array(16);
  j0.set(nonce);
  j0[15] = 1;
  var s = ghash(h, new Uint8Array(0), ciphertext);
  var tagMask = new Uint8Array(16);
  aesEncryptBlock(w, j0, tagMask);
  var expected = new Uint8Array(16);
  for (var i = 0; i < 16; i++) expected[i] = s[i] ^ tagMask[i];
  if (!constantTimeEqual(expected, tag)) throw new Error("AES-GCM authentication failed");
  var counter = new Uint8Array(j0);
  var plaintext = new Uint8Array(ciphertext.length);
  var keystream = new Uint8Array(16);
  for (var off = 0; off < ciphertext.length; off += 16) {
    inc32(counter);
    aesEncryptBlock(w, counter, keystream);
    for (i = 0; i < 16 && off + i < ciphertext.length; i++) {
      plaintext[off + i] = ciphertext[off + i] ^ keystream[i];
    }
  }
  return plaintext;
}

// ---------------------------------------------------------------------------
// 随机数
// ---------------------------------------------------------------------------

var randomCounter = 0;

function globalCrypto() {
  if (typeof crypto !== "undefined" && crypto && typeof crypto.getRandomValues === "function") return crypto;
  if (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    return globalThis.crypto;
  }
  return null;
}

function fallbackRandom(n) {
  var out = new Uint8Array(n);
  var off = 0;
  var seed = utf8(
    String(Date.now()) + ":" + String(Math.random()) + ":" + String(randomCounter++) + ":" + String(n)
  );
  var block = sha256(seed);
  while (off < n) {
    block = sha256(concatBytes([block, seed, new Uint8Array([off & 0xff])]));
    var take = Math.min(32, n - off);
    out.set(block.subarray(0, take), off);
    off += take;
  }
  return out;
}

/** 同步随机数：优先 CSPRNG，最差回退到 SHA-256 混合熵（仅用于本地模拟）。 */
function randomBytes(n) {
  var c = globalCrypto();
  if (c) {
    var out = new Uint8Array(n);
    c.getRandomValues(out);
    return out;
  }
  return fallbackRandom(n);
}

/** 异步随机数：小程序里使用 `wx.getRandomValues`（基础库 2.15.0+）。 */
function randomBytesAsync(n) {
  var c = globalCrypto();
  if (c) {
    try {
      var out = new Uint8Array(n);
      c.getRandomValues(out);
      return Promise.resolve(out);
    } catch (e) {
      /* 继续尝试 wx API */
    }
  }
  if (typeof wx !== "undefined" && wx && typeof wx.getRandomValues === "function") {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (bytes) {
        if (done) return;
        done = true;
        resolve(bytes && bytes.length === n ? bytes : fallbackRandom(n));
      };
      try {
        wx.getRandomValues({
          length: n,
          success: function (res) {
            var buf = res && res.randomValues;
            if (buf) finish(new Uint8Array(buf));
            else finish(null);
          },
          fail: function () {
            finish(null);
          },
        });
      } catch (e) {
        finish(null);
      }
    });
  }
  return Promise.resolve(fallbackRandom(n));
}

// ---------------------------------------------------------------------------
// 登录协议
// ---------------------------------------------------------------------------

/** 解密 `/api/login-try` 的 challengeEncrypt，返回 32 字节挑战。 */
function decryptChallenge(privateBytes, challengeEncryptB64) {
  var raw = b64decode(challengeEncryptB64);
  if (raw.length !== KEY_LEN + NONCE_LEN + CHALLENGE_LEN + TAG_LEN) throw new Error("INVALID_CHALLENGE");
  var ephemeralPub = raw.subarray(0, KEY_LEN);
  var nonce = raw.subarray(KEY_LEN, KEY_LEN + NONCE_LEN);
  var sealed = raw.subarray(KEY_LEN + NONCE_LEN);
  var shared = sharedSecret(privateBytes, ephemeralPub);
  var key = hkdf(shared, new Uint8Array(0), utf8(CHALLENGE_INFO), KEY_LEN);
  var challenge;
  try {
    challenge = aesGcmOpen(key, nonce, sealed);
  } catch (e) {
    throw new Error("WRONG_PASSWORD");
  }
  if (challenge.length !== CHALLENGE_LEN) throw new Error("INVALID_CHALLENGE");
  return challenge;
}

/** 用 `answerEncryptingKey` 加密挑战，返回 base64 的 encryptedAnswer。 */
function encryptAnswer(answerKeyB64, challenge) {
  var key = b64decode(answerKeyB64);
  if (key.length !== KEY_LEN) return Promise.reject(new Error("INVALID_ANSWER_KEY"));
  if (!challenge || challenge.length !== CHALLENGE_LEN) return Promise.reject(new Error("INVALID_CHALLENGE"));
  return randomBytesAsync(NONCE_LEN).then(function (nonce) {
    var sealed = aesGcmSeal(key, nonce, challenge);
    return b64encode(concatBytes([nonce, sealed]));
  });
}

/** 模拟服务端：把挑战加密给公钥（仅离线 mock / 测试使用）。 */
function encryptChallenge(pubkey, challenge) {
  var ephPrivate = randomBytes(32);
  var ephPublic = publicKey(ephPrivate);
  var shared = sharedSecret(ephPrivate, pubkey);
  var key = hkdf(shared, new Uint8Array(0), utf8(CHALLENGE_INFO), KEY_LEN);
  var nonce = randomBytes(NONCE_LEN);
  var sealed = aesGcmSeal(key, nonce, challenge);
  return concatBytes([ephPublic, nonce, sealed]);
}

module.exports = {
  KEY_LEN: KEY_LEN,
  NONCE_LEN: NONCE_LEN,
  TAG_LEN: TAG_LEN,
  CHALLENGE_LEN: CHALLENGE_LEN,
  KDF_ITERATIONS: KDF_ITERATIONS,
  KDF_SALT_PREFIX: KDF_SALT_PREFIX,
  CHALLENGE_INFO: CHALLENGE_INFO,
  utf8: utf8,
  b64encode: b64encode,
  b64decode: b64decode,
  concatBytes: concatBytes,
  bytesToHex: bytesToHex,
  hexToBytes: hexToBytes,
  constantTimeEqual: constantTimeEqual,
  sha256: sha256,
  hmacSha256: hmacSha256,
  pbkdf2: pbkdf2,
  derivePrivateKey: derivePrivateKey,
  defaultSalt: defaultSalt,
  hkdf: hkdf,
  x25519: x25519,
  publicKey: publicKey,
  sharedSecret: sharedSecret,
  validatePublicKey: validatePublicKey,
  aesGcmSeal: aesGcmSeal,
  aesGcmOpen: aesGcmOpen,
  randomBytes: randomBytes,
  randomBytesAsync: randomBytesAsync,
  decryptChallenge: decryptChallenge,
  encryptAnswer: encryptAnswer,
  encryptChallenge: encryptChallenge,
};
