// src/ui/render-result.js
// Result page renderer: build charts + narrative
// Requirements on page:
// - <div id="result-root"></div>
// - Chart.js loaded globally as window.Chart
// - Scorer, Report modules available (bundled in app.min.js)
// - pako is loaded before app.min.js so weights can decode

import { Scorer } from '../core/scorer.js';
import { Report } from '../core/report.js';

/* ---------------- small utils ---------------- */
const NS = 'jung8v:'; // must match your Store namespace
const $ = (sel, root = document) => root.querySelector(sel);

function readLS(key, def = null) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw ? JSON.parse(raw) : def;
  } catch {
    return def;
  }
}
function nonNullCount(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.filter(v => v !== null && v !== undefined).length;
}
function fmtPct(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* ------------- charts ------------- */
function drawRadar(canvas, labels, values) {
  if (!window.Chart || !canvas?.getContext) return;
  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [{ label: '八維強度（%）', data: values }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        r: { beginAtZero: true, suggestedMax: 100, ticks: { stepSize: 20 } }
      }
    }
  });
}

function drawBars(canvas, labels, values) {
  if (!window.Chart || !canvas?.getContext) return;
  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: '八維強度（%）', data: values }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, suggestedMax: 100, ticks: { precision: 0 } } }
    }
  });
}

/* ------------- combine advanced modes ------------- */
/** 將多個 result.byFunction 以「使用題數」加權合併，回傳合併後的 byFunction 陣列（含 pct） */
function combineByFunction(weightedList) {
  // weightedList: [{ byFunction, used }, ...]
  const totalW = weightedList.reduce((s, x) => s + (x.used || 0), 0) || 1e-9;
  const n = 8;
  const sumRaw = Array(n).fill(0);
  const sumMax = Array(n).fill(0);

  for (const part of weightedList) {
    const w = (part.used || 0) / totalW;
    const bf = part.byFunction || [];
    for (let i = 0; i < n; i++) {
      const it = bf[i] || { raw: 0, max: 0 };
      sumRaw[i] += (it.raw || 0) * w;
      sumMax[i] += (it.max || 0) * w;
    }
  }

  return sumRaw.map((r, i) => {
    const m = sumMax[i] || 1e-9;
    const pct = Math.max(0, Math.min(1, r / m)) * 100;
    // key/name/desc 交給呼叫端補（用 Scorer.getFuncMeta()）
    return { idx: i, raw: r, max: m, pct };
  });
}

/** 依 byFunction + typesMap 粗略推斷類型（與 scorer 內部一致的邏輯簡化版） */
function inferTypeFromByFunction(byFunction, typesMap) {
  const sorted = [...byFunction].sort((a, b) => b.pct - a.pct);
  const dom = sorted[0], aux = sorted[1], ter = sorted[2], inf = sorted[3];
  let type = { code: 'Unknown', how: 'fallback' };

  if (typesMap) {
    const dm = typesMap.byPair || typesMap.pairs;
    if (dm) {
      const k1 = `${dom.idx}-${aux.idx}`, k2 = `${aux.idx}-${dom.idx}`;
      if (dm[k1]) type = { ...dm[k1], how: 'byPair' };
      else if (dm[k2]) type = { ...dm[k2], how: 'byPair' };
    }
    if (type.code === 'Unknown' && typesMap.byDominant) {
      if (typesMap.byDominant[dom.idx]) type = { ...typesMap.byDominant[dom.idx], how: 'byDominant' };
    }
    if (type.code === 'Unknown' && Array.isArray(typesMap.rules)) {
      for (const r of typesMap.rules) {
        const okDom = r?.if?.dom === undefined || r.if.dom === dom.idx;
        const okAux = r?.if?.aux === undefined || r.if.aux === aux.idx;
        if (okDom && okAux) { type = { code: r.code, name: r.name, description: r.description, how: 'rules' }; break; }
      }
    }
  }
  return { type, top: { dominant: dom, auxiliary: aux, tertiary: ter, inferior: inf } };
}

