// src/ui/render-result.js
// Render result pages (basic & advanced) using Scorer + Report.
// - Basic (32): 八功能 + 四軸 + 一句話 + 建議 + 長條圖/雷達
// - Advanced (56): 綜合 MBTI + 完成度提示
//
// 需求：在 result_* 頁面 <script> 順序務必：chart.umd.js -> pako.min.js -> app.min.js

import { Scorer } from '../core/scorer.js';
import { Report } from '../core/report.js';

// ------- DOM helpers -------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  children.forEach(c => e.appendChild(c));
  return e;
};
const tidy = (x) => JSON.parse(JSON.stringify(x));

// ------- fetch helpers -------
async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.json();
}

// 讀 docs/data 的相對路徑
function dataUrl(name) {
  return new URL(`../data/${name}`, document.baseURI).href
    .replace(/\/docs\/docs\//, '/docs/'); // GH Pages 容錯（某些 repo 結構會重複）
}

// ------- answer sources (從你現有儲存) -------
// 你前面版本把 basic 存在 localStorage('jung8v:basicAnswers') = Array(32)
function loadBasicFromLocal() {
  try {
    const raw = localStorage.getItem('jung8v:basicAnswers');
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
// 進階：你先前存成 jung8v:advAnswers = {A:[..],B:[..],C:[..]}
// 我們允許三組任一存在就算分數（A/B/C 有就吃；沒有的忽略）
function loadAdvancedFromLocal() {
  try {
    const raw = localStorage.getItem('jung8v:advAnswers');
    if (!raw) return null;
    const obj = JSON.parse(raw) || {};
    const A = Array.isArray(obj.A) ? obj.A : null;
    const B = Array.isArray(obj.B) ? obj.B : null;
    const C = Array.isArray(obj.C) ? obj.C : null;
    return { A, B, C };
  } catch { return null; }
}

// 把「依出題順序的答案陣列」→ 附上題目 id。
// items: 來自 items_public_xxx.json（我們嘗試讀 item.id / item.qid，沒有就 fallback 用 index）
function attachIds(items, answers) {
  const arr = [];
  for (let i = 0; i < Math.min(items.length, answers.length); i++) {
    const item = items[i] || {};
    const id = String(item.id ?? item.qid ?? i);
    const v  = answers[i];
    arr.push({ id, value: v });
  }
  return arr;
}

// ------- charts -------
function drawBars(canvas, rows) {
  if (!(window.Chart && canvas?.getContext)) return;
  const ctx = canvas.getContext('2d');
  const labels = rows.map(r => r.name.replace(/（.*?）/,''));
  const data   = rows.map(r => r.pct);

  // 顏色：依功能 key 簡單分群（J/N/T/S）
  const bg = rows.map(r => {
    const k = (r.key || '').toUpperCase();
    if (k === 'NI' || k === 'NE') return 'rgba(99,102,241,0.25)';   // N
    if (k === 'TI' || k === 'TE') return 'rgba(14,165,233,0.25)';   // T
    if (k === 'FI' || k === 'FE') return 'rgba(16,185,129,0.25)';   // F
    return 'rgba(234,179,8,0.25)';                                  // S
  });

  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: '功能強度（%）', data, backgroundColor: bg }]
    },
    options: {
      animation: false,
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, max: 100, ticks: { stepSize: 20 } } }
    }
  });
}

function drawRadar(canvas, rows) {
  if (!(window.Chart && canvas?.getContext)) return;
  const ctx = canvas.getContext('2d');
  const labels = rows.map(r => r.key);
  const data   = rows.map(r => Math.round(r.pct));

  return new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [{ label: '八功能雷達', data }]
    },
    options: {
      animation: false,
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { r: { angleLines: { display: true }, suggestedMin: 0, suggestedMax: 100 } }
    }
  });
}

// 型別徽章顏色群組（跟你 CSS 的 4 群對齊）
function typeGroup(code) {
  if (!code) return 'nt';
  const NT = /^(ENTP|ENTJ|INTP|INTJ)$/;
  const NF = /^(ENFP|ENFJ|INFP|INFJ)$/;
  const SP = /^(ESTP|ESFP|ISTP|ISFP)$/;
  const SJ = /^(ESFJ|ESTJ|ISFJ|ISTJ)$/;
  if (NT.test(code)) return 'nt';
  if (NF.test(code)) return 'nf';
  if (SP.test(code)) return 'sp';
  if (SJ.test(code)) return 'sj';
  return 'nt';
}

// ------- render blocks -------
function renderSummary(root, reportSummary) {
  // 類型徽章（有 code 才顯示顏色）
  const badge = el('div', { class: `type-badge ${reportSummary.typeCode}` }, [
    el('span', { class: 'code', text: reportSummary.typeCode }),
    el('span', { class: 'tag', text: '推定類型' }),
  ]);
  badge.classList.add(typeGroup(reportSummary.typeCode));

  const box = el('section', { class: 'res-summary card' });
  box.appendChild(badge);
  box.appendChild(el('div', { html: Report.toHTML.summary(reportSummary) }));
  root.appendChild(box);
}

function renderCharts(root, funcRows) {
  const sec = el('section', { class: 'res-charts card' });
  sec.appendChild(el('div', { class: 'chart-wrap' }, [
    el('canvas', { id: 'funcBars', width: '560', height: '300' }),
  ]));
  sec.appendChild(el('div', { class: 'chart-wrap' }, [
    el('canvas', { id: 'funcRadar', width: '560', height: '300' }),
  ]));
  root.appendChild(sec);

  drawBars($('#funcBars'), funcRows);
  drawRadar($('#funcRadar'), funcRows);
}

