// src/core/charts.js
// Render radar (8 functions) and bars (4 dichotomies) using Chart.js UMD (chart.umd.js).
// Expect global `Chart` available (included via <script src="docs/assets/js/vendor/chart.umd.js"></script>).
//
// Public API:
//   Charts.renderRadar(result, canvas | '#id', opts?)
//   Charts.renderAxesBars(result, canvas | '#id', opts?)
//   Charts.destroyAll()
//   Charts.downloadPNG(chart, filename)
//   Charts.theme({ mode: 'auto'|'light'|'dark' })  // set or get current theme
//
// `result` schema = Scorer.score(...) output.

function $(elOrSel) {
  if (!elOrSel) return null;
  if (typeof elOrSel === 'string') return document.querySelector(elOrSel);
  return elOrSel;
}

function ensureChart() {
  if (typeof window === 'undefined' || !window.Chart) {
    throw new Error('Chart.js not found. Make sure docs/assets/js/vendor/chart.umd.js is loaded before app.min.js.');
  }
  return window.Chart;
}

// ---- theme handling ----
const THEME = {
  mode: 'auto', // 'auto' | 'light' | 'dark'
};

function isDark() {
  if (THEME.mode === 'dark') return true;
  if (THEME.mode === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function palette() {
  const dark = isDark();
  return {
    text: dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)',
    grid: dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
    border: dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)',
    // dataset fills（不指定固定色調；交給 Chart 的預設 + 透明度）
    fill: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
  };
}

// ---- helpers ----
function formatPct(x) {
  // x in 0..100 or -100..+100
  const n = typeof x === 'number' ? x : 0;
  return `${Math.round(n)}%`;
}

function toCanvas(elOrSel) {
  const el = $(elOrSel);
  if (!el) throw new Error('Canvas element not found.');
  if (el.tagName !== 'CANVAS') throw new Error('Target must be a <canvas>.');
  return el.getContext('2d');
}

function labelsFromFuncList(funcList) {
  // Expect Scorer.getFuncMeta().list with .name or .key
  return (funcList || []).map(f => f?.key || f?.name || 'Fn');
}

// Global registry to destroy on rerender
const _registry = new Set();
function track(chart) {
  _registry.add(chart);
  return chart;
}
function destroy(chart) {
  try { chart?.destroy?.(); } catch {}
  _registry.delete(chart);
}

// ---- datasets builders ----
function buildRadarDataset(result, opts = {}) {
  // result.byFunction: [{idx, name, pct}]
  const data = (result?.byFunction || []).map(x => Math.max(0, Math.min(100, x.pct || 0)));

  return {
    label: opts.label || '八功能',
    data,
    fill: true,
    // 不手動指定顏色，維持通用性；改以透明度處理
    backgroundColor: palette().fill,
    borderWidth: 2,
    tension: 0.2,
    pointRadius: 2,
  };
}

function buildAxesBarDatasets(result, opts = {}) {
  // 將四軸換成 -100..+100（負→右字母，正→左字母）
  // 例：EI.pctE = 0..1 → (pctE*200 - 100)
  const axes = result?.axes || {};
  const toSigned = (p) => Math.round(((p || 0) * 200) - 100);

  const values = [
    toSigned(axes.EI?.pctE), // + = E, - = I
    toSigned(axes.NS?.pctN), // + = N, - = S
    toSigned(axes.TF?.pctT), // + = T, - = F
    toSigned(axes.JP?.pctJ), // + = J, - = P
  ];

  return [{
    label: opts.label || '四大軸',
    data: values,
    borderWidth: 1.5,
  }];
}

