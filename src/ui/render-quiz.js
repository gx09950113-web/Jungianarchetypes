// src/ui/render-quiz.js
// Quiz page UI glue: render question, A/B fixed cards, centered 5-point scale, progress & navigation.
// Works with Router + QuizEngine.

import { Router } from '../core/router.js';
import { QuizEngine } from '../core/quiz-engine.js';

const IDS = {
  root: 'quiz-root',
  title: 'qTitle',
  text: 'qText',       // 我們會把題幹 + A/B 固定卡片都塞進這裡（innerHTML）
  answers: 'answers',  // 下方置中 5 點量表（可點）
  navPrev: 'btnPrev',
  navNext: 'btnNext',
  navClear: 'btnClear',
  progressWrap: 'progress',
  progressBar: 'progressBar',
  progressText: 'progressText',
  advPanel: 'advPanel',
};

let _state = null; // cache of QuizEngine.getState()

// ---------- DOM helpers ----------
function $(selOrEl) {
  if (!selOrEl) return null;
  if (typeof selOrEl === 'string') return document.getElementById(selOrEl) || document.querySelector(selOrEl);
  return selOrEl;
}
function ensureEl(tag, id, parent, className) {
  let el = $(`#${id}`);
  if (!el) {
    el = document.createElement(tag);
    el.id = id;
    if (className) el.className = className;
    (parent || document.body).appendChild(el);
  }
  return el;
}
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') el.className = v || '';
    else if (k === 'text') el.textContent = v ?? '';
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  });
  children.forEach((c) => el.appendChild(c));
  return el;
}
function setHidden(el, hidden) {
  if (!el) return;
  el.style.display = hidden ? 'none' : '';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- UI builders ----------
function buildSkeleton() {
  const root = ensureEl('div', IDS.root, document.body, 'quiz-root');

  // Header
  const header = h('div', { class: 'quiz-header' }, [
    h('h2', { id: IDS.title, text: '測驗進行中' }),
  ]);

  // Question block
  const qBlock = h('div', { class: 'quiz-qblock' }, [
    h('div', { id: IDS.text, class: 'question', text: '' }),
    h('div', { id: IDS.answers, class: 'answers', role: 'group', 'aria-label': '五點量表' }),
  ]);

  // Nav buttons
  const nav = h('div', { class: 'quiz-nav' }, [
    h('button', { id: IDS.navPrev, class: 'btn prev', text: '← 上一題' }),
    h('button', { id: IDS.navClear, class: 'btn clear', text: '清除本題' }),
    h('button', { id: IDS.navNext, class: 'btn next', text: '下一題 →' }),
  ]);

  // Progress
  const progress = h('div', { id: IDS.progressWrap, class: 'quiz-progress' }, [
    h('div', { id: IDS.progressText, class: 'progress-text', text: '0 / 0（0%）' }),
    h('div', { class: 'progress-bar-wrap' }, [
      h('div', { id: IDS.progressBar, class: 'progress-bar' }),
    ]),
  ]);

  // Advanced panel (after basic complete)
  const advPanel = h('div', { id: IDS.advPanel, class: 'quiz-adv-panel', style: 'display:none' }, [
    h('h3', { text: '想要更完整的 56 題結果嗎？' }),
    h('p', { class: 'muted', text: '你可以選擇接續進階題組，或直接查看 32 題結果。' }),
    h('div', { class: 'adv-actions' }, [
      h('button', { class: 'btn ghost', id: 'btnAdvA', text: '進階 A 組' }),
      h('button', { class: 'btn ghost', id: 'btnAdvB', text: '進階 B 組' }),
      h('button', { class: 'btn ghost', id: 'btnAdvC', text: '進階 C 組' }),
      h('button', { class: 'btn primary', id: 'btnSeeBasic', text: '直接看 32 題結果' }),
    ]),
  ]);

  // Mount
  root.replaceChildren(header, qBlock, nav, progress, advPanel);
  return root;
}

function renderScale(selectedValue) {
  // 5-point Likert, 顯示 A/B 語意，並置中排列（CSS 已處理 .scale-wrap）
  const wrap = $(IDS.answers);
  if (!wrap) return;

  const labels = ['非常同意A','較同意A','中立','較同意B','非常同意B'];
  wrap.innerHTML = '';
  const scaleWrap = h('div', { class: 'scale-wrap' });

  for (let i = 0; i < 5; i++) {
    const val = [-2, -1, 0, 1, 2][i]; // 內部記錄統一為 -2..2，交給引擎正規化
    const btn = h('button', {
      class: `scale-btn${selectedValue === (val + 2) ? ' selected' : ''}`, // selectedValue 目前多半存 0..4
      'data-val': String(val),
    }, [
      h('span', { class: 'k', text: String(i + 1) }),
      h('span', { class: 't', text: labels[i] }),
    ]);
    btn.addEventListener('click', () => onAnswer(val));
    scaleWrap.appendChild(btn);
  }
  wrap.appendChild(scaleWrap);
}

function buildABCardsHTML(item) {
  // 優先讀 items 的典型欄位：stem + options[0]/[1]
  const stem = item?.stem ?? item?.text ?? item?.title ?? '';
  // 支援多種欄位命名：options/opts/choices、或 A/B
  const optA = item?.options?.[0] ?? item?.opts?.[0] ?? item?.choices?.[0] ?? item?.A ?? item?.a ?? '選項 A';
  const optB = item?.options?.[1] ?? item?.opts?.[1] ?? item?.choices?.[1] ?? item?.B ?? item?.b ?? '選項 B';

  return `
    <div class="qid">第 ${_state ? (_state.step + 1) : '?'} 題 / 共 ${_state?.total ?? '?' } 題</div>
    <div class="stem">${escapeHtml(stem)}</div>
    <div class="pair-cards" aria-hidden="true">
      <div class="pair-card A">
        <span class="title">A</span>
        <p>${escapeHtml(optA)}</p>
      </div>
      <div class="pair-card B">
        <span class="title">B</span>
        <p>${escapeHtml(optB)}</p>
      </div>
    </div>
  `;
}

function renderQuestion() {
  const st = _state;
  const title = $(IDS.title);
  const qText = $(IDS.text);
  const btnPrev = $(IDS.navPrev);
  const btnNext = $(IDS.navNext);
  const btnClear = $(IDS.navClear);

  if (!st) return;

  // Header title
  const modeName =
    st.mode === 'basic' ? '32 題' :
    st.mode === 'advA'  ? '進階 A 組' :
    st.mode === 'advB'  ? '進階 B 組' :
    st.mode === 'advC'  ? '進階 C 組' : st.mode;

  if (title) title.textContent = `榮格八維自測｜${modeName}`;

  // Progress
  const progText = $(IDS.progressText);
  const progBar = $(IDS.progressBar);
  const pct = Math.round(st.progress * 100);
  if (progText) progText.textContent = `${Math.min(st.step + 1, st.total)} / ${st.total}（${pct}%）`;
  if (progBar)  progBar.style.width = `${pct}%`;

  // Done?
  const advPanel = $(IDS.advPanel);
  if (st.done) {
    if (st.mode === 'basic') {
      // 顯示進階選單
      setHidden(advPanel, false);
      setHidden($(IDS.answers), true);
      if (qText) {
        qText.innerHTML = `
          <div class="stem">你已完成 32 題。要不要接續進階，取得更細緻的 56 題分析？</div>
        `;
      }
      if (btnPrev) btnPrev.disabled = true;
      if (btnNext) btnNext.disabled = true;
      if (btnClear) btnClear.disabled = true;

      // 滑到面板，避免行動裝置底部工具列卡住
      try { advPanel.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
      return;
    } else {
      // 進階完成 → 直接導向進階結果
      Router.go('result_advanced', { sid: st.sessionId, mode: st.mode });
      return;
    }
  } else {
    setHidden(advPanel, true);
    setHidden($(IDS.answers), false);
  }

  // Render current question：題幹 + A/B 卡片 + 置中量表
  const item = st.current;
  if (qText) qText.innerHTML = buildABCardsHTML(item);

  // selectedValue 目前多半以 0..4 儲存（由 QuizEngine 正規化）
  const sel04 = st.answers?.[st.step]; // 0..4 或 null
  renderScale(sel04);

  // Nav buttons state
  if (btnPrev)  btnPrev.disabled  = (st.step <= 0);
  if (btnNext)  btnNext.disabled  = false; // 若想強制作答才可下一題，可改為 (sel04 == null)
  if (btnClear) btnClear.disabled = (sel04 == null);

  // 行動裝置小優化：切換題目時微調捲動，避免底部工具列卡住無法上滑
  try { window.scrollBy({ top: 16, behavior: 'smooth' }); } catch {}
}

// ---------- Event handlers ----------
function onAnswer(v /* internal -2..2 */) {
  // QuizEngine 會把 -2..2 / 1..5 / 0..4 正規化為 0..4 儲存
  _state = QuizEngine.answer(Number(v));
  renderQuestion();

  // 完成即導向或顯示面板
  if (_state.done) {
    if (_state.mode === 'basic') {
      renderQuestion(); // 顯示進階面板
    } else {
      Router.go('result_advanced', { sid: _state.sessionId, mode: _state.mode });
    }
  }
}

function bindNav() {
  const btnPrev = $(IDS.navPrev);
  const btnNext = $(IDS.navNext);
  const btnClear = $(IDS.navClear);

  btnPrev?.addEventListener('click', () => {
    const st = QuizEngine.getState();
    const idx = Math.max(0, st.step - 1);
    _state = QuizEngine.go(idx);
    renderQuestion();
    try { window.scrollBy({ top: -24, behavior: 'smooth' }); } catch {}
  });

  btnNext?.addEventListener('click', () => {
    const st = QuizEngine.getState();
    if (st.step < st.total) {
      _state = QuizEngine.go(st.step + 1);
      renderQuestion();
      try { window.scrollBy({ top: 24, behavior: 'smooth' }); } catch {}
    } else {
      if (st.mode !== 'basic') Router.go('result_advanced', { sid: st.sessionId, mode: st.mode });
    }
  });

  btnClear?.addEventListener('click', () => {
    const st = QuizEngine.getState();
    const ans = st.answers.slice();
    ans[st.step] = null;
    _state = Router.updateSession(st.sessionId, { answers: ans });
    renderQuestion();
  });
}

function bindAdvancedPanel() {
  const advA = $('#btnAdvA');
  const advB = $('#btnAdvB');
  const advC = $('#btnAdvC');
  const seeBasic = $('#btnSeeBasic');

  advA?.addEventListener('click', async () => {
    await QuizEngine.continueToAdvanced('advA');
    _state = QuizEngine.getState();
    renderQuestion();
    scrollToTop();
  });
  advB?.addEventListener('click', async () => {
    await QuizEngine.continueToAdvanced('advB');
    _state = QuizEngine.getState();
    renderQuestion();
    scrollToTop();
  });
  advC?.addEventListener('click', async () => {
    await QuizEngine.continueToAdvanced('advC');
    _state = QuizEngine.getState();
    renderQuestion();
    scrollToTop();
  });
  seeBasic?.addEventListener('click', () => {
    const st = QuizEngine.getState();
    Router.go('result_basic', { sid: st.sessionId, mode: 'basic' });
  });
}

function bindKeyboard() {
  // 1..5 → 對應 -2..2；0..4 也接受；← → 導航；Backspace/R 清除
  document.addEventListener('keydown', (e) => {
    const st = QuizEngine.getState();
    if (st.done) return;

    const k = e.key;
    if (/^[1-5]$/.test(k)) {
      const map = { '1': -2, '2': -1, '3': 0, '4': 1, '5': 2 };
      onAnswer(map[k]);
      e.preventDefault();
      return;
    }
    if (/^[0-4]$/.test(k)) {
      // 若按 0..4，也允許：轉成 -2..2
      const val = Number(k) - 2;
      onAnswer(val);
      e.preventDefault();
      return;
    }
    if (k === 'ArrowLeft') {
      _state = QuizEngine.go(Math.max(0, st.step - 1));
      renderQuestion();
      e.preventDefault();
      return;
    }
    if (k === 'ArrowRight') {
      _state = QuizEngine.go(Math.min(st.total, st.step + 1));
      renderQuestion();
      e.preventDefault();
      return;
    }
    if (k === 'Backspace' || k.toLowerCase() === 'r') {
      const ans = st.answers.slice();
      ans[st.step] = null;
      _state = Router.updateSession(st.sessionId, { answers: ans });
      renderQuestion();
      e.preventDefault();
    }
  });
}

function scrollToTop() {
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
}

// ---------- Init ----------
export async function initQuizUI() {
  buildSkeleton();
  bindNav();
  bindAdvancedPanel();
  bindKeyboard();

  // 啟用離開提醒
  Router.setLeaveGuard(true);

  // 啟動引擎
  const { query } = Router.current();
  const mode = query.mode || 'basic';
  await QuizEngine.bootstrap({ mode, sid: query.sid });

  _state = QuizEngine.getState();
  renderQuestion();
}

// 自動初始化
if (document.currentScript && document.readyState !== 'loading') {
  initQuizUI().catch((err) => { console.error('[quiz] init failed', err); });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    initQuizUI().catch((err) => { console.error('[quiz] init failed', err); });
  });
}