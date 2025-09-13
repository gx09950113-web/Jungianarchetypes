// scripts/build.mjs
// Build pipeline for "榮格八維自測網站"
// - Bundle src -> /docs/assets/js/app.min.js
// - Read local weights & mapping -> gzip + XOR + base64 -> inject as runtime banner
// - Expose window.__WEIGHTS_JSON / __FUNCS__ / __TYPES__ / __getWeights()

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(process.cwd());
const OUT_DIR = path.join(ROOT, 'docs', 'assets', 'js');
const OUT_FILE = path.join(OUT_DIR, 'app.min.js');

const MODE = (process.env.NODE_ENV?.toLowerCase() === 'development') ? 'development' : 'production';
const IS_DEV = MODE === 'development';

// ---- utils ----
async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}
async function readJSON(p) {
  const buf = await fs.readFile(p);
  return JSON.parse(buf.toString('utf8'));
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
function chunkString(str, n = 256) {
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

  // 給前端的總包（注意：仍是機密，已在前端以 gzip+XOR+b64 混淆）
  const payload = {
    version: 1,
    ts: new Date().toISOString(),
    weights: {
      weights_32: w32,
      weights_adv_A: wA,
      weights_adv_B: wB,
      weights_adv_C: wC,
    },
    mapping: {
      funcs, // ["Se","Si","Ne","Ni","Te","Ti","Fe","Fi"]
      types, // 你的 MBTI 對照/解釋物件（report.js 會用）
    },
  };

  return payload;
}

// ---- obfuscate payload ----
function obfuscatePayload(payloadObj) {
  const json = JSON.stringify(payloadObj);
  const gz = gzip(Buffer.from(json, 'utf8'));

  // 16-byte random key (fixed per build)
  const key = randomBytes(16);
  const keyArr = Array.from(key.values());

  const xored = xorBytes(gz, key);
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
  // 這段會插在 bundle 最前面執行：
  // - 同步使用 pako 解碼（請確保頁面於 app.min.js 之前已載入 pako.min.js）
  // - 生成 window.__WEIGHTS_JSON / __FUNCS__ / __TYPES__ / __getWeights()
  return `
/* weights blob injected at build-time */
(() => {
  // 混淆資料
  const parts = ${JSON.stringify(obf.parts)};
  const key = new Uint8Array(${JSON.stringify(obf.keyArr)});
  const total = ${JSON.stringify(obf.byteLen)};

  // base64 -> Uint8Array
  function _b64ToBuf(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // XOR 還原
  function _xor(buf, key) {
    const out = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
    return out;
  }

  // 直接嘗試同步解碼（依賴 window.pako.ungzip）
  try {
    const joined = parts.join('');
    const xored = _b64ToBuf(joined);
    const zipped = _xor(xored, key);
    if (zipped.length !== total) {
      console.warn('[weights] byte length mismatch; got', zipped.length, 'expected', total);
    }

    // 需要先載入 pako.min.js（在 HTML 中於 app.min.js 之前載入）
    if (!window.pako || typeof window.pako.ungzip !== 'function') {
      console.warn('[weights] pako not found; cannot decode weights now. Ensure pako.min.js is loaded before app.min.js');
      return;
    }

    const jsonStr = window.pako.ungzip(zipped, { to: 'string' });
    const obj = JSON.parse(jsonStr);

    // 對外暴露：同步可得
    window.__WEIGHTS_JSON = obj;                 // { version, ts, weights:{...}, mapping:{ funcs, types } }
    window.__FUNCS__ = obj?.mapping?.funcs || []; // ["Se","Si","Ne","Ni","Te","Ti","Fe","Fi"]
    window.__TYPES__ = obj?.mapping?.types || {}; // MBTI 對照/解釋
    window.__getWeights = function(){ return window.__WEIGHTS_JSON; }; // 與你現有 app.min.js 相容（同步）

  } catch (e) {
    console.error('[weights] decode failed:', e);
  }
})();
`.trim();
}

// ---- main build ----
async function main() {
  console.log(`[build] mode=${MODE}`);
  await ensureDir(OUT_DIR);

  const payload = await loadLocalPayload();
  const obf = obfuscatePayload(payload);

  //（可選）寫 manifest 方便檢查版本/時間
  await fs.writeFile(
    path.join(OUT_DIR, 'weights.manifest.json'),
    JSON.stringify({ version: payload.version, ts: payload.ts, byteLen: obf.byteLen }, null, 2),
    'utf8'
  );

  // esbuild
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

    // 若你的外部資源用 <script> 載入（Chart.js / pako），保持 empty
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