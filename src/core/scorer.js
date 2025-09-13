// src/core/scorer.js
// Score engine: decode obfuscated weights -> compute 8-function scores -> infer type
// Works with QuizEngine.exportAnswers() output:
//   - Array<number|null>                       // 以出題順序存值（-2..2 或 1..5 或 0..4）
//   - Array<{ id: string|number, value: any }> // 題目含 id（建議）
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

const DEFAULT_FUNC_LIST = [
  { key: 'Se', name: '外傾感覺（Se）' },
  { key: 'Si', name: '內傾感覺（Si）' },
  { key: 'Ne', name: '外傾直覺（Ne）' },
  { key: 'Ni', name: '內傾直覺（Ni）' },
  { key: 'Te', name: '外傾思考（Te）' },
  { key: 'Ti', name: '內傾思考（Ti）' },
  { key: 'Fe', name: '外傾情感（Fe）' },
  { key: 'Fi', name: '內傾情感（Fi）' },
];

const MODE_TO_FILE = {
  basic: 'weights_32',
  advA: 'weights_adv_A',
  advB: 'weights_adv_B',
  advC: 'weights_adv_C',
};

// ---- internal state ----
let _loaded = null;   // full payload from window.__getWeights()
let _mode = null;
let _weights = null;  // normalized weights for current mode  -> { [id:string]: {A:{0..7}, B:{0..7}} }
let _funcMeta = null; // { list:[{idx,key,name,desc}...], keyToIndex, indexToKey }
let _typeMap = null;  // mapping.types
let _sets = null;     // index sets derived from func keys（避免索引順序依賴）

/* ---------------- helpers: answers ---------------- */
function normalizeAnswer(value) {
  // 支援 -2..2 或 1..5 或 0..4，統一成 dir (-1/0/+1) 與 mag (0/0.5/1)
  if (value === null || value === undefined) return { dir: 0, mag: 0 };
  const n = Number(value);
  if (Number.isNaN(n)) return { dir: 0, mag: 0 };

  // 轉成 0..4
  let v = n;
  if (n >= 1 && n <= 5) v = n - 1;      // 1..5 -> 0..4
  if (n >= -2 && n <= 2) v = n + 2;     // -2..2 -> 0..4
  const delta = v - 2;                  // -2..+2
  const dir = delta === 0 ? 0 : (delta > 0 ? +1 : -1);
  const mag = Math.min(1, Math.abs(delta) / 2); // 0, 0.5, 1
  return { dir, mag };
}

function normalizeAnswersInput(answers) {
  // 接受兩種：陣列值 或 陣列物件（含 id/value）
  if (!Array.isArray(answers)) return [];
  // case A: [{id,value}, ...]
  if (answers.length && typeof answers[0] === 'object' && 'id' in answers[0]) {
    return answers.map(a => ({ id: String(a.id), value: a.value }));
  }
  // case B: [n, n, n, ...]（用索引當 id）
  return answers.map((v, i) => ({ id: String(i), value: v }));
}

/* ---------------- helpers: weights ---------------- */
function normalizeFuncMeta(funcs) {
  // 期望：{ list:[{key,name,desc}x8], ... }
  const list = (funcs?.list && funcs.list.length >= 8)
    ? funcs.list.map((f, i) => ({ idx: i, key: f.key, name: f.name || f.key, desc: f.desc || '' }))
    : DEFAULT_FUNC_LIST.map((f, i) => ({ idx: i, key: f.key, name: f.name, desc: '' }));

  const keyToIndex = Object.fromEntries(list.map((f, i) => [f.key, i]));
  const indexToKey = Object.fromEntries(list.map((f, i) => [i, f.key]));
  return { list, keyToIndex, indexToKey };
}

function buildIndexSets(funcMeta) {
  // 依據「功能 key」找到其索引：避免權重/對照檔的功能順序差異造成錯配
  const k2i = funcMeta.keyToIndex || {};
  const idx = (k) => (k2i[k] ?? -1);

  const Fe = idx('Fe'), Te = idx('Te'), Se = idx('Se'), Ne = idx('Ne');
  const Fi = idx('Fi'), Ti = idx('Ti'), Si = idx('Si'), Ni = idx('Ni');

  const set = (...xs) => new Set(xs.filter(i => i >= 0));

  return {
    EXTV: set(Fe, Te, Se, Ne),   // 外向功能
    INTV: set(Fi, Ti, Si, Ni),   // 內向功能
    NSET: set(Ni, Ne),
    SSET: set(Se, Si),
    TSET: set(Ti, Te),
    FSET: set(Fe, Fi),
    JEXT: set(Fe, Te),           // 判斷（外向判斷）≈ Je
    PEXT: set(Se, Ne),           // 知覺（外向知覺）≈ Pe
  };
}

function pickSideKeys(w) {
  // 接受 A/B | a/b | pos/neg | positive/negative | agree/disagree
  const keys = Object.keys(w || {});
  let kA = null, kB = null;
  for (const key of keys) {
    const low = key.toLowerCase();
    if (!kA && (low === 'a' || low === 'pos' || low === 'positive' || low === 'agree')) kA = key;
    if (!kB && (low === 'b' || low === 'neg' || low === 'negative' || low === 'disagree')) kB = key;
  }
  return { A: kA, B: kB };
}