// ---- public API ----
export const Charts = {
  /**
   * 設定或取得主題模式
   * @param {object} cfg 例如 {mode:'auto'|'light'|'dark'}
   */
  theme(cfg) {
    if (!cfg) return { ...THEME, dark: isDark() };
    if (cfg.mode) THEME.mode = cfg.mode;
    // 使用者改主題後不會自動重畫；呼叫端可自行 destroyAll() + 再 render
    return { ...THEME, dark: isDark() };
  },

  /**
   * 雷達圖（八功能）
   * @param {object} result 來自 Scorer.score(...)
   * @param {HTMLCanvasElement|string} elOrSel
   * @param {object} opts { title?, label?, max=100, showGrid=true }
   */
  renderRadar(result, elOrSel, opts = {}) {
    const Chart = ensureChart();
    const ctx = toCanvas(elOrSel);
    const pal = palette();

    // 嘗試取得功能標籤
    const labels = (result?.byFunction || []).map(x => x?.key || x?.name || `F${x?.idx ?? ''}`);

    const ds = buildRadarDataset(result, { label: opts.label });

    // 先毀掉同 canvas 上的舊圖（Chart v4 會綁在 ctx.canvas._chartInstance？保守做法：loop registry）
    for (const c of _registry) {
      if (c?.ctx?.canvas === ctx.canvas) destroy(c);
    }

    const chart = track(new Chart(ctx, {
      type: 'radar',
      data: {
        labels,
        datasets: [ds],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: { color: pal.text },
          },
          title: {
            display: !!opts.title,
            text: opts.title || '',
            color: pal.text,
            padding: 8,
          },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label || ''}: ${formatPct(ctx.raw)}`,
            },
          },
        },
        scales: {
          r: {
            suggestedMin: 0,
            suggestedMax: opts.max ?? 100,
            ticks: {
              display: true,
              color: pal.text,
              backdropColor: 'transparent',
              showLabelBackdrop: false,
              callback: (v) => `${v}`,
            },
            angleLines: { color: pal.grid },
            grid: { color: pal.grid },
            pointLabels: {
              color: pal.text,
              font: { size: 12 },
            },
          },
        },
        elements: {
          line: { borderColor: pal.border },
          point: { borderColor: pal.border },
        },
      },
    }));

    return chart;
  },

  /**
   * 四大軸長條圖（雙向 -100..+100）
   * @param {object} result 來自 Scorer.score(...)
   * @param {HTMLCanvasElement|string} elOrSel
   * @param {object} opts { title?, label?, barThickness?, categorySpacing? }
   */
  renderAxesBars(result, elOrSel, opts = {}) {
    const Chart = ensureChart();
    const ctx = toCanvas(elOrSel);
    const pal = palette();

    const labels = ['E–I', 'N–S', 'T–F', 'J–P'];
    const datasets = buildAxesBarDatasets(result, { label: opts.label });

    for (const c of _registry) {
      if (c?.ctx?.canvas === ctx.canvas) destroy(c);
    }

    const chart = track(new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: {
          legend: {
            display: false,
            labels: { color: pal.text },
          },
          title: {
            display: !!opts.title,
            text: opts.title || '四大軸傾向',
            color: pal.text,
            padding: 8,
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const raw = Number(ctx.raw || 0);
                const side = ctx.dataIndex === 0 ? (raw >= 0 ? 'E' : 'I')
                          : ctx.dataIndex === 1 ? (raw >= 0 ? 'N' : 'S')
                          : ctx.dataIndex === 2 ? (raw >= 0 ? 'T' : 'F')
                          : (raw >= 0 ? 'J' : 'P');
                return `${side} ${formatPct(Math.abs(raw))}`;
              },
            },
          },
        },
        scales: {
          x: {
            min: -100,
            max: 100,
            grid: { color: pal.grid },
            ticks: {
              color: pal.text,
              callback: (v) => `${v}`,
            },
            border: { color: pal.border },
          },
          y: {
            grid: { color: pal.grid },
            ticks: { color: pal.text },
            border: { color: pal.border },
          },
        },
        elements: {
          bar: {
            borderColor: pal.border,
            borderWidth: 1,
          },
        },
      },
    }));

    return chart;
  },

  /**
   * 下載為 PNG 檔案
   */
  downloadPNG(chart, filename = 'chart.png') {
    if (!chart) return;
    const a = document.createElement('a');
    a.href = chart.toBase64Image('image/png', 1.0);
    a.download = filename;
    a.click();
  },

  /**
   * 銷毀目前所有圖表（換頁或切主題時可呼叫）
   */
  destroyAll() {
    for (const c of Array.from(_registry)) destroy(c);
  },
};
