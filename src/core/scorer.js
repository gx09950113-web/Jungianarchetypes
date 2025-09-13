// src/core/scorer.js
// Score engine: decode obfuscated weights -> compute 8-function scores -> infer type
// Works with QuizEngine.exportAnswers() output: [{ id, value }] where value in 0..4 or 1..5
//
// Public API:
//   await Scorer.init(mode)                    // preload weights & mapping for the mode
//   const result = await Scorer.score({ mode, answers })  // main scoring
//   result schema:
//   {
//     mode,
//     byFunction: [{ idx, key, name, desc, raw, max, pct }], // pct 0..100
//     top: { dominant, auxiliary, tertiary, inferior },      // items from byFunction
//     type: { code, name?, description?, how },              // inferred type
//     axes: { EI: {E,I,pctE}, NS: {...}, TF: {...}, JP: {...} }, // for charts
//     debug?: { perItem: [...], usedItems: number }
//   }

const DEFAULT_FUNC_NAMES = [
  { key: 'Ni', name: '內傾直覺（Ni）' },
  { key: 'Fe', name: '外傾情感（Fe）' },
  { key: 'Ti', name: '內傾思考（Ti）' },
  { key: 'Se', name: '外傾感覺（Se）' },
  { key: 'Ne', name: '外傾直覺（Ne）' },
  { key: 'Fi', name: '內傾情感（Fi）' },
  { key: 'Te', name: '外傾思考（Te）' },
  { key: 'Si', name: '內傾感覺（Si）' },
];

const MODE_TO_FILE = {
  basic: 'weights_32',
  advA: 'weights_adv_A',
  advB: 'weights_adv_B',
  advC: 'weights_adv_C',
};

// extroverted / introverted function index sets（對應 DEFAULT_FUNC_NAMES 的順序）
const EXTV = new Set([1, 3, 4, 6]); // Fe, Se, Ne, Te
const INTV = new Set([0, 2, 5, 7]); // Ni, Ti, Fi, Si
const NSET = new Set([0, 4]);       // Ni, Ne
const SSET = new Set([3, 7]);       // Se, Si
const TSET = new Set([2, 6]);       // Ti, Te
const FSET = new Set([1, 5]);       // Fe, Fi
const JEXT = new Set([1, 6]);       // Je = Fe + Te
const PEXT = new Set([3, 4]);       // Pe = Se + Ne

let _loaded = null; // cache of decoded secret
let _mode = null;
let _weights = null;   // normalized weights for current mode
let _funcMeta = null;  // mapping.funcs
let _typeMap = null;   // mapping.types

// ---- helpers: normalize answer & intensity ----
function normalizeAnswer(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return { dir: 0, mag: 0 };
  // accept 1..5 or 0..4; map to -1..+1 in 0.5 steps
  let v = n;
  if (n >= 1 && n <= 5) v = n - 1; // 1..5 -> 0..4
  const delta = v - 2;             // -2..+2
  const dir = delta === 0 ? 0 : (delta > 0 ? +1 : -1);
  const mag = Math.min(1, Math.abs(delta) / 2); // 0, 0.5, 1
  return { dir, mag };
}

// ---- helpers: weights normalization ----
function indexifyEight(x, nameToIdx) {
  // Accept:
  //  - Array(8) of numbers -> {0:...,1:...}
  //  - Object with "0".."7" keys
  //  - Object keyed by function names ("Ni","Fe",...) -> remap to indices
  if (Array.isArray(x)) {
    const obj = {};
    for (let i = 0; i < 8; i++) obj[i] = Number(x[i] || 0);
    return obj;
  }
  const obj = {};
  const keys = Object.keys(x || {});
  for (const k of keys) {
    if (k in obj) continue;
    if (!isNaN(+k)) {
      obj[+k] = Number(x[k] || 0);
    } else if (nameToIdx && k in nameToIdx) {
      obj[nameToIdx[k]] = Number(x[k] || 0);
    }
  }
  // ensure all 0..7
  for (let i = 0; i < 8; i++) if (!(i in obj)) obj[i] = 0;
  return obj;
}

function pickSideKeys(w) {
  // accept A/B | a/b | pos/neg | agree/disagree
  const k = Object.keys(w || {}).reduce((acc, key) => {
    const low = key.toLowerCase();
    if (!acc.A && (low === 'a' || low === 'pos' || low === 'agree' || low === 'positive')) acc.A = key;
    if (!acc.B && (low === 'b' || low === 'neg' || low === 'disagree' || low === 'negative')) acc.B = key;
    return acc;
  }, { A: null, B: null });
  return k;
}