function renderTable(root, funcRows) {
  const sec = el('section', { class: 'res-table card' });
  sec.innerHTML = Report.toHTML.functionTable(funcRows);
  root.appendChild(sec);
}

function renderNarrative(root, narrative) {
  const sec = el('section', { class: 'res-narrative card' });
  sec.innerHTML = Report.toHTML.typeNarrative(narrative);
  root.appendChild(sec);
}

function renderRecos(root, tips) {
  const sec = el('section', { class: 'res-reco card' }, [
    el('div', { html: Report.toHTML.recommendations(tips) })
  ]);
  root.appendChild(sec);
}

function renderError(root, err) {
  const sec = el('section', { class: 'card warn' }, [
    el('h3', { text: '結果生成失敗' }),
    el('p', { text: String(err?.message || err) }),
  ]);
  root.appendChild(sec);
}

// ------- pipelines -------
async function runBasic(root) {
  // 1) 讀使用者 32 題答案
  const answers = loadBasicFromLocal();
  if (!answers) throw new Error('找不到 32 題作答紀錄，請先完成測驗。');

  // 2) 讀公開題庫以取得每題 id
  const items = await fetchJSON(dataUrl('items_public_32.json'));

  // 3) 附 id 後丟給 Scorer
  await Scorer.init('basic');
  const result = await Scorer.score({ mode: 'basic', answers: attachIds(items, answers) });

  // 4) Report
  const rpt = Report.buildAll(result);
  renderSummary(root, rpt.summary);
  renderCharts(root, rpt.table);
  renderTable(root, rpt.table);
  renderNarrative(root, rpt.narrative);
  renderRecos(root, rpt.recos);
}

async function runAdvanced(root) {
  // 允許任一組存在。缺的組別不影響已完成部分的分數（我們會分別畫，或合併）
  const adv = loadAdvancedFromLocal();
  if (!adv || !(adv.A || adv.B || adv.C)) {
    // 退回完成度頁（你之前想顯示完成度）
    const sec = el('section', { class: 'card' }, [
      el('h1', { class: 'title', text: '進階結果（完成度）' }),
      el('p', { text: '尚未有任何進階作答。請回到 32 題完成後再接續。' }),
      el('div', { class: 'actions' }, [
        el('a', { class: 'btn primary', href: './quiz.html?mode=basic', text: '回到作答' }),
      ]),
    ]);
    root.appendChild(sec);
    return;
  }

  // 合併 A/B/C（哪一組有作答就納入）
  let allRows = null;
  let best = null;

  for (const part of ['A','B','C']) {
    const arr = adv[part];
    if (!arr) continue;
    const filename =
      part === 'A' ? 'items_public_adv_A.json' :
      part === 'B' ? 'items_public_adv_B.json' :
                     'items_public_adv_C.json';
    const items = await fetchJSON(dataUrl(filename));

    await Scorer.init(part === 'A' ? 'advA' : part === 'B' ? 'advB' : 'advC');
    const result = await Scorer.score({
      mode: (part === 'A' ? 'advA' : part === 'B' ? 'advB' : 'advC'),
      answers: attachIds(items, arr),
    });

    // 擇優顯示（誰的主輔差距更明顯，就拿誰的 code 做主敘述）
    const rpt = Report.buildAll(result);
    const confGap = rpt.summary?.confidence?.details?.gap1 ?? 0;
    if (!best || confGap > best.gap) best = { gap: confGap, rpt };

    // 合併功能分（平均）
    const rows = rpt.table;
    if (!allRows) {
      allRows = rows.map(r => ({ idx: r.idx, key: r.key, name: r.name, sum: r.pct, n: 1 }));
    } else {
      for (let i = 0; i < allRows.length; i++) {
        allRows[i].sum += rows[i].pct;
        allRows[i].n += 1;
      }
    }
  }

  if (!best) throw new Error('進階作答格式不正確。');

  // 平均功能分
  const merged = allRows.map(r => ({ idx: r.idx, key: r.key, name: r.name, pct: Math.round(r.sum / r.n) }));
  // Summary 仍用最佳組別 best.rpt
  renderSummary(root, best.rpt.summary);
  renderCharts(root, merged);
  renderTable(root, merged);
  renderNarrative(root, best.rpt.narrative);
  renderRecos(root, best.rpt.recos);
}

// ------- boot -------
function pageFile() {
  const parts = location.pathname.split('/');
  return parts[parts.length - 1] || 'index.html';
}

async function init() {
  const root = $('#result-root') || el('div', { id: 'result-root', class: 'result-root' });
  if (!root.isConnected) document.body.appendChild(root);

  // loading
  const loading = el('section', { class: 'card' }, [ el('p', { text: '計算中…' }) ]);
  root.appendChild(loading);

  try {
    const file = pageFile().toLowerCase();
    if (file === 'result_basic.html') {
      await runBasic(root);
    } else if (file === 'result_advanced.html') {
      await runAdvanced(root);
    } else {
      root.appendChild(el('section', { class: 'card warn' }, [ el('p', { text: '未知的結果頁。' }) ]));
    }
  } catch (err) {
    renderError(root, err);
    console.error('[result] error:', err);
  } finally {
    loading.remove();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}