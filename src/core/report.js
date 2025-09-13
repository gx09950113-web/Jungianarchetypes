// src/core/report.js
// Generate human-readable narratives and tables from Scorer.score(...) result.
// This module does NOT touch the DOM directly; it returns strings/structures.
// UI 層（render-result.js）自行決定如何插入頁面。

import { Scorer } from './scorer.js';

// ---- helpers ----
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

// 功能對位（八功能的相對/對位功能，用於建議）
const OPP = { 0: 3, 1: 2, 2: 1, 3: 0, 4: 7, 5: 6, 6: 5, 7: 4 };
// 預設中文名稱（作為 funcs.json 缺席時的回退）
const FALLBACK_FUNCS = [
  { idx: 0, key: 'Ni', name: '內傾直覺（Ni）', desc: '' },
  { idx: 1, key: 'Fe', name: '外傾情感（Fe）', desc: '' },
  { idx: 2, key: 'Ti', name: '內傾思考（Ti）', desc: '' },
  { idx: 3, key: 'Se', name: '外傾感覺（Se）', desc: '' },
  { idx: 4, key: 'Ne', name: '外傾直覺（Ne）', desc: '' },
  { idx: 5, key: 'Fi', name: '內傾情感（Fi）', desc: '' },
  { idx: 6, key: 'Te', name: '外傾思考（Te）', desc: '' },
  { idx: 7, key: 'Si', name: '內傾感覺（Si）', desc: '' },
];

// 強弱等級
function grade(p) {
  if (p >= 85) return { level: '極強', hint: '非常突出，常自然而然地使用' };
  if (p >= 70) return { level: '強', hint: '穩定可用，表現明顯' };
  if (p >= 55) return { level: '中高', hint: '偏好明顯，可持續鍛鍊' };
  if (p >= 45) return { level: '中性', hint: '介於強弱之間，視情境而定' };
  if (p >= 30) return { level: '偏弱', hint: '較少主動使用' };
  return { level: '弱', hint: '容易忽略，建議在低壓情境練習' };
}

// 一句話四軸描述
function axesOneLiner(axes) {
  const E = axes?.EI?.pctE ?? 0;
  const N = axes?.NS?.pctN ?? 0;
  const T = axes?.TF?.pctT ?? 0;
  const J = axes?.JP?.pctJ ?? 0;
  const letter = (p, a, b) => (p >= 0.5 ? a : b);
  const code = `${letter(E, 'E', 'I')}${letter(N, 'N', 'S')}${letter(T, 'T', 'F')}${letter(J, 'J', 'P')}`;
  return {
    codeGuess: code,
    line: `傾向 ${letter(E,'外向','內向')}、偏${letter(N,'直覺','感覺')}、決策偏${letter(T,'理性','情感')}、生活偏${letter(J,'規劃','彈性')}`,
    percents: { E: round(E*100), N: round(N*100), T: round(T*100), J: round(J*100) },
  };
}

// 主輔功能信心估計：看主輔與後續差距
function confidence(byFunction) {
  if (!Array.isArray(byFunction) || byFunction.length < 4) return { score: 0.5, label: '一般' };
  const sorted = [...byFunction].sort((a,b)=>b.pct-a.pct);
  const gap1 = (sorted[0].pct - sorted[1].pct) / 100; // dom-aux
  const gap2 = (sorted[1].pct - sorted[2].pct) / 100; // aux-ter
  // 粗估：加權（dom-aux 權重較高）
  const s = clamp01(gap1*0.7 + gap2*0.3);
  const label = s >= 0.6 ? '高' : s >= 0.35 ? '中' : '一般';
  return { score: s, label, details: { gap1: round(gap1*100), gap2: round(gap2*100) } };
}

// 安全取得功能對照
function getFuncList() {
  const meta = Scorer.getFuncMeta();
  const list = meta?.list && meta.list.length >= 8 ? meta.list : FALLBACK_FUNCS;
  return list.map((it, i) => ({
    idx: i,
    key: it.key ?? `f${i}`,
    name: it.name ?? `功能 ${i}`,
    desc: it.desc ?? '',
  }));
}

// ---- builders ----
function buildSummary(result) {
  const list = getFuncList();
  const ax = axesOneLiner(result.axes);
  const dom = result.top?.dominant;
  const aux = result.top?.auxiliary;
  const conf = confidence(result.byFunction);

  const typeCode = result.type?.code || ax.codeGuess || '未知';
  const domName = dom ? byIdx(list, dom.idx, {name:'(未知)'}).name : '(未知)';
  const auxName = aux ? byIdx(list, aux.idx, {name:'(未知)'}).name : '(未知)';

  return {
    typeCode,
    typeName: result.type?.name || null,
    how: result.type?.how || 'heuristic',
    dominant: { idx: dom?.idx, name: domName, pct: round(dom?.pct || 0) },
    auxiliary: { idx: aux?.idx, name: auxName, pct: round(aux?.pct || 0) },
    axes: ax,
    confidence: conf,
    line: `推定類型：${typeCode}（主：${domName}，輔：${auxName}；信心${conf.label}）｜${ax.line}`,
  };
}

