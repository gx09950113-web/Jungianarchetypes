// src/core/quiz-engine.js
// Quiz flow manager: load items, seeded shuffle, 5-point answering, session sync.
// Data source (public text only):
//   docs/data/items_public_32.json
//   docs/data/items_public_adv_A.json
//   docs/data/items_public_adv_B.json
//   docs/data/items_public_adv_C.json
//
// Works with Router session schema defined in router.js
// session fields used here: { sessionId, mode, step, answers[], seed, meta }

import { Router } from './router.js';

// ---------- Config ----------
const DATA_BASE = 'data'; // relative to docs/* pages
const FILES = {
  basic: 'items_public_32.json',
  advA:  'items_public_adv_A.json',
  advB:  'items_public_adv_B.json',
  advC:  'items_public_adv_C.json',
};

// 題目最小欄位假設：{ id: string|number, text: string, ... }
// 若有更豐富欄位（如 group、tags），會原樣保留於 items 陣列中

// ---------- Tiny seeded RNG (xorshift128+) ----------
function makePRNG(seedStr) {
  // 將字串散列為 4 個 32-bit 整數，作為 state
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
    // xorshift128+
    const t = a ^ (a << 11);
    a = b; b = c; c = d;
    d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    // 轉為 [0,1)
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

// ---------- Internal state (per page load) ----------
let _sess = null;
let _items = [];          // 洗牌後的題目
let _indexMap = [];       // 洗牌後 -> 原始 index
let _mode = 'basic';      // 'basic' | 'advA' | 'advB' | 'advC'

// ---------- Loaders ----------
async function fetchJSON(relPath) {
  // 當前頁面位於 docs/*.html，資料夾為 docs/data/*
  // 用相對路徑存取： 'data/xxx.json'
  const url = `${DATA_BASE}/${relPath}`;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status}`);
  }
  return res.json();
}

async function loadBankForMode(mode) {
  const file =
    mode === 'basic' ? FILES.basic :
    mode === 'advA'  ? FILES.advA  :
    mode === 'advB'  ? FILES.advB  :
    mode === 'advC'  ? FILES.advC  : null;

  if (!file) throw new Error(`Unknown quiz mode: ${mode}`);
  return fetchJSON(file);
}

// ---------- Helpers ----------
function normalizeAnswerValue(v) {
  // 支援 1..5 或 0..4；最後一律轉為 0..4
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  if (n >= 1 && n <= 5) return n - 1;
  if (n >= 0 && n <= 4) return n;
  return null;
}

function clamp(i, min, max) {
  return Math.max(min, Math.min(max, i));
}

// 以 session.answers 長度視為 step，亦支援中途修改回寫
function recomputeStepFromAnswers(ans) {
  // 規則：step = 第一個未作答的 index；若全滿則 = items.length
  const idx = ans.findIndex((v) => v === null || v === undefined);
  return idx === -1 ? ans.length : idx;
}

// ---------- Public API ----------
export const QuizEngine = {
  /**
   * 初始化測驗：
   * - 保證 session 存在（如果給 sid 且存在就用舊的）
   * - 下載對應題庫，依 seed 洗牌
   * - 依 session.answers 長度恢復進度
   */
  async bootstrap({ mode, sid } = {}) {
    // 1) 透過 Router 確保 session
    const ensured = Router.ensureSession({ mode, sid });
    _sess = ensured;
    _mode = ensured.mode;

    // 2) 載入題庫
    const bank = await loadBankForMode(_mode);

    // 支援題目原始陣列或是 {items:[...]} 結構
    const list = Array.isArray(bank) ? bank : Array.isArray(bank.items) ? bank.items : [];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`Empty item list for mode=${_mode}`);
    }

    // 3) 洗牌（可重現）
    const shuffled = shuffleSeeded(list, _sess.seed);

    // 4) 建立 indexMap（洗牌後每題對應到原始題目的 id / index）
    _items = shuffled.map((it, idx) => {
      // 確保每題有 id；若缺少則自動補
      if (typeof it.id === 'undefined' || it.id === null) {
        return { ...it, id: `q${idx + 1}` };
      }
      return it;
    });
    _indexMap = _items.map((_, i) => i);

    // 5) 同步 answers 長度（允許舊 session 繼續）
    const N = _items.length;
    const answers = Array.isArray(_sess.answers) ? _sess.answers.slice() : [];
    if (answers.length < N) {
      answers.push(...Array(N - answers.length).fill(null));
    } else if (answers.length > N) {
      answers.length = N;
    }

    // 6) step 校正
    const step = recomputeStepFromAnswers(answers);
    _sess = Router.updateSession(_sess.sessionId, { answers, step });

    return this.getState();
  },

  /**
   * 回傳目前引擎狀態（不含重量資料）
   */
  getState() {
    if (!_sess) throw new Error('QuizEngine not bootstrapped');
    const { sessionId, step, answers, seed, meta } = _sess;
    const total = _items.length;
    const idx = clamp(step, 0, total); // step==total 表完成
    const current = idx < total ? _items[idx] : null;

    return {
      sessionId,
      mode: _mode,
      seed,
      meta,
      total,
      step: idx,
      done: idx >= total,
      progress: total ? Math.min(1, idx / total) : 0,
      current,        // {id, text, ...} or null
      items: _items,  // 注意：請勿顯示權重，這裡只有文字題幹
      answers,        // 陣列（每題 0..4 或 null）
    };
  },

  /**
   * 提交答案（value 支援 1..5 或 0..4）
   */
  answer(value) {
    if (!_sess) throw new Error('QuizEngine not bootstrapped');
    const v = normalizeAnswerValue(value);
    if (v === null) throw new Error('answer(value) expects 0..4 or 1..5');

    const { step, answers } = _sess;
    if (step >= _items.length) {
      return this.getState(); // 已完成，忽略
    }
    const nextAnswers = answers.slice();
    nextAnswers[step] = v;

    const nextStep = step + 1;
    _sess = Router.updateSession(_sess.sessionId, { answers: nextAnswers, step: nextStep });

    return this.getState();
  },

  /**
   * 跳到第 index 題（0-based），用於返回修改答案或頁面 direct nav
   */
  go(index) {
    if (!_sess) throw new Error('QuizEngine not bootstrapped');
    const i = clamp(index, 0, _items.length);
    _sess = Router.updateSession(_sess.sessionId, { step: i });
    return this.getState();
  },

  /**
   * 是否完成全部題目
   */
  isComplete() {
    if (!_sess) return false;
    return _sess.step >= _items.length;
  },

  /**
   * 完成作答（寫 finishedAt），回傳彙整資料（給 scorer 用）
   */
  finish(extraMeta = {}) {
    if (!_sess) throw new Error('QuizEngine not bootstrapped');
    // 防呆：若還有 null，視為未完成
    const incomplete = _sess.answers.some((v) => v === null || v === undefined);
    if (incomplete) throw new Error('Cannot finish: some answers are empty');

    _sess = Router.finishSession(_sess.sessionId, { ...extraMeta });

    return {
      sessionId: _sess.sessionId,
      mode: _mode,
      total: _items.length,
      answers: this.exportAnswers(), // [{id, value}]
      seed: _sess.seed,
      meta: _sess.meta,
    };
  },

  /**
   * basic（32 題）完成後，銜接進階題組（24+?）
   * kind: 'advA' | 'advB' | 'advC'
   * 作法：在同一個 session 延伸題目；新的題庫將接續 append。
   */
  async continueToAdvanced(kind) {
    if (!_sess) throw new Error('QuizEngine not bootstrapped');
    if (_mode !== 'basic') {
      throw new Error('continueToAdvanced only allowed after basic mode');
    }
    const advMode = kind === 'advA' || kind === 'advB' || kind === 'advC' ? kind : null;
    if (!advMode) throw new Error('Invalid advanced kind. Use advA | advB | advC');

    // 載入進階題庫（或依需要可根據 basic 的表現決定分支）
    const bank = await loadBankForMode(advMode);
    const list = Array.isArray(bank) ? bank : Array.isArray(bank.items) ? bank.items : [];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`Empty item list for ${advMode}`);
    }

    // 用同一個 seed 再洗牌（確保可重現）
    const shuffled = shuffleSeeded(list, _sess.seed);

    // 合併題目
    const startLen = _items.length;
    const appended = shuffled.map((it, idx) => {
      if (typeof it.id === 'undefined' || it.id === null) {
        return { ...it, id: `a${idx + 1}` };
      }
      return it;
    });

    _items = _items.concat(appended);
    _indexMap = _items.map((_, i) => i);

    // 延長 answers 陣列（填 null）
    const answers = _sess.answers.slice();
    const added = appended.length;
    answers.push(...Array(added).fill(null));

    // 更新 mode → 標記為已進階（你也可以選擇保留 mode=basic，額外記錄 advancedKind）
    _mode = advMode;

    _sess = Router.updateSession(_sess.sessionId, {
      mode: _mode,
      answers,
      // step 保持原樣（讓使用者從先前的 step 繼續往下）
    });

    return this.getState();
  },

  /**
   * 導出答案（id 與 value），供 scorer 計分使用。
   * value 一律為 0..4
   */
  exportAnswers() {
    if (!_sess) throw new Error('QuizEngine not bootstrapped');
    return _items.map((it, i) => {
      const raw = _sess.answers[i];
      const v = normalizeAnswerValue(raw);
      return { id: String(it.id), value: v === null ? null : v };
    });
  },
};

// ---------- Convenience: page bootstrap helper ----------
// 在 quiz.html 的初始化程式可以這樣用：
// const { query } = Router.current();
// await QuizEngine.bootstrap({ mode: (query.mode || 'basic'), sid: query.sid });
