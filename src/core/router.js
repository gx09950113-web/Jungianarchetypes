// src/core/router.js
// Minimal router & state persistence for Jung 8D self-test site
// Pages (physical): index.html, quiz.html, result_basic.html, result_advanced.html
// Query schema: ?mode=basic|advancedA|advancedB|advancedC&sid=<sessionId>
// Storage:
//   - localStorage: app-level settings, history
//   - sessionStorage: current quiz session (ephemeral to tab)
// Versioned & namespaced to avoid collisions across deployments.

const VERSION = 1;
const NS = 'jung8v';
const KEY_APP = `${NS}:app:v${VERSION}`;
const KEY_SESS = (sid) => `${NS}:sess:v${VERSION}:${sid}`;

const PAGES = {
  home: 'index.html',
  quiz: 'quiz.html',
  result_basic: 'result_basic.html',
  result_advanced: 'result_advanced.html',
};

// ---- URL helpers ----
function parseQuery(search = window.location.search) {
  const p = new URLSearchParams(search);
  const obj = {};
  for (const [k, v] of p.entries()) obj[k] = v;
  return obj;
}
function buildQuery(obj = {}) {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : '';
}
function pageFile() {
  // e.g. "/your-repo/docs/quiz.html" -> "quiz.html"
  const parts = window.location.pathname.split('/');
  return parts[parts.length - 1] || 'index.html';
}

// ---- storage helpers ----
function safeGetLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function safeSetLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}
function safeGetSS(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function safeSetSS(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}
function safeRemoveSS(key) {
  try { sessionStorage.removeItem(key); } catch {}
}

// ---- app-level state (non-sensitive) ----
function getAppState() {
  const def = {
    lastVisited: null,
    history: [], // [{ts, page, query}]
    settings: {
      // put future UI toggles here
    },
  };
  const s = safeGetLS(KEY_APP, def);
  // 保持結構穩定
  return { ...def, ...s, settings: { ...def.settings, ...(s?.settings || {}) } };
}
function setAppState(next) {
  safeSetLS(KEY_APP, next);
}

// ---- session model ----
// Minimal session schema used by quiz-engine/scorer:
// {
//   sessionId: string,
//   mode: "basic" | "advA" | "advB" | "advC",
//   step: number,             // answered count or page index
//   answers: Array<number>,   // 5-point scale answers (0..4 or 1..5, 依 quiz-engine 定義)
//   seed: string,             // shuffle seed
//   meta: { startedAt, finishedAt?, extra? }
// }
function newSession({ mode, seed, sessionId }) {
  return {
    sessionId,
    mode,     // "basic" | "advA" | "advB" | "advC"
    step: 0,
    answers: [],
    seed: seed || String(Math.random()).slice(2),
    meta: { startedAt: new Date().toISOString() },
  };
}
function loadSession(sessionId) {
  return safeGetSS(KEY_SESS(sessionId), null);
}
function saveSession(sess) {
  safeSetSS(KEY_SESS(sess.sessionId), sess);
}
function clearSession(sessionId) {
  safeRemoveSS(KEY_SESS(sessionId));
}

// ---- route change observers ----
const listeners = new Set();
function emitChange() {
  const info = Router.current();
  listeners.forEach((fn) => {
    try { fn(info); } catch {}
  });
}

// ---- leave guard ----
let leaveGuardEnabled = true;
function beforeUnloadHandler(e) {
  if (!leaveGuardEnabled) return;
  const info = Router.current();
  // 只有在 quiz 進行中且尚未完成時提示
  if (info.page === 'quiz' && info.session?.answers?.length > 0 && !info.session?.meta?.finishedAt) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
}

// ---- public API ----
export const Router = {
  // 當前路由資訊（純讀）
  current() {
    const file = pageFile();
    const page = Object.entries(PAGES).find(([, f]) => f === file)?.[0] || 'home';
    const query = parseQuery();
    const sessionId = query.sid || null;
    const session = sessionId ? loadSession(sessionId) : null;
    return { page, file, query, session };
  },

  // 導航到特定頁（會更新 history 與 app-level 狀態）
  go(page, params = {}, { replace = false } = {}) {
    if (!PAGES[page]) throw new Error(`Unknown page: ${page}`);
    const targetFile = PAGES[page];
    const q = buildQuery(params);
    const url = `${targetFile}${q}`;

    const app = getAppState();
    app.lastVisited = { ts: Date.now(), page, query: params };
    app.history.push({ ts: Date.now(), page, query: params });
    // 避免無限膨脹，保留最近 50 筆
    if (app.history.length > 50) app.history = app.history.slice(-50);
    setAppState(app);

    if (replace) {
      window.location.replace(url);
    } else {
      window.location.href = url;
    }
  },

  // 建立或恢復 session。若提供 sid 且存在則直接讀取，否則建立新 session
  ensureSession({ mode, sid, seed } = {}) {
    if (!mode) throw new Error('ensureSession requires mode');
    let sessionId = sid || crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let sess = sid ? loadSession(sid) : null;
    if (!sess) {
      sess = newSession({ mode, seed, sessionId });
      saveSession(sess);
    }
    return sess;
  },

  // 更新 session（部分欄位）
  updateSession(sessionId, patch) {
    const curr = loadSession(sessionId);
    if (!curr) throw new Error('Session not found');
    const next = { ...curr, ...patch };
    saveSession(next);
    emitChange();
    return next;
  },

  // 標記完成（寫入 finishedAt）
  finishSession(sessionId, extra = {}) {
    const curr = loadSession(sessionId);
    if (!curr) return null;
    const next = {
      ...curr,
      meta: { ...curr.meta, finishedAt: new Date().toISOString(), ...extra },
    };
    saveSession(next);
    emitChange();
    return next;
  },

  // 清理（通常在看完結果後）
  clearSession(sessionId) {
    clearSession(sessionId);
    emitChange();
  },

  // 啟用/停用離開提醒
  setLeaveGuard(enabled) {
    leaveGuardEnabled = !!enabled;
  },

  // 監聽路由或 session 變化（像是進度條/標題要更新時）
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // 用於單頁元件初始化：記錄首次造訪
  markVisited(label) {
    const app = getAppState();
    app.lastVisited = { ts: Date.now(), page: label, query: parseQuery() };
    setAppState(app);
  },
};

// ---- wire browser events ----
window.addEventListener('beforeunload', beforeUnloadHandler);

// 若使用 browser 的前進/後退（不同檔案之間其實會整頁刷新）—這裡主要給單頁應用時用；
// 在本專案（多 html）下，仍保留以便未來擴充成單頁。
window.addEventListener('popstate', () => emitChange());

// 小工具：把 "?sid=..." 補到網址（避免分享時遺失）
// 只在 quiz.html 上且已經有 session 時嘗試補上
(function ensureSidInURL() {
  const file = pageFile();
  if (file !== PAGES.quiz) return;
  const q = parseQuery();
  if (q.sid) return;
  // 試圖找出最近一個 session（當頁籤 sessionStorage 只會有本次）
  // 由 quiz-engine 呼叫 ensureSession 後會有明確的 sid，此處僅作保險
})();