function indexifyEight(x, nameToIdx) {
  // 接受：
  //  - Array(8) -> 依索引
  //  - Object: {0:..,1:..} 或 {"Se":..,"Si":..} -> 轉換到 idx
  const out = Array(8).fill(0);
  if (!x) return Object.fromEntries(out.map((_, i) => [i, 0]));

  if (Array.isArray(x)) {
    for (let i = 0; i < 8; i++) out[i] = Number(x[i] || 0);
    return Object.fromEntries(out.map((v, i) => [i, v]));
  }

  // object
  for (const k of Object.keys(x)) {
    if (!isNaN(+k)) {
      out[+k] = Number(x[k] || 0);
    } else if (nameToIdx && (k in nameToIdx)) {
      out[nameToIdx[k]] = Number(x[k] || 0);
    }
  }
  return Object.fromEntries(out.map((v, i) => [i, v]));
}

function normalizeWeightsShape(src, funcMeta) {
  // 統一成：{ [id:string]: { A:{0..7}, B:{0..7} } }
  const nameToIdx = funcMeta.keyToIndex || {};
  const out = {};

  if (!src) return out;

  if (Array.isArray(src)) {
    // 可能是「依出題順序」的陣列
    for (let i = 0; i < src.length; i++) {
      const row = src[i] || {};
      const id = String(row.id ?? row.qid ?? row.questionId ?? i);

      if (row.side && row.weights) {
        // { id, side: 'A'|'B', weights: [...] } -> 合併
        const side = String(row.side).toUpperCase().startsWith('A') ? 'A' : 'B';
        out[id] = out[id] || { A: {}, B: {} };
        out[id][side] = indexifyEight(row.weights, nameToIdx);
      } else if (row.A || row.B || row.pos || row.neg || row.positive || row.negative) {
        const pick = pickSideKeys(row);
        out[id] = {
          A: indexifyEight(pick.A ? row[pick.A] : (row.A || row.pos || row.positive || {}), nameToIdx),
          B: indexifyEight(pick.B ? row[pick.B] : (row.B || row.neg || row.negative || {}), nameToIdx),
        };
      } else if (Array.isArray(row)) {
        // 純陣列（少見）：當作單側，另一側 0
        out[id] = {
          A: indexifyEight(row, nameToIdx),
          B: indexifyEight(Array(8).fill(0), nameToIdx),
        };
      }
    }
    return out;
  }

  // 物件：{ [id]: { A:{}, B:{} } 或變體 }
  for (const k of Object.keys(src)) {
    const id = String(k);
    const row = src[k] || {};
    if (row.side && row.weights) {
      const side = String(row.side).toUpperCase().startsWith('A') ? 'A' : 'B';
      out[id] = out[id] || { A: {}, B: {} };
      out[id][side] = indexifyEight(row.weights, nameToIdx);
    } else {
      const pick = pickSideKeys(row);
      out[id] = {
        A: indexifyEight(pick.A ? row[pick.A] : (row.A || row.pos || row.positive || {}), nameToIdx),
        B: indexifyEight(pick.B ? row[pick.B] : (row.B || row.neg || row.negative || {}), nameToIdx),
      };
    }
  }
  return out;
}

/* ---------------- helpers: load/cache ---------------- */
async function ensureLoaded(mode) {
  if (!_loaded) {
    // 支援同步或非同步的 __getWeights
    const maybe = window.__getWeights?.();
    _loaded = (maybe && typeof maybe.then === 'function') ? await maybe : maybe;
  }
  if (!_loaded) throw new Error('weights payload not available (window.__getWeights not ready)');

  _funcMeta = normalizeFuncMeta(_loaded?.mapping?.funcs);
  _typeMap  = _loaded?.mapping?.types || null;
  _sets     = buildIndexSets(_funcMeta);

  if (mode && _mode !== mode) {
    const key = MODE_TO_FILE[mode];
    if (!key) throw new Error(`Unknown mode: ${mode}`);
    _weights = normalizeWeightsShape(_loaded?.weights?.[key], _funcMeta);
    _mode = mode;
  }
}

