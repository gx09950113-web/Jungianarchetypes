// src/ui/render-quiz.js
// Quiz page UI glue: render question, 5-point scale, progress & navigation.
// Works with Router + QuizEngine.

import { Router } from '../core/router.js';
import { QuizEngine } from '../core/quiz-engine.js';

const IDS = {
  root: 'quiz-root',
  title: 'qTitle',
  text: 'qText',
  answers: 'answers',
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
    h('div', { id: IDS.answers, class: 'answers' }),
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
  const advPanel = h('div', { id: IDS.advPanel, class: 'quiz-adv-panel' }, [
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

  // If you already have these nodes in quiz.html, we won't duplicate—ensureEl only creates if missing.
  return root;
}

function renderScale(selectedValue) {
  // 5-point Likert: 1..5（也接受 0..4），我們畫 1..5，提交時會轉為 0..4
  const wrap = $(IDS.answers);
  if (!wrap) return;

  const labels = ['非常不同意', '不同意', '中立', '同意', '非常同意'];
  wrap.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const btn = h('button', {
      class: `scale-btn${selectedValue === (i - 1) ? ' selected' : ''}`,
      'data-answer': String(i),
      text: `${i}｜${labels[i - 1]}`,
      onclick: () => onAnswer(i),
    });
    wrap.appendChild(btn);
  }
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

  title && (title.textContent = `榮格八維自測｜${modeName}`);

  // Progress
  const progText = $(IDS.progressText);
  const progBar = $(IDS.progressBar);
  const pct = Math.round(st.progress * 100);
  progText && (progText.textContent = `${Math.min(st.step + 1, st.total)} / ${st.total}（${pct}%）`);
  if (progBar) progBar.style.width = `${pct}%`;

  // Done?
  const advPanel = $(IDS.advPanel);
  if (st.done) {
    // 若是 basic 完成 → 顯示進階選單；否則導向結果
    if (st.mode === 'basic') {
      setHidden(advPanel, false);
      setHidden($(IDS.answers), true);
      setHidden($(IDS.text), false);
      qText && (qText.textContent = '你已完成 32 題。要不要接續進階，取得更細緻的 56 題分析？');
      btnPrev && (btnPrev.disabled = true);
      btnNext && (btnNext.disabled = true);
      btnClear && (btnClear.disabled = true);
      return;
    } else {
      // 進階完成 → 直接導向結果_advanced
      Router.go('result_advanced', { sid: st.sessionId, mode: st.mode });
      return;
    }
  } else {
    setHidden(advPanel, true);
    setHidden($(IDS.answers), false);
  }

  // Render current question
  const item = st.current;
  qText && (qText.textContent = item?.text || item?.title || `(第 ${st.step + 1} 題)`);

  // Selected value (0..4)
  const sel = st.answers?.[st.step];
  renderScale(sel);

  // Nav buttons state
  btnPrev && (btnPrev.disabled = st.step <= 0);
  // 下一題不強制答案，但可依需求改成：btnNext.disabled = (sel == null);
  btnNext && (btnNext.disabled = false);
  btnClear && (btnClear.disabled = (sel == null));
}

// ---------- Event handlers ----------
function onAnswer(v /* 1..5 or 0..4 */) {
  // 交給 QuizEngine 轉 0..4 與寫 session
  _state = QuizEngine.answer(Number(v));
  renderQuestion();

  // 完成即導向
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
  });

  btnNext?.addEventListener('click', () => {
    const st = QuizEngine.getState();
    if (st.step < st.total) {
      _state = QuizEngine.go(st.step + 1);
      renderQuestion();
    } else {
      // 結束節點（在 basic 完成時已被處理）
      if (st.mode !== 'basic') Router.go('result_advanced', { sid: st.sessionId, mode: st.mode });
    }
  });

  btnClear?.addEventListener('click', () => {
    const st = QuizEngine.getState();
    const ans = st.answers.slice();
    ans[st.step] = null;
    // 直接呼叫 Router.updateSession 更新答案
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
  // 1..5 作答、0..4 也接受；← → 導航；Backspace/R 清除
  document.addEventListener('keydown', (e) => {
    const st = QuizEngine.getState();
    if (st.done) return;

    const k = e.key;
    if (/^[1-5]$/.test(k)) {
      onAnswer(Number(k));
      e.preventDefault();
      return;
    }
    if (/^[0-4]$/.test(k)) {
      onAnswer(Number(k)); // 0..4 也行，會由引擎正規化
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
  // 確保有基本骨架與事件綁定
  buildSkeleton();
  bindNav();
  bindAdvancedPanel();
  bindKeyboard();

  // 啟用離開提醒
  Router.setLeaveGuard(true);

  // 讀取 URL 參數並啟動引擎
  const { query } = Router.current();
  const mode = query.mode || 'basic';
  await QuizEngine.bootstrap({ mode, sid: query.sid });

  _state = QuizEngine.getState();
  renderQuestion();
}

// 自動初始化（若頁面直接引入此模組且沒有其他入口）
if (document.currentScript && document.readyState !== 'loading') {
  // 若你的 app.js 會主動呼叫 initQuizUI()，可以刪除這段自動啟動
  // 這段僅作為保險，避免忘記初始化
  initQuizUI().catch((err) => {
    console.error('[quiz] init failed', err);
  });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    initQuizUI().catch((err) => {
      console.error('[quiz] init failed', err);
    });
  });
}