function normalizeWeightsShape(src, funcMeta) {
  // Return { itemId: { A:{0..7}, B:{0..7} } }
  const nameToIdx = {};
  (funcMeta?.list || DEFAULT_FUNC_NAMES).forEach((f, i) => {
    nameToIdx[f.key] = i;
  });

  const out = {};
  if (Array.isArray(src)) {
    // Accept array entries like {id, A:{...}|pos:{...}, B:{...}|neg:{...}} or {id, side, weights}
    for (const row of src) {
      const id = String(row.id ?? row.qid ?? row.questionId ?? '');
      if (!id) continue;
      if (row.side && row.weights) {
        const side = String(row.side).toUpperCase().startsWith('A') ? 'A' : 'B';
        out[id] = out[id] || { A: {}, B: {} };
        out[id][side] = indexifyEight(row.weights, nameToIdx);
      } else {
        const { A, B } = pickSideKeys(row);
        out[id] = {
          A: indexifyEight(A ? row[A] : row.A || row.pos || row.positive || {}, nameToIdx),
          B: indexifyEight(B ? row[B] : row.B || row.neg || row.negative || {}, nameToIdx),
        };
      }
    }
    return out;
  }
  // Object shape: { [id]: { A:{...}, B:{...} } or variations }
  for (const k of Object.keys(src || {})) {
    const id = String(k);
    const row = src[k] || {};
    const { A, B } = pickSideKeys(row);
    out[id] = {
      A: indexifyEight(A ? row[A] : row.A || row.pos || row.positive || {}, nameToIdx),
      B: indexifyEight(B ? row[B] : row.B || row.neg || row.negative || {}, nameToIdx),
    };
  }
  return out;
}

// ---- helpers: fetch & cache decoded secret ----
async function ensureLoaded(mode) {
  if (!_loaded) _loaded = await window.__getWeights?.();
  if (!_loaded) throw new Error('weights payload not available');
  _funcMeta = normalizeFuncMeta(_loaded?.mapping?.funcs);
  _typeMap = _loaded?.mapping?.types || null;

  if (mode && _mode !== mode) {
    const key = MODE_TO_FILE[mode];
    if (!key) throw new Error(`Unknown mode: ${mode}`);
    _weights = normalizeWeightsShape(_loaded?.weights?.[key], _funcMeta);
    _mode = mode;
  }
}

function normalizeFuncMeta(funcs) {
  // expect { list: [{key,name,desc}], indexToKey?: {...}, keyToIndex?: {...} }
  if (funcs?.list && Array.isArray(funcs.list) && funcs.list.length >= 8) return funcs;
  return {
    list: DEFAULT_FUNC_NAMES.map((f, i) => ({ idx: i, key: f.key, name: f.name, desc: '' })),
    indexToKey: Object.fromEntries(DEFAULT_FUNC_NAMES.map((f, i) => [i, f.key])),
    keyToIndex: Object.fromEntries(DEFAULT_FUNC_NAMES.map((f, i) => [f.key, i])),
  };
}

