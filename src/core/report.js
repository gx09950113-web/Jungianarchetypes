// src/core/report.js
// Generate human-readable narratives and tables from Scorer.score(...) result.
// This module does NOT touch the DOM directly; it returns strings/structures.
// UI 層（render-result.js）自行決定如何插入頁面。

import { Scorer } from './scorer.js';

/* ========== helpers ========== */
function round(n, d = 0) {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
}
function pct(n, d = 0) {
  return `${round(n, d)}%`;
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function byIdx(arr, i, fb) {
  return (arr && arr[i] !== undefined) ? arr[i] : fb;
}
const OPP = { 0: 3, 1: 2, 2: 1, 3: 0, 4: 7, 5: 6, 6: 5, 7: 4 };

/** 作為 funcs.json 缺席時的回退（順序僅作占位，不影響最終顯示，因優先讀 Scorer meta） */
const FALLBACK_FUNCS = [
  { idx: 0, key: 'Se', name: '外傾感覺（Se）', desc: '' },
  { idx: 1, key: 'Si', name: '內傾感覺（Si）', desc: '' },
  { idx: 2, key: 'Ne', name: '外傾直覺（Ne）', desc: '' },
  { idx: 3, key: 'Ni', name: '內傾直覺（Ni）', desc: '' },
  { idx: 4, key: 'Te', name: '外傾思考（Te）', desc: '' },
  { idx: 5, key: 'Ti', name: '內傾思考（Ti）', desc: '' },
  { idx: 6, key: 'Fe', name: '外傾情感（Fe）', desc: '' },
  { idx: 7, key: 'Fi', name: '內傾情感（Fi）', desc: '' },
];

/* 取得 funcs/type 對照（優先 Scorer，其次 window.__FUNCS__/__TYPES__） */
function getFuncList() {
  const meta = (typeof Scorer.getFuncMeta === 'function') ? Scorer.getFuncMeta() : null;
  const fromScorer = meta?.list && meta.list.length >= 8 ? meta.list : null;
  const fromWindow = (Array.isArray(window?.__FUNCS__) && window.__FUNCS__.length >= 8)
    ? window.__FUNCS__.map((k, i) => ({ idx: i, key: k, name: k, desc: '' }))
    : null;
  const list = fromScorer || fromWindow || FALLBACK_FUNCS;
  return list.map((it, i) => ({
    idx: i,
    key: it.key ?? `f${i}`,
    name: it.name ?? it.key ?? `功能 ${i}`,
    desc: it.desc ?? '',
  }));
}
function getTypeMap() {
  const fromScorer = (typeof Scorer.getTypeMap === 'function') ? Scorer.getTypeMap() : null;
  const fromWindow = window?.__TYPES__ || null;
  // 統一結構：{ byCode: { ENTP: { code, name, description: string|string[] } } }
  if (fromScorer?.byCode) return fromScorer;
  if (fromWindow?.byCode) return fromWindow;
  if (fromWindow && !fromWindow.byCode) {
    // 若是簡單 {ENTP:{...}} 也包裝一下
    return { byCode: fromWindow };
  }
  return { byCode: {} };
}

/* 一句話四軸描述 */
function axesOneLiner(axes) {
  const E = axes?.EI?.pctE ?? 0.5;
  const N = axes?.NS?.pctN ?? 0.5;
  const T = axes?.TF?.pctT ?? 0.5;
  const J = axes?.JP?.pctJ ?? 0.5;
  const letter = (p, a, b) => (p >= 0.5 ? a : b);
  const code = `${letter(E, 'E', 'I')}${letter(N, 'N', 'S')}${letter(T, 'T', 'F')}${letter(J, 'J', 'P')}`;
  return {
    codeGuess: code,
    line: `傾向${letter(E,'外向','內向')}、偏${letter(N,'直覺','感覺')}、決策偏${letter(T,'理性','情感')}、生活偏${letter(J,'規劃','彈性')}`,
    percents: { E: round(E*100), N: round(N*100), T: round(T*100), J: round(J*100) },
  };
}

/* 主輔功能信心估計：看主輔與後續差距 */
function confidence(byFunction) {
  if (!Array.isArray(byFunction) || byFunction.length < 3) return { score: 0.5, label: '一般', details: { gap1: 0, gap2: 0 } };
  const sorted = [...byFunction].sort((a,b)=>b.pct-a.pct);
  const gap1 = (sorted[0].pct - sorted[1].pct) / 100; // dom-aux
  const gap2 = (sorted[1].pct - sorted[2].pct) / 100; // aux-ter
  const s = clamp01(gap1*0.7 + gap2*0.3);
  const label = s >= 0.6 ? '高' : s >= 0.35 ? '中' : '一般';
  return { score: s, label, details: { gap1: round(gap1*100), gap2: round(gap2*100) } };
}

/* 群組色：NT(紫) / NF(綠) / SP(黃) / SJ(藍) */
function typeGroup(code) {
  const c = String(code || '').toUpperCase();
  if (!c || c.length < 4) return null;
  const second = c[1]; // N or S
  const fourth = c[3]; // J or P
  const third  = c[2]; // T or F
  if (second === 'N' && third === 'T') return 'nt';
  if (second === 'N' && third === 'F') return 'nf';
  if (second === 'S' && fourth === 'P') return 'sp';
  if (second === 'S' && fourth === 'J') return 'sj';
  return null;
}

/* 強弱等級（針對功能 % 值） */
function grade(p) {
  if (p >= 85) return { level: '極強', hint: '非常突出，常自然而然地使用' };
  if (p >= 70) return { level: '強', hint: '穩定可用，表現明顯' };
  if (p >= 55) return { level: '中高', hint: '偏好明顯，可持續鍛鍊' };
  if (p >= 45) return { level: '中性', hint: '介於強弱之間，視情境而定' };
  if (p >= 30) return { level: '偏弱', hint: '較少主動使用' };
  return { level: '弱', hint: '容易忽略，建議在低壓情境練習' };
}

/* ========== builders ========== */
function buildSummary(result) {
  const list = getFuncList();
  const ax = axesOneLiner(result.axes);
  const dom = result.top?.dominant;
  const aux = result.top?.auxiliary;
  const conf = confidence(result.byFunction);

  // 類型（若 Scorer 已決定就用；否則用軸線猜）
  const code = result.type?.code || ax.codeGuess || '未知';
  const typeMap = getTypeMap();
  const lookup = typeMap.byCode?.[code] || null;
  const typeName = result.type?.name || lookup?.name || null;

  const domName = dom ? byIdx(list, dom.idx, {name:'(未知)'}).name : '(未知)';
  const auxName = aux ? byIdx(list, aux.idx, {name:'(未知)'}).name : '(未知)';

  return {
    typeCode: code,
    typeName,
    how: result.type?.how || (lookup ? 'mapping' : 'heuristic'),
    dominant: { idx: dom?.idx, name: domName, pct: round(dom?.pct || 0) },
    auxiliary: { idx: aux?.idx, name: auxName, pct: round(aux?.pct || 0) },
    axes: ax,
    confidence: conf,
    line: `推定類型：${code}（主：${domName}，輔：${auxName}；信心${conf.label}）｜${ax.line}`,
  };
}

function buildFunctionTable(result) {
  const list = getFuncList();
  const rows = (result.byFunction || []).map((f) => {
    const meta = byIdx(list, f.idx, { name: `功能 ${f.idx}`, desc: '', key: `f${f.idx}` });
    const g = grade(f.pct);
    return {
      idx: f.idx,
      key: meta.key,
      name: meta.name,
      desc: meta.desc || '',
      pct: round(f.pct, 0),
      raw: f.raw,
      max: f.max,
      level: g.level,
      hint: g.hint,
    };
  });
  rows.sort((a,b)=>b.pct-a.pct);
  return rows;
}

function buildTypeNarrative(result) {
  const typeMap = getTypeMap();
  const code = result.type?.code || axesOneLiner(result.axes).codeGuess;
  const record =
    (typeMap?.byCode && typeMap.byCode[code]) ||
    result.type ||
    null;

  if (record && (record.description || record.desc)) {
    const desc = record.description || record.desc;
    return {
      code,
      name: record.name || null,
      paragraphs: Array.isArray(desc)
        ? desc
        : String(desc || '').split(/\n{2,}/).filter(Boolean),
      source: 'mapping',
    };
  }

  // fallback：用主輔功能自動組句
  const list = getFuncList();
  const dom = result.top?.dominant;
  const aux = result.top?.auxiliary;
  const domName = dom ? byIdx(list, dom.idx, {name:'(未知)'}).name : '(未知)';
  const auxName = aux ? byIdx(list, aux.idx, {name:'(未知)'}).name : '(未知)';

  const paras = [
    `你的核心傾向由「${domName}」主導，輔以「${auxName}」。這代表你在面對資訊與決策時，會優先使用主功能的習慣模式，並由輔功能補足不同場景下的需求。`,
    `從數據來看，主功能約 ${pct(dom?.pct || 0)}，輔功能約 ${pct(aux?.pct || 0)}；兩者差距顯示你在日常中較易以主功能啟動，但也具備以輔功能調節的彈性。`,
  ];
  return { code, name: null, paragraphs: paras, source: 'auto' };
}

function buildRecommendations(result) {
  const list = getFuncList();
  const rows = buildFunctionTable(result); // 已排序
  const top4 = rows.slice(0, 4);
  const tips = [];

  // 對位功能平衡建議
  for (const r of top4) {
    const oppIdx = OPP[r.idx];
    const oppMeta = byIdx(list, oppIdx, { name: '對位功能' });
    const oppRow = rows.find(x => x.idx === oppIdx);
    if (oppRow && oppRow.pct < 45) {
      tips.push(`強化「${r.name}」的同時，別忽略其對位「${oppMeta.name}」。可在低壓情境下，刻意練習需要「${oppMeta.name}」的簡單任務，讓決策更全面。`);
    }
  }

  // 四軸明顯偏向時的提醒
  const ax = result.axes || {};
  const pushAxisTip = (p, a, b, label) => {
    if (p >= 0.75) tips.push(`在「${label}」上明顯偏向 ${a}（約 ${round(p*100)}%），遇到需要 ${b} 的情境時，先暫停並收集更多反例或實感訊息。`);
    if (p <= 0.25) tips.push(`在「${label}」上明顯偏向 ${b}（約 ${round((1-p)*100)}%），嘗試安排可提前規劃/抽象化的任務來擴充另一側肌肉。`);
  };
  pushAxisTip(ax.EI?.pctE ?? 0.5, '外向', '內向', 'E–I');
  pushAxisTip(ax.NS?.pctN ?? 0.5, '直覺', '感覺', 'N–S');
  pushAxisTip(ax.TF?.pctT ?? 0.5, '理性', '情感', 'T–F');
  pushAxisTip(ax.JP?.pctJ ?? 0.5, '規劃', '彈性', 'J–P');

  if (tips.length === 0) {
    tips.push('你的功能分佈相對平衡。持續在不同場景練習切換策略，可讓表現更穩定。');
  }
  return tips.slice(0, 6);
}

/* ========== HTML builders（純字串；由 UI 決定塞入位置） ========== */
const toHTML = {
  summary(s) {
    const group = typeGroup(s.typeCode);
    const badgeCls = ['type-badge', group || '', (s.typeCode || '').toUpperCase()].filter(Boolean).join(' ');
    const name = s.typeName ? `（${s.typeName}）` : '';
    const conf = `信心：${s.confidence.label}（主輔差距 ${s.confidence.details.gap1}%）`;
    return `
<div class="report-summary">
  <h2>
    <span class="${badgeCls}">${(s.typeCode || '未知').toUpperCase()}</span> ${name}
  </h2>
  <p>${s.line}</p>
  <p class="muted">${conf}</p>
</div>`.trim();
  },

  functionTable(rows) {
    const tr = rows.map(r => `
      <tr>
        <td>${r.name}</td>
        <td>${pct(r.pct)}</td>
        <td>${r.level}</td>
        <td class="muted">${r.hint}</td>
      </tr>`).join('');
    return `
<table class="report-func">
  <thead><tr><th>功能</th><th>強度</th><th>等級</th><th>說明</th></tr></thead>
  <tbody>${tr}</tbody>
</table>`.trim();
  },

  typeNarrative(n) {
    const title = n.name ? `${n.code}（${n.name}）` : n.code;
    const ps = (n.paragraphs || []).map(p => `<p>${p}</p>`).join('');
    const src = n.source === 'mapping' ? '（依據對照檔）' : '（依據主輔功能自動生成）';
    return `
<div class="report-type">
  <h3>類型解讀：${title}</h3>
  ${ps}
  <p class="muted">${src}</p>
</div>`.trim();
  },

  recommendations(tips) {
    const li = tips.map(t => `<li>${t}</li>`).join('');
    return `
<div class="report-reco">
  <h3>實用建議</h3>
  <ul>${li}</ul>
</div>`.trim();
  },
};

/* ========== Public API ========== */
export const Report = {
  /**
   * 將 Scorer.score(...) 的結果轉成各段落資料
   */
  buildAll(result) {
    const summary = buildSummary(result);
    const table = buildFunctionTable(result);
    const narrative = buildTypeNarrative(result);
    const recos = buildRecommendations(result);
    return { summary, table, narrative, recos };
  },

  buildSummary,
  buildFunctionTable,
  buildTypeNarrative,
  buildRecommendations,

  // HTML 版本（方便直接塞入頁面）
  toHTML,
};