/** 由 byFunction 推導四軸（用 scorer 的集合邏輯，需從 funcMeta 建 sets） */
function axesFromByFunction(byFunction, funcMeta) {
  const k2i = funcMeta.keyToIndex || {};
  const idx = k => (k2i[k] ?? -1);
  const set = (...xs) => new Set(xs.filter(i => i >= 0));

  const Fe = idx('Fe'), Te = idx('Te'), Se = idx('Se'), Ne = idx('Ne');
  const Fi = idx('Fi'), Ti = idx('Ti'), Si = idx('Si'), Ni = idx('Ni');

  const EXTV = set(Fe, Te, Se, Ne);
  const NSET = set(Ni, Ne);
  const TSET = set(Ti, Te);
  const JEXT = set(Fe, Te);
  const PEXT = set(Se, Ne);

  const agg = (set) => {
    let s = 0, m = 0;
    for (let i = 0; i < byFunction.length; i++) {
      if (set.has(i)) { s += byFunction[i].raw; m += byFunction[i].max; }
    }
    const pct = m > 0 ? (s / m) : 0;
    return { score: s, max: m, pct };
  };

  const EI = agg(EXTV);
  const NS = agg(NSET);
  const TF = agg(TSET);
  const JPj = agg(JEXT);
  const JPp = agg(PEXT);
  const pctJ = (JPj.score) / (JPj.score + JPp.score || 1e-9);

  return {
    EI: { E: EI.pct, I: 1 - EI.pct, pctE: EI.pct },
    NS: { N: NS.pct, S: 1 - NS.pct, pctN: NS.pct },
    TF: { T: TF.pct, F: 1 - TF.pct, pctT: TF.pct },
    JP: { J: pctJ, P: 1 - pctJ, pctJ },
  };
}

/* ------------- render helpers ------------- */
function buildSummaryHTML(summary) {
  // 使用 Report.toHTML.summary，已含徽章 class（type-badge + 群組色）
  return Report.toHTML.summary(summary);
}
function buildTableHTML(rows) {
  return Report.toHTML.functionTable(rows);
}
function buildNarrativeHTML(nar) {
  return Report.toHTML.typeNarrative(nar);
}
function buildRecoHTML(tips) {
  return Report.toHTML.recommendations(tips);
}

function funcLabelsFromMeta(funcMeta) {
  // 顯示短名（key 或 name），圖表用
  return (funcMeta.list || []).map(x => x.key || x.name || `F${x.idx}`);
}

/* ------------- BASIC: result_basic.html ------------- */
export async function renderBasicResult() {
  const root = $('#result-root');
  if (!root) return;

  const basicAnswers = readLS('basicAnswers', null);
  if (!basicAnswers) {
    alert('找不到 32 題作答紀錄，請先完成測驗。');
    location.href = './quiz.html?mode=basic';
    return;
  }

  await Scorer.init('basic');
  const result = await Scorer.score({
    mode: 'basic',
    answers: basicAnswers, // 支援 [v,v,..] 或 [{id,value}]
  });

  // 準備圖表資料
  const funcMeta = Scorer.getFuncMeta();
  const labels = funcLabelsFromMeta(funcMeta);
  const values = result.byFunction.map(f => Math.round(f.pct));

  // Report 段落
  const { summary, table, narrative, recos } = Report.buildAll(result);

  root.innerHTML = `
    <section class="res-header">
      <h2>初步結果（32 題）</h2>
      <div class="head-actions">
        <a class="btn" href="./quiz.html?mode=basic">回顧作答</a>
        <a class="btn primary" href="./quiz.html?mode=advanced">進入進階 56 題</a>
        <a class="btn ghost" href="./index.html">回首頁</a>
      </div>
    </section>

    ${buildSummaryHTML(summary)}

    <section class="res-charts">
      <div class="chart-wrap">
        <canvas id="radar8"></canvas>
      </div>
      <div class="chart-wrap">
        <canvas id="bars8"></canvas>
      </div>
    </section>

    <section class="res-table card">
      ${buildTableHTML(table)}
    </section>

    <section class="res-narrative card">
      ${buildNarrativeHTML(narrative)}
    </section>

    <section class="res-reco card">
      ${buildRecoHTML(recos)}
    </section>
  `;

  drawRadar($('#radar8'), labels, values);
  drawBars($('#bars8'), labels, values);
}

