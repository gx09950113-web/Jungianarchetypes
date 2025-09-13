// scripts/build.mjs
// Build pipeline for "榮格八維自測網站"
// - Bundle src -> /docs/assets/js/app.min.js
// - Read local weights & mapping -> gzip + XOR + base64 -> inject as runtime banner
// - Expose window.__getWeights() (async), __getWeightsSync(), __WEIGHTS_JSON / __FUNCS__ / __TYPES__
// - Normalize mapping.funcs into {list,keyToIndex,indexToKey} no matter your local format

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

// ---------------- utils ----------------
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

// ---------------- load local secrets (do NOT commit /local) ----------------
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

  // 簡單標準化 funcs（避免前端再判斷陣列/物件）
  // 支援：
  // - ["Se","Si",...]
  // - { list:[{key,name?,desc?}x8] }
  // - { list:["Se","Si",...]} 也行
  function normalizeFuncs(fx) {
    let list = [];
    if (Array.isArray(fx)) {
      list = fx.map((k, i) => {
        if (typeof k === 'string') return { idx: i, key: k, name: k, desc: '' };
        if (k && typeof k === 'object') return { idx: i, key: k.key, name: k.name || k.key, desc: k.desc || '' };
        return { idx: i, key: `f${i}`, name: `f${i}`, desc: '' };
      });
    } else if (fx && typeof fx === 'object' && Array.isArray(fx.list)) {
      list = fx.list.map((it, i) => {
        if (typeof it === 'string') return { idx: i, key: it, name: it, desc: '' };
        return { idx: i, key: it.key, name: it.name || it.key, desc: it.desc || '' };
      });
    } else {
      // fallback：固定順序
      const def = ['Se','Si','Ne','Ni','Te','Ti','Fe','Fi'];
      list = def.map((k, i) => ({ idx: i, key: k, name: k, desc: '' }));
    }
    const keyToIndex = Object.fromEntries(list.map((f, i) => [f.key, i]));
    const indexToKey = Object.fromEntries(list.map((f, i) => [i, f.key]));
    return { list, keyToIndex, indexToKey };
  }

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
      funcs: normalizeFuncs(funcs),
      types, // 原樣保留（前端會處理 byPair/byDominant/rules/byCodeHint 等）
    },
  };

  return payload;
}

// ---------------- obfuscate payload ----------------
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

// ---------------- compose banner (injected before your bundle) ----------------
function makeBanner(obf) {
  return `
/* weights blob injected at build-time */
(() => {
  const parts = ${JSON.stringify(obf.parts)};
  const key = new Uint8Array(${JSON.stringify(obf.keyArr)});
  const total = ${JSON.stringify(obf.byteLen)};

  let __cache = null;      // 解碼好的 JSON
  let __decoding = null;   // 進行中的 Promise（避免重入）

  // base64 -> Uint8Array（容錯 Node/老瀏覽器）
  function _b64ToBuf(b64) {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const len = bin.length;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // 極少見：沒有 atob（例如某些嵌入 WebView）
    if (typeof Buffer !== 'undefined') {
      return Uint8Array.from(Buffer.from(b64, 'base64'));
    }
    throw new Error('No base64 decoder available');
  }
  function _xor(buf, key) {
    const out = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
    return out;
  }

  async function _gunzip(buf) {
    // 1) 現代瀏覽器：DecompressionStream
    if (typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([buf]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new TextDecoder().decode(new Uint8Array(ab));
    }
    // 2) 回退：pako（等它載入，如果此刻還沒載入，稍微輪詢一下）
    const waitPako = async (ms = 800, step = 50) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (window.pako?.ungzip) return true;
        await new Promise(r => setTimeout(r, step));
      }
      return !!(window.pako?.ungzip);
    };
    if (await waitPako()) {
      return window.pako.ungzip(buf, { to: 'string' });
    }
    throw new Error('No DecompressionStream and no pako. Please load vendor/pako.min.js before app.min.js');
  }

  async function _decodeOnce() {
    if (__cache) return __cache;
    if (__decoding) return __decoding;

    __decoding = (async () => {
      const joined = parts.join('');
      const xored = _b64ToBuf(joined);
      const zipped = _xor(xored, key);
      if (zipped.length !== total) {
        console.warn('[weights] byte length mismatch; got', zipped.length, 'expected', total);
      }
      const jsonStr = await _gunzip(zipped);
      const obj = JSON.parse(jsonStr);

      // 一致性：mapping.funcs 必須有 list/keyToIndex/indexToKey（守護一下）
      const fx = obj?.mapping?.funcs;
      if (!fx || !Array.isArray(fx.list) || !fx.keyToIndex || !fx.indexToKey) {
        const def = ['Se','Si','Ne','Ni','Te','Ti','Fe','Fi'];
        const list = (Array.isArray(fx?.list) ? fx.list : def).map((it, i) => {
          if (typeof it === 'string') return { idx: i, key: it, name: it, desc: '' };
          return { idx: i, key: it.key, name: it.name || it.key, desc: it.desc || '' };
        });
        obj.mapping = obj.mapping || {};
        obj.mapping.funcs = {
          list,
          keyToIndex: Object.fromEntries(list.map((f,i) => [f.key, i])),
          indexToKey: Object.fromEntries(list.map((f,i) => [i, f.key])),
        };
      }

      __cache = obj;

      // 對外同步欄位（有了才設）
      window.__WEIGHTS_JSON = obj;
      window.__FUNCS__ = obj?.mapping?.funcs || {};
      window.__TYPES__ = obj?.mapping?.types || {};

      // 派發 ready 事件（可選）
      try { window.dispatchEvent(new CustomEvent('weights:ready')); } catch {}

      return obj;
    })();

    return __decoding;
  }

  // 對外 API
  window.__getWeights = async () => {
    if (__cache) return __cache;
    return _decodeOnce();
  };
  window.__getWeightsSync = () => {
    if (!__cache) throw new Error('__WEIGHTS_JSON not ready yet; call __getWeights() first.');
    return __cache;
  };

  // 方便舊程式碼：若一切就緒（例如 pako 已先載，且同步可 gunzip），立刻解一次
  // 失敗也無妨，之後呼叫 __getWeights() 仍會再試
  (async () => {
    try {
      await _decodeOnce();
    } catch (e) {
      // 許多行動瀏覽器此時 pako 還沒載入，這裡容忍失敗，不噴錯
      console.info('[weights] will decode lazily later:', e?.message || e);
    }
  })();
})();
`.trim();
}

// ---------------- main build ----------------
async function main() {
  console.log(`[build] mode=${MODE}`);
  await ensureDir(OUT_DIR);

  const payload = await loadLocalPayload();
  const obf = obfuscatePayload(payload);

  // manifest（可選）
  await fs.writeFile(
    path.join(OUT_DIR, 'weights.manifest.json'),
    JSON.stringify({ version: payload.version, ts: payload.ts, byteLen: obf.byteLen }, null, 2),
    'utf8'
  );

  await build({
    entryPoints: [path.join(ROOT, 'src', 'app.js')],
    bundle: true,
    minify: !IS_DEV,
    sourcemap: IS_DEV ? 'inline' : false,
    target: ['es2020'],
    format: 'iife',
    platform: 'browser',
    outfile: OUT_FILE,
    banner: { js: makeBanner(obf) },
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