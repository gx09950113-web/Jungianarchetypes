// src/app.js
// Entry point – imports modules and wires up index page actions.
// quiz.html / result_*.html 的初始化：
// - render-quiz.js：內含自啟
// - render-result.js：我們在這裡統一呼叫 bootRenderResultByPage() 以確保執行

let Router = null;
try {
  // 某些情況（例如簡化測試）可能沒有 Router；保護性載入
  ({ Router } = await import('./core/router.js'));
} catch {
  // 沒有 Router 也不致命，只是首頁「開始/續上次」會退化
  Router = null;
}

// 這兩個模組會被 bundle，並且我們會在 boot() 內顯式啟動結果頁渲染
import './ui/render-quiz.js';
import { bootRenderResultByPage } from './ui/render-result.js';

// ---- 小工具 ----
function $(sel) { return document.querySelector(sel); }
function on(el, ev, fn) { el && el.addEventListener(ev, fn); }
function pageFile() {
  const parts = window.location.pathname.split('/');
  return parts[parts.length - 1] || 'index.html';
}

// 嘗試抓取 build manifest（僅用於顯示版本與時間戳）
async function fetchManifest() {
  try {
    const url = new URL('assets/js/weights.manifest.json', document.baseURI).href;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 在 index 頁放一些便利功能
async function initHome() {
  // 版本資訊（可選）
  const verBox = $('#buildInfo');
  if (verBox) {
    const m = await fetchManifest();
    if (m?.ts) {
      const ts = new Date(m.ts);
      verBox.textContent = `版號 v${m.version ?? 1}｜建置時間 ${ts.toLocaleString()}`;
    }
  }

  // 沒有 Router 的情況下：退化成直接跳連結
  const hasRouter = !!Router?.ensureSession && !!Router?.go && !!Router?.current;

  // 按鈕：開始 32 題
  on($('#btnStart32'), 'click', () => {
    if (hasRouter) {
      const sess = Router.ensureSession({ mode: 'basic' });
      Router.go('quiz', { mode: 'basic', sid: sess.sessionId });
    } else {
      // 退化：直接換頁
      location.href = './quiz.html?mode=basic';
    }
  });

  // 按鈕：續上次測驗（同分頁才有 sessionStorage）
  const btnContinue = $('#btnContinue');
  if (btnContinue) {
    const sid = findAnyCurrentTabSessionId();
    if (!sid) {
      btnContinue.disabled = true;
      btnContinue.title = '此分頁尚無進行中的作答';
    } else {
      btnContinue.disabled = false;
      on(btnContinue, 'click', () => {
        if (hasRouter) {
          // 沿用原本記錄的 mode（若沒有則 basic）
          const s = Router.current().session || tryLoadSessionById(sid);
          const mode = s?.mode || 'basic';
          Router.go('quiz', { mode, sid });
        } else {
          // 退化：直接回 basic
          location.href = './quiz.html?mode=basic';
        }
      });
    }
  }

  // 按鈕：清除這個分頁的作答（僅清 sessionStorage）
  on($('#btnClearThisTab'), 'click', () => {
    try {
      const keys = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith('jung8v:sess:v')) keys.push(k);
      }
      keys.forEach((k) => sessionStorage.removeItem(k));
      alert('已清除此分頁的作答。');
      location.reload();
    } catch {
      alert('清除失敗，請檢查瀏覽器權限。');
    }
  });
}

// 嘗試找出這個分頁現有的任何 sessionId
function findAnyCurrentTabSessionId() {
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('jung8v:sess:v')) {
        const raw = sessionStorage.getItem(k);
        const obj = JSON.parse(raw || 'null');
        if (obj?.sessionId) return obj.sessionId;
      }
    }
  } catch {}
  return null;
}
function tryLoadSessionById(sid) {
  try {
    const raw = sessionStorage.getItem(`jung8v:sess:v1:${sid}`);
    return JSON.parse(raw || 'null');
  } catch {
    return null;
  }
}

// ---- 入口：依頁面分派 ----
function boot() {
  const file = pageFile();

  // index.html：建首頁互動
  if (/^index\.html$/i.test(file) || file === '') {
    initHome();
  }

  // quiz.html、result_*.html：
  // - render-quiz.js 內部會在 DOMContentLoaded 自啟
  // - 結果頁我們顯式呼叫 bootRenderResultByPage() 確保渲染
  bootRenderResultByPage();
}

// 等待 DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}