/* ------------- ADVANCED: result_advanced.html ------------- */
export async function renderAdvancedResult() {
  const root = $('#result-root');
  if (!root) return;

  const basicAnswers = readLS('basicAnswers', null);
  const adv = readLS('advAnswers', null) || {};
  const advA = Array.isArray(adv.A) ? adv.A : null;
  const advB = Array.isArray(adv.B) ? adv.B : null;
  const advC = Array.isArray(adv.C) ? adv.C : null;

  if (!basicAnswers && !advA && !advB && !advC) {
    alert('找不到任何作答紀錄。');
    location.href = './index.html';
    return;
  }

  // 分別算四份（有哪份算哪份）
  const parts = [];

  if (basicAnswers) {
    await Scorer.init('basic');
    const r = await Scorer.score({ mode: 'basic', answers: basicAnswers });
    parts.push({ tag: '32 題', result: r, used: r?.debug?.usedItems || nonNullCount(basicAnswers) });
  }
  if (advA) {
    await Scorer.init('advA');
    const r = await Scorer.score({ mode: 'advA', answers: advA });
    parts.push({ tag: '進階 A', result: r, used: r?.debug?.usedItems || nonNullCount(advA) });
  }
  if (advB) {
    await Scorer.init('advB');
    const r = await Scorer.score({ mode: 'advB', answers: advB });
    parts.push({ tag: '進階 B', result: r, used: r?.debug?.usedItems || nonNullCount(advB) });
  }
  if (advC) {
    await Scorer.init('advC');
    const r = await Scorer.score({ mode: 'advC', answers: advC });
    parts.push({ tag: '進階 C', result: r, used: r?.debug?.usedItems || nonNullCount(advC) });
  }

  // 加權合併 byFunction
  const weightedList = parts.map(p => ({ byFunction: p.result.byFunction, used: p.used }));
  const mergedByFunc = combineByFunction(weightedList);

  // 把 meta 補回（name/key）
  const funcMeta = Scorer.getFuncMeta();
  const labeledByFunc = mergedByFunc.map((f, i) => {
    const meta = funcMeta.list?.[i] || { key: `f${i}`, name: `功能 ${i}`, desc: '' };
    return { ...f, key: meta.key, name: meta.name, desc: meta.desc };
  });

  // 重新推斷 type 與軸線
  const typeMap = Scorer.getTypeMap() || { byCode: {} };
  const { type, top } = inferTypeFromByFunction(labeledByFunc, typeMap);
  const axes = axesFromByFunction(labeledByFunc, funcMeta);

  const mergedResult = {
    mode: 'advanced-merged',
    byFunction: labeledByFunc,
    top,
    type,
    axes,
    debug: {
      parts: parts.map(p => ({ tag: p.tag, used: p.used })),
      weights: parts.map(p => p.used),
    }
  };

  // Report 段落
  const { summary, table, narrative, recos } = Report.buildAll(mergedResult);

  // 圖表資料
  const labels = funcLabelsFromMeta(funcMeta);
  const values = labeledByFunc.map(f => Math.round(f.pct));

  root.innerHTML = `
    <section class="res-header">
      <h2>進階結果（綜合 32 題 + 進階 A/B/C）</h2>
      <div class="head-actions">
        <a class="btn" href="./quiz.html?mode=advanced">繼續進階作答</a>
        <a class="btn ghost" href="./result_basic.html">回到初步結果</a>
        <a class="btn" href="./index.html">回首頁</a>
      </div>
    </section>

    ${buildSummaryHTML(summary)}

    <section class="card" style="margin-bottom:12px">
      <div class="muted">
        加權依據各題組「有效作答題數」：${
          parts.map(p => `${p.tag}：${p.used}`).join('，')
        }
      </div>
    </section>

    <section class="res-charts">
      <div class="chart-wrap">
        <canvas id="radar8"></canvas>
      </div>
      <div class="chart-wrap">
        <canvas id="bars8"></canvas>
      </div>
    </section>

    <section class="res-table card">
      ${buildTableHTML(table)}
    </section>

    <section class="res-narrative card">
      ${buildNarrativeHTML(narrative)}
    </section>

    <section class="res-reco card">
      ${buildRecoHTML(recos)}
    </section>
  `;

  drawRadar($('#radar8'), labels, values);
  drawBars($('#bars8'), labels, values);
}

/* ------------- tiny bootstrap for pages (optional) ------------- */
export function bootRenderResultByPage() {
  const p = (location.pathname.split('/').pop() || '').toLowerCase();
  if (p === 'result_basic.html') renderBasicResult();
  if (p === 'result_advanced.html') renderAdvancedResult();
}