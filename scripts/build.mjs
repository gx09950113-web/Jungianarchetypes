// scripts/build.mjs
// Build pipeline for "榮格八維自測網站"
// - Bundle src -> /docs/assets/js/app.min.js
// - Read local weights & mapping -> gzip + XOR + base64 -> inject as runtime banner
// - Expose window.__getWeights() for scorer.js to decode at runtime

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(process.cwd());
const OUT_DIR = path.join(ROOT, 'docs', 'assets', 'js');
const OUT_FILE = path.join(OUT_DIR, 'app.min.js');

const MODE = process.env.NODE_ENV?.toLowerCase() === 'development' ? 'development' : 'production';
const IS_DEV = MODE === 'development';

// ---- utils ----
async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}
async function readJSON(p) {
  const buf = await fs.readFile(p);
  return JSON.parse(buf.toString('utf8'));
}
function toUint8(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (Buffer.isBuffer(input)) return input;
  throw new TypeError('toUint8 expects string or Buffer');
}
function gzip(buf) {
  return zlib.gzipSync(buf);
}
function xorBytes(buf, keyBytes) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ keyBytes[i % keyBytes.length];
  }
  return out;
}
function b64(buf) {
  return Buffer.from(buf).toString('base64');
}
function chunkString(str, n = 128) {
  const arr = [];
  for (let i = 0; i < str.length; i += n) arr.push(str.slice(i, i + n));
  return arr;
}

// ---- load local secrets (do NOT commit /local) ----
async function loadLocalPayload() {
  const weightsDir = path.join(ROOT, 'local', 'weights');
  const mappingDir = path.join(ROOT, 'local', 'mapping');

  const [
    w32,
    wA,
    wB,
    wC,
    funcs,
    types
  ] = await Promise.all([
    readJSON(path.join(weightsDir, 'weights_32.json')),
    readJSON(path.join(weightsDir, 'weights_adv_A.json')),
    readJSON(path.join(weightsDir, 'weights_adv_B.json')),
    readJSON(path.join(weightsDir, 'weights_adv_C.json')),
    readJSON(path.join(mappingDir, 'funcs.json')),
    readJSON(path.join(mappingDir, 'types.json')),
  ]);

  const payload = {
    version: 1,
    ts: new Date().toISOString(),
    weights: {
      weights_32: w32,
      weights_adv_A: wA,
      weights_adv_B: wB,
      weights_adv_C: wC,
    },
    mapping: { funcs, types },
  };

  return payload;
}

// ---- obfuscate payload ----
function obfuscatePayload(payloadObj) {
  const json = JSON.stringify(payloadObj);
  const gz = gzip(toUint8(json));

  // 16-byte random key (fixed per build)
  const key = crypto.getRandomValues(new Uint8Array(16));
  const keyArr = Array.from(key);

  const xored = xorBytes(gz, Buffer.from(key));
  const base64 = b64(xored);

  // 製造一點讀取干擾（分段）
  const parts = chunkString(base64, 256);

  return {
    keyArr,            // number[]
    parts,             // string[]
    byteLen: gz.length // for sanity check
  };
}

// ---- compose banner (injected before your bundle) ----
function makeBanner(obf) {
  // 不暴露關鍵字樣，包在 IIFE 與本地閉包中
  return `
/* weights blob injected at build-time */
(() => {
  const parts = ${JSON.stringify(obf.parts)};
  const key = new Uint8Array(${JSON.stringify(obf.keyArr)});
  const total = ${JSON.stringify(obf.byteLen)};

  function _b64ToBuf(b64) {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const len = bin.length;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
      return out;
    } else {
      // Node fallback (unlikely on client)
      return Uint8Array.from(Buffer.from(b64, 'base64'));
    }
  }
  function _concatStr(arr) {
    // 微小混淆：在連接前做一個不起眼的 reduce
    return arr.reduce((acc, s) => acc + s, '');
  }
  function _xor(buf, key) {
    const out = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
    return out;
  }
  function _gunzip(buf) {
    // Browser: use CompressionStream if可用，否則用 pako（若你想改）；
    // 為了零依賴，這裡實作一個輕量 gunzip 方案：使用 Web Streams API
    // 但 Safari 可能不支援，保留一個動態載入的回退（需你自行加 vendor/pako）
    if (typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([buf]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer();
    }
    // 回退：嘗試使用全域 pako（若你在 vendor 放了 pako）
    if (typeof window !== 'undefined' && window.pako?.ungzip) {
      return Promise.resolve(window.pako.ungzip(buf, { to: 'string' }));
    }
    // 最後回退：直接拋錯，並提示需要加 vendor/pako
    return Promise.reject(new Error('No DecompressionStream and no pako. Add pako or use modern browsers.'));
  }

  let _cache = null;

  async function __decodeWeights() {
    if (_cache) return _cache;

    // 1) 拼接 base64
    const joined = _concatStr(parts);

    // 2) base64 -> bytes
    const xored = _b64ToBuf(joined);

    // 3) XOR decode
    const zipped = _xor(xored, key);

    if (zipped.length !== total) {
      console.warn('[weights] byte length mismatch; got', zipped.length, 'expected', total);
    }

    // 4) gunzip -> string
    let raw;
    const gunz = await _gunzip(zipped);
    if (typeof gunz === 'string') {
      raw = gunz;
    } else {
      raw = new TextDecoder().decode(new Uint8Array(gunz));
    }

    // 5) parse JSON
    _cache = JSON.parse(raw);
    return _cache;
  }

  // 對外只暴露一個乾淨的 API
  window.__getWeights = async () => {
    return __decodeWeights();
  };
})();
`.trim();
}

// ---- main build ----
async function main() {
  console.log(`[build] mode=${MODE}`);
  await ensureDir(OUT_DIR);

  const payload = await loadLocalPayload();
  const obf = obfuscatePayload(payload);

  // 寫 manifest（可選，方便你看看版本/時間戳）
  await fs.writeFile(
    path.join(OUT_DIR, 'weights.manifest.json'),
    JSON.stringify({ version: payload.version, ts: payload.ts, byteLen: obf.byteLen }, null, 2),
    'utf8'
  );

  // esbuild 設定
  await build({
    entryPoints: [path.join(ROOT, 'src', 'app.js')],
    bundle: true,
    minify: !IS_DEV,
    sourcemap: IS_DEV ? 'inline' : false,
    target: ['es2020'],
    format: 'iife',
    platform: 'browser',
    outfile: OUT_FILE,
    // 把解碼器與 blob 放在 bundle 最前面
    banner: { js: makeBanner(obf) },
    // 視你的使用方式調整 external（如果 Chart.js 走 <script> 載入全域，則保持 external）
    external: [],
    define: {
      'process.env.NODE_ENV': JSON.stringify(MODE),
    },
    logLevel: 'info',
  });

  console.log(`[build] done → ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
