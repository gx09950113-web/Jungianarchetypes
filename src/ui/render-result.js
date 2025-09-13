// src/ui/render-result.js
// Result pages glue for result_basic.html & result_advanced.html
// Rebuild item order with same seed, pair with answers, run scoring, render report & charts.

import { Router } from '../core/router.js';
import { Scorer } from '../core/scorer.js';
import { Report } from '../core/report.js';
import { Charts } from '../core/charts.js';

// ---------- Config (mirror quiz-engine) ----------
const DATA_BASE = 'data';
const FILES = {
  basic: 'items_public_32.json',
  advA:  'items_public_adv_A.json',
  advB:  'items_public_adv_B.json',
  advC:  'items_public_adv_C.json',
};

// ---------- Minimal PRNG & shuffle (same as quiz-engine) ----------
function makePRNG(seedStr) {
  function hash32(str, seed = 2166136261 >>> 0) {
    let h = seed;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  const s1 = hash32(seedStr, 0x9E3779B9);
  const s2 = hash32(seedStr, 0x85EBCA77);
  const s3 = hash32(seedStr, 0xC2B2AE3D);
  const s4 = hash32(seedStr, 0x27D4EB2F);
  let a = s1 | 1, b = s2 | 1, c = s3 | 1, d = s4 | 1;

  return function next() {
    const t = a ^ (a << 11);
    a = b; b = c; c = d;
    d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return (d >>> 0) / 0x100000000;
  };
}
function shuffleSeeded(arr, seed) {
  const prng = makePRNG(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------- Fetch helpers ----------
async function fetchJSON(rel) {
  const url = `${DATA_BASE}/${rel}`;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Load failed: ${url} (${res.status})`);
  return res.json();
}
async function loadBank(mode) {
  const file =
    mode === 'basic' ? FILES.basic :
    mode === 'advA'  ? FILES.advA  :
    mode === 'advB'  ? FILES.advB  :
    mode === 'advC'  ? FILES.advC  : null;
  if (!file) throw new Error(`Unknown mode: ${mode}`);
  const bank = await fetchJSON(file);
  const items = Array.isArray(bank) ? bank : Array.isArray(bank.items) ? bank.items : [];
  return items.map((it, i) => {
    if (typeof it.id === 'undefined' || it.id === null) return { ...it, id: `q${i + 1}` };
    return it;
  });
}

// ---------- DOM helpers & skeleton ----------
function $(sel) { return document.querySelector(sel); }
function ensure(id, tag = 'div', cls = '') {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement(tag);
    el.id = id;
    if (cls) el.className = cls;
    document.body.appendChild(el);
  }
  return el;
}

function buildSkeleton() {
  const root = ensure('result-root', 'div', 'result-root');
  const header = ensure('res-header', 'div', 'res-header');
  const summary = ensure('summary', 'div', 'res-summary');
  const charts = ensure('charts', 'div', 'res-charts');
  const table = ensure('funcTable', 'div', 'res-table');
  const narrative = ensure('typeNarrative', 'div', 'res-narrative');
  const reco = ensure('reco', 'div', 'res-reco');

  header.innerHTML = `
    <h2>測驗結果</h2>
    <div class="head-actions">
      <button id="btnHome" class="btn">回首頁重測</button>
      <button id="btnCopy" class="btn ghost">複製分享連結</button>
      <button id="btnDLRadar" class="btn ghost">下載雷達圖</button>
      <button id="btnDLBars" class="btn ghost">下載四軸圖</button>
    </div>
  `;
  charts.innerHTML = `
    <div class="chart-wrap">
      <canvas id="radarChart" style="width:100%;height:360px;"></canvas>
    </div>
    <div class="chart-wrap">
      <canvas id="axesChart" style="width:100%;height:240px;"></canvas>
    </div>
  `;

  root.replaceChildren(header, summary, charts, table, narrative, reco);
  return root;
}

// ---------- Build answers with same seed (basic-only or basic+adv) ----------
async function rebuildAnswers(session) {
  const seed = session.seed || String(Math.random()).slice(2);
  const mode = session.mode || 'basic';
  const answersArr = Array.isArray(session.answers) ? session.answers.slice() : [];

  // 依結果頁型態決定需要的題庫：
  // - result_basic.html：只評 basic（32 題）
  // - result_advanced.html：評 basic + advX（56/40 題）
  const pageFile = window.location.pathname.split('/').pop();
  const isAdvancedPage = /result_advanced\.html$/i.test(pageFile);

  // 1) 先載 basic 並洗牌
  const basic = await loadBank('basic');
  const basicShuffled = shuffleSeeded(basic, seed);

  // 2) 若是進階頁，再載對應 adv 並洗牌；串接
  let items = basicShuffled;
  if (isAdvancedPage) {
    if (!['advA', 'advB', 'advC'].includes(mode)) {
      // 若使用者直接開進階頁但 session 還是 basic，當作僅 basic
      // 也可以選擇 redirect 回 basic 結果頁
      console.warn('[result] advanced page but mode is basic; showing basic only.');
    } else {
      const adv = await loadBank(mode);
      const advShuffled = shuffleSeeded(adv, seed);
      // 與 quiz-engine.continueToAdvanced 一致：basic 在前，adv 接後
      items = basicShuffled.concat(
        advShuffled.map((it, i) => (typeof it.id === 'undefined' ? { ...it, id: `a${i + 1}` } : it))
      );
    }
  }

  // 3) 以 items 順序對齊使用者 answers，組成 [{id, value}]
  const pairs = items.map((it, i) => ({ id: String(it.id), value: answersArr[i] }));
  return { mode: isAdvancedPage ? (['advA','advB','advC'].includes(mode) ? mode : 'basic') : 'basic', pairs };
}

// ---------- Main render ----------
let _radar = null;
let _bars = null;

async function render() {
  buildSkeleton();

  const info = Router.current();
  const sess = info.session;
  const pageFile = info.file;
  const isAdvancedPage = /result_advanced\.html$/i.test(pageFile);

  // 防呆：沒有 session 或答案
  if (!sess || !Array.isArray(sess.answers) || sess.answers.length === 0) {
    $('#summary').innerHTML = `
      <div class="warn">
        <p>找不到此次作答資料，或尚未完成作答。</p>
        <p><a href="quiz.html">回到測驗頁</a> 繼續作答，或 <a href="index.html">回首頁</a> 重新開始。</p>
      </div>`;
    return;
  }

  // 若有未完成答案（null），提示並僅以已作答的題計分（可改為直接跳回 quiz）
  const hasNull = sess.answers.some(v => v === null || v === undefined);
  if (hasNull) {
    console.warn('[result] answers incomplete; scoring with answered items only.');
  }

  // 以相同 seed 重建題目 id，對齊答案
  const rebuilt = await rebuildAnswers(sess);
  const modeForScore = isAdvancedPage ? (['advA','advB','advC'].includes(rebuilt.mode) ? rebuilt.mode : 'basic') : 'basic';

  // 初始化權重（依 mode 決定主權重集；進階結果會同時使用 basic + adv 的答案，但權重載入以 adv 集合作為主）
  await Scorer.init(modeForScore);

  // 計分
  const result = await Scorer.score({
    mode: modeForScore,
    answers: rebuilt.pairs, // [{id,value}]
  });

  // 敘述
  const { summary, table, narrative, recos } = Report.buildAll(result);
  $('#summary').innerHTML = Report.toHTML.summary(summary);
  $('#funcTable').innerHTML = Report.toHTML.functionTable(table);
  $('#typeNarrative').innerHTML = Report.toHTML.typeNarrative(narrative);
  $('#reco').innerHTML = Report.toHTML.recommendations(recos);

  // 圖表
  Charts.theme({ mode: 'auto' });
  _radar = Charts.renderRadar(result, '#radarChart', { title: '八功能雷達圖' });
  _bars  = Charts.renderAxesBars(result, '#axesChart', { title: '四大軸傾向' });

  // 功能按鈕
  $('#btnHome')?.addEventListener('click', () => Router.go('home', {}));
  $('#btnCopy')?.addEventListener('click', async () => {
    try {
      const url = new URL(window.location.href);
      // 確保帶上 sid 與 mode
      url.searchParams.set('sid', sess.sessionId);
      url.searchParams.set('mode', sess.mode);
      await navigator.clipboard.writeText(url.toString());
      $('#btnCopy').textContent = '已複製連結 ✓';
      setTimeout(() => ($('#btnCopy') && ($('#btnCopy').textContent = '複製分享連結')), 1500);
    } catch (e) {
      alert('複製失敗，請手動複製網址。');
    }
  });
  $('#btnDLRadar')?.addEventListener('click', () => Charts.downloadPNG(_radar, 'functions_radar.png'));
  $('#btnDLBars')?.addEventListener('click', () => Charts.downloadPNG(_bars, 'axes_bars.png'));
}

// ---------- Auto init ----------
export async function initResultUI() {
  try {
    await render();
  } catch (err) {
    console.error('[result] render failed', err);
    const box = $('#summary') || document.body;
    const div = document.createElement('div');
    div.className = 'warn';
    div.innerHTML = `<p>載入結果時發生錯誤：${err.message || err}</p><p><a href="index.html">回首頁</a></p>`;
    box.appendChild(div);
  }
}

if (document.currentScript && document.readyState !== 'loading') {
  initResultUI();
} else {
  document.addEventListener('DOMContentLoaded', () => initResultUI());
}