/* ---------------- helpers: axis & math ---------------- */
function agg(indexSet, byFuncArr) {
  let s = 0, m = 0;
  for (let i = 0; i < byFuncArr.length; i++) {
    if (indexSet.has(i)) { s += byFuncArr[i].raw; m += byFuncArr[i].max; }
  }
  const pct = m > 0 ? (s / m) : 0;
  return { score: s, max: m, pct };
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

/* ---------------- type inference ---------------- */
function inferType(byFunction, typesMap, sets) {
  const sorted = [...byFunction].sort((a, b) => b.pct - a.pct);
  const dom = sorted[0], aux = sorted[1], ter = sorted[2], inf = sorted[3];
  let type = { code: 'Unknown', how: 'fallback' };

  if (typesMap) {
    // 1) byPair：types.byPair["dom-aux"] = { code, name?, description? }
    const dm = typesMap.byPair || typesMap.pairs;
    if (dm) {
      const k1 = `${dom.idx}-${aux.idx}`;
      const k2 = `${aux.idx}-${dom.idx}`;
      if (dm[k1]) type = { ...dm[k1], how: 'byPair' };
      else if (dm[k2]) type = { ...dm[k2], how: 'byPair' };
    }
    // 2) byDominant：types.byDominant[idx] = { code,... }
    if (type.code === 'Unknown' && typesMap.byDominant) {
      if (typesMap.byDominant[dom.idx]) {
        type = { ...typesMap.byDominant[dom.idx], how: 'byDominant' };
      }
    }
    // 3) rules：[{if:{dom:idx,aux:idx?}, code,...}]
    if (type.code === 'Unknown' && Array.isArray(typesMap.rules)) {
      for (const r of typesMap.rules) {
        const okDom = r?.if?.dom === undefined || r.if.dom === dom.idx;
        const okAux = r?.if?.aux === undefined || r.if.aux === aux.idx;
        if (okDom && okAux) { type = { code: r.code, name: r.name, description: r.description, how: 'rules' }; break; }
      }
    }
    // 4) byCode（若內含推導規則你也可直接給 .byCodeHint）
    if (type.code === 'Unknown' && typesMap.byCodeHint) {
      const hint = typesMap.byCodeHint({ byFunction, dom, aux });
      if (hint && hint.code) type = { ...hint, how: 'byCodeHint' };
    }
  }

  // 5) hard fallback：以功能集合近似 4-letter
  if (type.code === 'Unknown') {
    const E = agg(sets?.EXTV || new Set(), byFunction).pct;
    const N = agg(sets?.NSET || new Set(), byFunction).pct;
    const T = agg(sets?.TSET || new Set(), byFunction).pct;
    const J = agg(sets?.JEXT || new Set(), byFunction).pct; // 近似
    const letters =
      (E >= 0.5 ? 'E' : 'I') +
      (N >= 0.5 ? 'N' : 'S') +
      (T >= 0.5 ? 'T' : 'F') +
      (J >= 0.5 ? 'J' : 'P');
    type = { code: letters, name: undefined, description: undefined, how: 'heuristic' };
  }

  return { type, top: { dominant: dom, auxiliary: aux, tertiary: ter, inferior: inf } };
}

/* ---------------- main score ---------------- */
export const Scorer = {
  async init(mode) {
    await ensureLoaded(mode);
  },

  /**
   * answers: Array<number|null> 或 Array<{id,value}>
   * mode: 'basic' | 'advA' | 'advB' | 'advC'
   */
  async score({ mode, answers }) {
    await ensureLoaded(mode);
    const weights = _weights || {};
    const funcList = _funcMeta.list || DEFAULT_FUNC_LIST.map((f, i) => ({ idx: i, key: f.key, name: f.name, desc: '' }));
    const nameToIdx = _funcMeta.keyToIndex || {};

    // 規整答案
    const arrAns = normalizeAnswersInput(answers);

    // 累加器
    const raw = Array(8).fill(0);
    const max = Array(8).fill(0);
    const perItem = [];
    let used = 0;

    for (const { id, value } of arrAns) {
      if (value === null || value === undefined) continue;
      const wid = weights[String(id)];
      if (!wid) { perItem.push({ id, skipped: true }); continue; }

      const { dir, mag } = normalizeAnswer(value);
      if (mag === 0 || dir === 0) { perItem.push({ id, neutral: true }); continue; }

      const side = dir > 0 ? 'A' : 'B';
      const vec = wid[side] || {};
      const vmax = (i) => {
        const a = Number((wid.A || {})[i] || 0);
        const b = Number((wid.B || {})[i] || 0);
        return Math.max(a, b);
      };

      for (let i = 0; i < 8; i++) {
        const w = Number(vec[i] || 0);
        raw[i] += mag * w;
        max[i] += vmax(i);
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

    // 四軸（以功能集合聚合；避免索引順序差異）
    const EI = agg(_sets.EXTV, byFunction);
    const NS = agg(_sets.NSET, byFunction);
    const TF = agg(_sets.TSET, byFunction);
    const JPj = agg(_sets.JEXT, byFunction); // Je
    const JPp = agg(_sets.PEXT, byFunction); // Pe
    const sumJP = JPj.max + JPp.max || 1e-9;
    const pctJ = (JPj.score) / (JPj.score + JPp.score || 1e-9); // 以實際得分近似

    const axes = {
      EI: { E: EI.pct, I: 1 - EI.pct, pctE: EI.pct },
      NS: { N: NS.pct, S: 1 - NS.pct, pctN: NS.pct },
      TF: { T: TF.pct, F: 1 - TF.pct, pctT: TF.pct },
      JP: { J: pctJ,  P: 1 - pctJ,   pctJ },
    };

    // 類型推論
    const { type, top } = inferType(byFunction, _typeMap, _sets);

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