function buildFunctionTable(result) {
  const list = getFuncList();
  const rows = (result.byFunction || []).map((f) => {
    const meta = byIdx(list, f.idx, { name: `功能 ${f.idx}`, desc: '' });
    const g = grade(f.pct);
    return {
      idx: f.idx,
      key: f.key,
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
  // 若 types.json 有提供，優先使用
  const tmap = Scorer.getTypeMap();
  const code = result.type?.code;
  const record =
    (tmap?.byCode && tmap.byCode[code]) ||
    result.type ||
    null;

  if (record && (record.description || record.desc)) {
    return {
      code,
      name: record.name || null,
      paragraphs: Array.isArray(record.description)
        ? record.description
        : String(record.description || record.desc || '').split(/\n{2,}/).filter(Boolean),
      source: 'mapping',
    };
  }

  // 否則根據主輔功能自動組句
  const list = getFuncList();
  const dom = result.top?.dominant;
  const aux = result.top?.auxiliary;
  const domName = dom ? byIdx(list, dom.idx, {name:'(未知)'}).name : '(未知)';
  const auxName = aux ? byIdx(list, aux.idx, {name:'(未知)'}).name : '(未知)';

  const paras = [
    `你的核心傾向由「${domName}」主導，輔以「${auxName}」。這代表你在面對資訊與決策時，會優先使用主功能的習慣模式，並由輔功能補足不同場景下的需求。`,
    `從數據來看，主功能的表現約為 ${pct(dom?.pct || 0)}，輔功能約為 ${pct(aux?.pct || 0)}；兩者差距顯示出你在日常中較容易以主功能啟動，但也具有以輔功能調節的彈性。`,
  ];
  return { code, name: null, paragraphs: paras, source: 'auto' };
}

function buildRecommendations(result) {
  const list = getFuncList();
  const rows = buildFunctionTable(result); // 已排序
  const top4 = rows.slice(0, 4);
  const bottom2 = rows.slice(-2);
  const tips = [];

  // 針對對位功能給出平衡建議
  for (const r of top4) {
    const oppIdx = OPP[r.idx];
    const oppMeta = byIdx(list, oppIdx, { name: '對位功能' });
    // 若對位功能排名偏後 → 給平衡建議
    const oppRow = rows.find(x => x.idx === oppIdx);
    if (oppRow && oppRow.pct < 45) {
      tips.push(`強化「${r.name}」的同時，別忽略其對位「${oppMeta.name}」。可在低壓環境下，刻意練習需要「${oppMeta.name}」的簡單任務，讓決策更全面。`);
    }
  }

  // 若四軸有明顯失衡，給一句話
  const ax = result.axes || {};
  const pushAxisTip = (p, a, b, label) => {
    if (p >= 0.75) tips.push(`在「${label}」上明顯偏向 ${a}（${round(p*100)}%），遇到需要 ${b} 的場景時，可先暫停一步，收集更多反例或實感訊息。`);
    if (p <= 0.25) tips.push(`在「${label}」上明顯偏向 ${b}（${round((1-p)*100)}%），嘗試設置可提前規劃/抽象化的練習來擴充另一側肌肉。`);
  };
  pushAxisTip(ax.EI?.pctE ?? 0.5, '外向', '內向', 'E–I');
  pushAxisTip(ax.NS?.pctN ?? 0.5, '直覺', '感覺', 'N–S');
  pushAxisTip(ax.TF?.pctT ?? 0.5, '理性', '情感', 'T–F');
  pushAxisTip(ax.JP?.pctJ ?? 0.5, '規劃', '彈性', 'J–P');

  // 若 tips 太少，給通用建議
  if (tips.length === 0) {
    tips.push('你的功能分佈相對平衡。維持在不同場景中練習切換策略，能讓表現更穩定。');
  }

  return tips.slice(0, 6);
}

// ---- HTML builders（純字串；由 UI 決定塞入位置） ----
const toHTML = {
  summary(s) {
    // s = buildSummary(...)
    const name = s.typeName ? `（${s.typeName}）` : '';
    const conf = `信心：${s.confidence.label}（主輔差距 ${s.confidence.details.gap1}%）`;
    return `
<div class="report-summary">
  <h2>你的結果：${s.typeCode}${name}</h2>
  <p>${s.line}</p>
  <p class="muted">${conf}</p>
</div>`.trim();
  },

  functionTable(rows) {
    // rows = buildFunctionTable(...)
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

// ---- Public API ----
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