// ---- axis aggregation helpers ----
function agg(set, arr) {
  let s = 0, m = 0;
  for (let i = 0; i < 8; i++) {
    if (set.has(i)) { s += arr[i].raw; m += arr[i].max; }
  }
  const pct = m > 0 ? (s / m) : 0;
  return { score: s, max: m, pct };
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// ---- type inference ----
function inferType(byFunction, typesMap) {
  const sorted = [...byFunction].sort((a, b) => b.pct - a.pct);
  const dom = sorted[0], aux = sorted[1], ter = sorted[2], inf = sorted[3];
  let type = { code: 'Unknown', how: 'fallback' };

  if (typesMap) {
    // 1) byPair: types.byPair["dom-aux"] = { code, name?, description? }
    const dm = typesMap.byPair || typesMap.pairs;
    if (dm) {
      const k1 = `${dom.idx}-${aux.idx}`;
      const k2 = `${aux.idx}-${dom.idx}`;
      if (dm[k1]) type = { ...dm[k1], how: 'byPair' };
      else if (dm[k2]) type = { ...dm[k2], how: 'byPair' };
    }
    // 2) byDominant: types.byDominant[idx] = { code,... }
    if (type.code === 'Unknown' && typesMap.byDominant) {
      if (typesMap.byDominant[dom.idx]) {
        type = { ...typesMap.byDominant[dom.idx], how: 'byDominant' };
      }
    }
    // 3) rules: [{if:{dom:idx,aux:idx?}, code,...}]
    if (type.code === 'Unknown' && Array.isArray(typesMap.rules)) {
      for (const r of typesMap.rules) {
        const okDom = r.if?.dom === undefined || r.if.dom === dom.idx;
        const okAux = r.if?.aux === undefined || r.if.aux === aux.idx;
        if (okDom && okAux) { type = { code: r.code, name: r.name, description: r.description, how: 'rules' }; break; }
      }
    }
  }

  // 4) hard fallback: function-key heuristic → 推導 4-letter（僅供臨時，建議用 mapping.types 覆蓋）
  if (type.code === 'Unknown') {
    const e = agg(EXTV, byFunction).pct;
    const n = agg(NSET, byFunction).pct;
    const t = agg(TSET, byFunction).pct;
    const j = agg(JEXT, byFunction).pct; // 以 Je vs Pe 略估 J/P（僅近似）
    const letters =
      (e >= 0.5 ? 'E' : 'I') +
      (n >= 0.5 ? 'N' : 'S') +
      (t >= 0.5 ? 'T' : 'F') +
      (j >= 0.5 ? 'J' : 'P');
    type = { code: letters, name: undefined, description: undefined, how: 'heuristic' };
  }

  return { type, top: { dominant: dom, auxiliary: aux, tertiary: ter, inferior: inf } };
}

// ---- main score ----
export const Scorer = {
  async init(mode) {
    await ensureLoaded(mode);
  },

  /**
   * answers: [{id, value}] where value in 0..4 or 1..5 (null allowed -> skipped)
   * mode: 'basic' | 'advA' | 'advB' | 'advC'
   */
  async score({ mode, answers }) {
    await ensureLoaded(mode);
    const weights = _weights || {};
    const funcList = _funcMeta.list || DEFAULT_FUNC_NAMES.map((f, i) => ({ idx: i, key: f.key, name: f.name, desc: '' }));

    // init accumulators
    const raw = Array(8).fill(0);
    const max = Array(8).fill(0);

    // optional: per-item debug
    const perItem = [];

    let used = 0;
    for (const { id, value } of answers || []) {
      if (value === null || value === undefined) continue;
      const wid = weights[String(id)];
      if (!wid) { // 沒有對應權重 → 跳過
        perItem.push({ id, skipped: true });
        continue;
      }
      const { dir, mag } = normalizeAnswer(value);
      if (mag === 0 || dir === 0) { // 中立 → 不計
        perItem.push({ id, neutral: true });
        continue;
      }
      const side = dir > 0 ? 'A' : 'B';
      const opp  = 'A' === side ? 'B' : 'A';
      const vec = wid[side] || {};
      const vmax = wid.A && wid.B ? (i) => Math.max(Number(wid.A[i]||0), Number(wid.B[i]||0)) : (i) => Number(vec[i]||0);

      for (let i = 0; i < 8; i++) {
        const w = Number(vec[i] || 0);
        raw[i] += mag * w;
        max[i] += vmax(i); // 以該題兩端的較大值當作此題在此功能上的理論上限
      }
      used++;
      perItem.push({ id, side, mag, applied: true });
    }

    const byFunction = raw.map((r, i) => {
      const m = max[i] || 1e-9;
      const pct = clamp01(r / m);
      const meta = funcList[i] || { key: `f${i}`, name: `Function ${i}`, desc: '' };
      return {
        idx: i,
        key: meta.key || `f${i}`,
        name: meta.name || `Function ${i}`,
        desc: meta.desc || '',
        raw: r,
        max: m,
        pct: pct * 100,
      };
    });

    // axes
    const EI = agg(EXTV, byFunction);
    const NS = agg(NSET, byFunction);
    const TF = agg(TSET, byFunction);
    const JP = { // Je vs Pe 近似
      ...agg(JEXT, byFunction),
      pe: agg(PEXT, byFunction),
    };
    const axes = {
      EI: { E: EI.pct, I: 1 - EI.pct, pctE: EI.pct },
      NS: { N: NS.pct, S: 1 - NS.pct, pctN: NS.pct },
      TF: { T: TF.pct, F: 1 - TF.pct, pctT: TF.pct },
      JP: { J: JP.pct, P: 1 - JP.pct, pctJ: JP.pct }, // 僅近似，正式 J/P 仍建議用 types 規則
    };

    // type inference
    const { type, top } = inferType(byFunction, _typeMap);

    return {
      mode,
      byFunction,
      top,
      type,
      axes,
      debug: { perItem, usedItems: used },
    };
  },

  // 取用功能對照原資料（供 report/charts 使用）
  getFuncMeta() {
    return _funcMeta;
  },

  // 取用類型對照（若要自定義報告敘述）
  getTypeMap() {
    return _typeMap;
  },
};
