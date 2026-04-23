"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
let SQL    = null;
let db     = null;
let worker = null;
let workerReady = false;
let arimaxWorker = null;
let arimaxWorkerReady = false;
let pendingCallbacks = {};  // id -> { resolve, reject }
let msgId = 0;

let allSymbols      = [];
let selectedSymbols = [];
const MAX_SYMBOLS   = 10;
const PREFS_KEY     = "arima_prefs";

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  bindUI();
  loadPrefs();

  setStatus("⏳ Đang tải thư viện...");

  // Load sql.js and arima worker in parallel
  await Promise.all([initSqlLib(), initWorker(), initArimaxWorker()]);

  // Auto-fetch stocks.db from same host
  await fetchDb();
});

async function initSqlLib() {
  SQL = await initSqlJs({
    locateFile: f => `https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/${f}`
  });
}

function initWorker() {
  return new Promise((resolve, reject) => {
    worker = new Worker("arima.worker.js");
    worker.onmessage = handleWorkerMessage;
    worker.onerror   = e => { setStatus("❌ Worker lỗi: " + e.message); reject(e); };

    const id = ++msgId;
    pendingCallbacks[id] = {
      resolve: () => { workerReady = true; resolve(); },
      reject,
    };
    worker.postMessage({ id, type: "init" });
  });
}

function initArimaxWorker() {
  return new Promise((resolve, reject) => {
    arimaxWorker = new Worker("arimax.worker.js");
    arimaxWorker.onmessage = handleArimaxWorkerMessage;
    arimaxWorker.onerror   = e => { setArimaxStatus("❌ ARIMAX Worker lỗi: " + e.message); reject(e); };

    const id = ++msgId;
    pendingCallbacks[id] = {
      resolve: () => { arimaxWorkerReady = true; resolve(); },
      reject,
    };
    arimaxWorker.postMessage({ id, type: "init" });
  });
}

// ── DB caching (Cache API, invalidate daily) ──────────────────────────────────
const DB_CACHE_NAME = "arima-stocks-db";
const DB_CACHE_KEY  = "stocks.db";
const DB_DATE_KEY   = "arima_db_cached_date";

function todayStr() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

async function fetchDb() {
  const today       = todayStr();
  const cachedDate  = localStorage.getItem(DB_DATE_KEY);
  const cacheValid  = cachedDate === today;

  // Try to serve from cache first (if same day)
  if (cacheValid && "caches" in self) {
    try {
      const cache    = await caches.open(DB_CACHE_NAME);
      const cached   = await cache.match(DB_CACHE_KEY);
      if (cached) {
        setStatus("⏳ Đang tải stocks.db từ cache...");
        const buf = await cached.arrayBuffer();
        openDb(new Uint8Array(buf));
        // Silently refresh cache in background for next load
        refreshDbCache(cache, today).catch(() => {});
        return;
      }
    } catch { /* Cache API unavailable, fall through to network */ }
  }

  // Network fetch (first load of the day, or cache miss)
  await fetchDbFromNetwork(today);
}

async function fetchDbFromNetwork(today) {
  setStatus("⏳ Đang tải stocks.db từ server...");
  try {
    // Bust cache with date param so server always sends fresh file
    const url  = `stocks.db?v=${today}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const buf = await resp.arrayBuffer();
    openDb(new Uint8Array(buf));

    // Save to Cache API
    if ("caches" in self) {
      try {
        const cache = await caches.open(DB_CACHE_NAME);
        // Store under the plain key (no query string)
        await cache.put(DB_CACHE_KEY, new Response(buf.slice(0), {
          headers: { "Content-Type": "application/octet-stream" }
        }));
        localStorage.setItem(DB_DATE_KEY, today);
      } catch { /* ignore cache write errors */ }
    }
  } catch (e) {
    // Network failed — try stale cache as fallback
    if ("caches" in self) {
      try {
        const cache  = await caches.open(DB_CACHE_NAME);
        const cached = await cache.match(DB_CACHE_KEY);
        if (cached) {
          const staleDate = localStorage.getItem(DB_DATE_KEY) || "stale";
          setStatus(`⚠️ Dùng cache cũ (${staleDate}) — không kết nối được server`);
          const buf = await cached.arrayBuffer();
          openDb(new Uint8Array(buf));
          return;
        }
      } catch { /* ignore */ }
    }
    setStatus(`❌ Không tải được stocks.db: ${e.message}`);
  }
}

async function refreshDbCache(cache, today) {
  const url  = `stocks.db?v=${today}`;
  const resp = await fetch(url);
  if (!resp.ok) return;
  const buf = await resp.arrayBuffer();
  await cache.put(DB_CACHE_KEY, new Response(buf.slice(0), {
    headers: { "Content-Type": "application/octet-stream" }
  }));
  localStorage.setItem(DB_DATE_KEY, today);
}

async function forceReloadDb() {
  const btn = document.getElementById("reloadDbBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Đang tải...";

  try {
    // Clear cache
    if ("caches" in self) {
      const cache = await caches.open(DB_CACHE_NAME);
      await cache.delete(DB_CACHE_KEY);
    }
    localStorage.removeItem(DB_DATE_KEY);

    // Force fetch from network
    await fetchDbFromNetwork(todayStr());
    setStatus("✅ Database đã được cập nhật");
  } catch (e) {
    setStatus(`❌ Lỗi reload DB: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 Reload DB";
  }
}

function openDb(uint8arr) {
  try {
    db = new SQL.Database(uint8arr);
    const rows = db.exec("SELECT DISTINCT symbol FROM stock_prices ORDER BY symbol");
    allSymbols = rows.length ? rows[0].values.map(r => r[0]) : [];

    // Validate saved symbols against DB
    selectedSymbols = selectedSymbols.filter(s => allSymbols.includes(s));
    if (!selectedSymbols.length && allSymbols.length) {
      selectedSymbols = [allSymbols[0]];
    }
    renderTags();
    renderDropdown("");

    const ready = workerReady ? "✅" : "⏳ ARIMA đang tải...";
    setStatus(`✅ DB: ${allSymbols.length} mã  |  ${ready}`);
    updateRunBtn();
    updateArimaxRunBtn();
    renderDbMeta();
  } catch (e) {
    setStatus("❌ Lỗi mở DB: " + e.message);
  }
}

function renderDbMeta() {
  const el = document.getElementById("dbMetaInfo");
  if (!db || !el) return;
  try {
    const getMeta = (key) => {
      const r = db.exec("SELECT value FROM meta WHERE key = ?", [key]);
      return r.length ? r[0].values[0][0] : null;
    };
    const countRes = db.exec("SELECT COUNT(*) FROM stock_prices");
    const rangeRes = db.exec("SELECT MIN(date), MAX(date) FROM stock_prices");
    const totalRows   = countRes.length ? countRes[0].values[0][0] : 0;
    const minDate     = rangeRes.length ? rangeRes[0].values[0][0] : "?";
    const maxDate     = rangeRes.length ? rangeRes[0].values[0][1] : "?";
    const lastSymLoad = getMeta("last_symbol_load");
    const lastPxLoad  = getMeta("last_price_load");

    el.innerHTML =
      `<span>📦 <strong>${allSymbols.length}</strong> mã · <strong>${totalRows.toLocaleString("vi-VN")}</strong> bản ghi</span>` +
      `<span>📅 ${minDate} → ${maxDate}</span>` +
      (lastPxLoad  ? `<span>🔄 Giá: ${lastPxLoad}</span>` : "") +
      (lastSymLoad ? `<span>🏷️ Mã: ${lastSymLoad}</span>` : "");
    el.classList.remove("hidden");
  } catch { /* ignore */ }
}

// ── Worker messaging ──────────────────────────────────────────────────────────
function handleWorkerMessage(e) {
  const { id, type, message, payload } = e.data;

  if (type === "progress") {
    setLoadingMsg(message);
    return;
  }

  const cb = pendingCallbacks[id];
  if (!cb) return;
  delete pendingCallbacks[id];

  if (type === "init_ok") {
    workerReady = true;
    updateRunBtn();
    setStatus(db ? `✅ DB: ${allSymbols.length} mã  |  ✅ ARIMA sẵn sàng` : "✅ ARIMA sẵn sàng — đang tải DB...");
    cb.resolve();
  } else if (type === "result") {
    cb.resolve(payload);
  } else if (type === "error") {
    cb.reject(new Error(message));
  }
}

function handleArimaxWorkerMessage(e) {
  const { id, type, message, payload } = e.data;

  if (type === "progress") {
    setArimaxLoadingMsg(message);
    return;
  }

  const cb = pendingCallbacks[id];
  if (!cb) return;
  delete pendingCallbacks[id];

  if (type === "init_ok") {
    arimaxWorkerReady = true;
    updateArimaxRunBtn();
    cb.resolve();
  } else if (type === "result") {
    cb.resolve(payload);
  } else if (type === "error") {
    cb.reject(new Error(message));
  }
}

function workerCall(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pendingCallbacks[id] = { resolve, reject };
    worker.postMessage({ id, type, payload });
  });
}

function arimaxWorkerCall(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pendingCallbacks[id] = { resolve, reject };
    arimaxWorker.postMessage({ id, type, payload });
  });
}

function updateRunBtn() {
  document.getElementById("runBtn").disabled = !(db && workerReady);
}

function updateArimaxRunBtn() {
  document.getElementById("arimaxRunBtn").disabled = !(db && arimaxWorkerReady);
}

// ── DB query ──────────────────────────────────────────────────────────────────
function loadStockData(symbol, days) {
  if (!db) return [];
  let query, params;
  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    query  = "SELECT date, close FROM stock_prices WHERE symbol=? AND date>=? ORDER BY date";
    params = [symbol, cutoff];
  } else {
    query  = "SELECT date, close FROM stock_prices WHERE symbol=? ORDER BY date";
    params = [symbol];
  }
  const res = db.exec(query, params);
  if (!res.length) return [];
  return res[0].values
    .filter(r => r[1] != null)
    .map(r => ({ date: r[0], value: parseFloat(r[1]) }));
}

function loadStockOHLCV(symbol, days) {
  if (!db) return null;
  let query, params;
  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    query  = "SELECT date, open, high, low, close, volume FROM stock_prices WHERE symbol=? AND date>=? ORDER BY date";
    params = [symbol, cutoff];
  } else {
    query  = "SELECT date, open, high, low, close, volume FROM stock_prices WHERE symbol=? ORDER BY date";
    params = [symbol];
  }
  const res = db.exec(query, params);
  if (!res.length) return null;
  const rows = res[0].values.filter(r => r[4] != null);
  return {
    dates:  rows.map(r => r[0]),
    open:   rows.map(r => parseFloat(r[1]) || 0),
    high:   rows.map(r => parseFloat(r[2]) || 0),
    low:    rows.map(r => parseFloat(r[3]) || 0),
    close:  rows.map(r => parseFloat(r[4])),
    volume: rows.map(r => parseFloat(r[5]) || 0),
  };
}

// ── UI bindings ───────────────────────────────────────────────────────────────
function bindUI() {
  // Symbol search
  const searchInput = document.getElementById("symbolSearch");
  searchInput.addEventListener("input",   () => renderDropdown(searchInput.value));
  searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const val = searchInput.value.trim().toUpperCase();
      const dd  = document.getElementById("symbolDropdown");
      const active = dd.querySelector(".dropdown-item.active");
      if (active)                          addSymbol(active.dataset.sym);
      else if (allSymbols.includes(val))   addSymbol(val);
    } else if (e.key === "ArrowDown") { navigateDropdown(1);  e.preventDefault(); }
      else if (e.key === "ArrowUp")   { navigateDropdown(-1); e.preventDefault(); }
      else if (e.key === "Escape")    { hideDropdown(); }
  });
  document.addEventListener("click", e => {
    if (!e.target.closest("#symbolTags")) hideDropdown();
  });

  // Sliders
  ["p","d","q"].forEach(k => {
    const sl  = document.getElementById(k + "Slider");
    const lbl = document.getElementById(k + "Val");
    sl.addEventListener("input", () => { lbl.textContent = sl.value; savePrefs(); });
  });

  // Auto checkbox
  document.getElementById("autoParams").addEventListener("change", e => {
    const manual = document.getElementById("manualParams");
    manual.style.opacity       = e.target.checked ? "0.4" : "1";
    manual.style.pointerEvents = e.target.checked ? "none" : "auto";
    savePrefs();
  });

  ["period","forecastSteps"].forEach(id =>
    document.getElementById(id).addEventListener("change", savePrefs)
  );

  // Price limit inputs
  ["minPct","maxPct"].forEach(id => {
    document.getElementById(id).addEventListener("input", () => {
      updateLimitLabel();
      savePrefs();
    });
  });

  document.getElementById("runBtn").addEventListener("click", runAnalysis);
  document.getElementById("reloadDbBtn").addEventListener("click", forceReloadDb);
}

// ── Symbol tag input ──────────────────────────────────────────────────────────
function renderDropdown(query) {
  const dd = document.getElementById("symbolDropdown");
  const q  = query.trim().toUpperCase();
  const filtered = allSymbols
    .filter(s => s.includes(q) && !selectedSymbols.includes(s))
    .slice(0, 60);

  if (!filtered.length) { hideDropdown(); return; }

  dd.innerHTML = filtered.map(s =>
    `<div class="dropdown-item" data-sym="${s}">${s}</div>`
  ).join("");
  dd.classList.remove("hidden");

  dd.querySelectorAll(".dropdown-item").forEach(el => {
    el.addEventListener("mousedown", e => { e.preventDefault(); addSymbol(el.dataset.sym); });
  });
}

function hideDropdown() {
  document.getElementById("symbolDropdown").classList.add("hidden");
}

function navigateDropdown(dir) {
  const items = [...document.querySelectorAll(".dropdown-item")];
  if (!items.length) return;
  const cur  = items.findIndex(el => el.classList.contains("active"));
  const next = Math.max(0, Math.min(items.length - 1, cur + dir));
  items.forEach(el => el.classList.remove("active"));
  items[next].classList.add("active");
  items[next].scrollIntoView({ block: "nearest" });
}

function addSymbol(sym) {
  if (!sym || selectedSymbols.includes(sym) || selectedSymbols.length >= MAX_SYMBOLS) return;
  selectedSymbols.push(sym);
  renderTags();
  document.getElementById("symbolSearch").value = "";
  hideDropdown();
  savePrefs();
}

function removeSymbol(sym) {
  selectedSymbols = selectedSymbols.filter(s => s !== sym);
  renderTags();
  savePrefs();
}

function renderTags() {
  const container = document.getElementById("symbolTags");
  container.querySelectorAll(".tag").forEach(el => el.remove());
  const input = document.getElementById("symbolSearch");
  selectedSymbols.forEach(sym => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.innerHTML = `${sym} <span class="remove" data-sym="${sym}">×</span>`;
    tag.querySelector(".remove").addEventListener("click", () => removeSymbol(sym));
    container.insertBefore(tag, input);
  });
}

// ── Preferences ───────────────────────────────────────────────────────────────
function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify({
    symbols:       selectedSymbols,
    period:        document.getElementById("period").value,
    forecastSteps: document.getElementById("forecastSteps").value,
    autoParams:    document.getElementById("autoParams").checked,
    p: document.getElementById("pSlider").value,
    d: document.getElementById("dSlider").value,
    q: document.getElementById("qSlider").value,
    minPct: document.getElementById("minPct").value,
    maxPct: document.getElementById("maxPct").value,
  }));
}

function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (prefs.period)        document.getElementById("period").value        = prefs.period;
    if (prefs.forecastSteps) document.getElementById("forecastSteps").value = prefs.forecastSteps;
    if (typeof prefs.autoParams === "boolean") {
      document.getElementById("autoParams").checked = prefs.autoParams;
      const manual = document.getElementById("manualParams");
      manual.style.opacity       = prefs.autoParams ? "0.4" : "1";
      manual.style.pointerEvents = prefs.autoParams ? "none" : "auto";
    }
    ["p","d","q"].forEach(k => {
      if (prefs[k]) {
        document.getElementById(k + "Slider").value  = prefs[k];
        document.getElementById(k + "Val").textContent = prefs[k];
      }
    });
    if (prefs.minPct != null) document.getElementById("minPct").value = prefs.minPct;
    if (prefs.maxPct != null) document.getElementById("maxPct").value = prefs.maxPct;
    if (Array.isArray(prefs.symbols)) {
      selectedSymbols = prefs.symbols.slice(0, MAX_SYMBOLS);
      renderTags();
    }
  } catch { /* ignore */ }
  updateLimitLabel();
}

function updateLimitLabel() {
  const min = parseFloat(document.getElementById("minPct").value) || -7;
  const max = parseFloat(document.getElementById("maxPct").value) || 7;
  const lbl = document.getElementById("limitLabel");
  if (lbl) lbl.textContent = `${min > 0 ? "+" : ""}${min}% ~ +${max}%`;
}

function getPriceLimits() {
  const minPct = parseFloat(document.getElementById("minPct").value) / 100;
  const maxPct = parseFloat(document.getElementById("maxPct").value) / 100;
  return { minPct, maxPct };
}

// ── Analysis ──────────────────────────────────────────────────────────────────
async function runAnalysis() {
  if (!db || !workerReady) return;
  if (!selectedSymbols.length) { setStatus("⚠️ Chọn ít nhất 1 mã"); return; }

  const days          = parseInt(document.getElementById("period").value);
  const forecastSteps = parseInt(document.getElementById("forecastSteps").value);
  const autoParams    = document.getElementById("autoParams").checked;
  const p = parseInt(document.getElementById("pSlider").value);
  const d = parseInt(document.getElementById("dSlider").value);
  const q = parseInt(document.getElementById("qSlider").value);
  const { minPct, maxPct } = getPriceLimits();

  showLoading(true, "Đang khởi động...");
  document.getElementById("runBtn").disabled = true;

  const results = [];
  for (let i = 0; i < selectedSymbols.length; i++) {
    const sym   = selectedSymbols[i];
    const data  = loadStockData(sym, days);
    const ohlcv = loadStockOHLCV(sym, days);   // for candlestick
    setLoadingMsg(`Đang xử lý ${sym} (${i + 1}/${selectedSymbols.length})...`);

    try {
      const result = await workerCall("analyse", {
        symbol: sym,
        values: data.map(r => r.value),
        dates:  data.map(r => r.date),
        days, autoParams, p, d, q, forecastSteps, minPct, maxPct,
      });
      result.ohlcv = ohlcv;   // attach for candlestick chart
      results.push(result);
    } catch (e) {
      results.push({ symbol: sym, error: e.message });
    }
  }

  showLoading(false);
  document.getElementById("runBtn").disabled = false;
  renderResults(results);
  setStatus(`✅ Hoàn thành ${results.length} mã`);
  updateForecastContext(results, "ARIMA");
  // Show badge on chat bubble to hint new data is available
  document.getElementById("chatBubbleBadge").classList.remove("hidden");
}

// ── Render results ────────────────────────────────────────────────────────────
function renderResults(results) {
  const section = document.getElementById("resultsSection");
  const tabBar  = document.getElementById("tabBar");
  const panels  = document.getElementById("tabPanels");
  section.classList.remove("hidden");
  tabBar.innerHTML  = "";
  panels.innerHTML  = "";

  results.forEach((r, i) => {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (i === 0 ? " active" : "");
    btn.textContent = r.symbol;
    btn.addEventListener("click", () => switchTab(i));
    tabBar.appendChild(btn);

    const panel = document.createElement("div");
    panel.className = "tab-panel" + (i === 0 ? " active" : "");
    panel.id = `panel-${i}`;

    if (r.error) {
      panel.innerHTML = `<div class="info-card"><h3>❌ ${r.symbol}</h3><p>${r.error}</p></div>`;
    } else {
      panel.innerHTML = buildPanelHTML(r, i);
    }
    panels.appendChild(panel);

    if (!r.error) setTimeout(() => renderPlots(r, i), 0);
  });

  section.scrollIntoView({ behavior: "smooth" });
}

function switchTab(idx) {
  document.querySelectorAll(".tab-btn").forEach((b, i)   => b.classList.toggle("active", i === idx));
  document.querySelectorAll(".tab-panel").forEach((p, i) => p.classList.toggle("active", i === idx));
}

function buildPanelHTML(r, idx) {
  const { symbol, p, d, q, aic, metrics, values, dates, splitIdx, fcDates, forecastRes } = r;
  const mapeStyle = metrics.mape < 5 ? "color:green" : metrics.mape < 10 ? "color:orange" : "color:red";
  const fcRows = forecastRes.map((f, i) =>
    `<tr><td>${fcDates[i]}</td><td>${fmt(f.forecast)}</td><td>${fmt(f.lower)}</td><td>${fmt(f.upper)}</td></tr>`
  ).join("");

  return `
    <div class="info-card">
      <h3>✅ ${symbol}</h3>
      <p>
        <strong>Dữ liệu:</strong> ${dates[0]} → ${dates[dates.length-1]} (${values.length} phiên) &nbsp;|&nbsp;
        <strong>Train/Test:</strong> ${splitIdx} / ${values.length - splitIdx} phiên
      </p>
      <p>
        <strong>Mô hình:</strong> ARIMA(${p},${d},${q}) &nbsp;|&nbsp;
        <strong>AIC:</strong> ${aic != null ? aic.toFixed(2) : "N/A"}
      </p>
      <p>
        <strong>Metrics (test):</strong>
        MAE = ${metrics.mae.toFixed(4)} &nbsp;|&nbsp;
        RMSE = ${metrics.rmse.toFixed(4)} &nbsp;|&nbsp;
        <span style="${mapeStyle}">MAPE = ${metrics.mape.toFixed(2)}%</span>
      </p>
      <details style="margin-top:8px">
        <summary style="cursor:pointer;font-weight:600;font-size:0.85rem">📋 Bảng dự báo</summary>
        <table style="margin-top:6px;width:100%;border-collapse:collapse;font-size:0.82rem">
          <tr style="background:#eef3ff"><th style="padding:4px 8px;border:1px solid #dde">Ngày</th><th style="padding:4px 8px;border:1px solid #dde">Dự báo</th><th style="padding:4px 8px;border:1px solid #dde">CI thấp</th><th style="padding:4px 8px;border:1px solid #dde">CI cao</th></tr>
          ${fcRows}
        </table>
      </details>
    </div>

    <div class="inner-tab-bar">
      <button class="inner-tab-btn active"        onclick="switchInner(${idx},'fc',this)">📈 Dự báo</button>
      <button class="inner-tab-btn" onclick="switchInner(${idx},'candle',this)">🕯️ Nến</button>
      <button class="inner-tab-btn" onclick="switchInner(${idx},'raw',this)">📉 Đường giá</button>
      <button class="inner-tab-btn"        onclick="switchInner(${idx},'cmp',this)">📊 Actual vs Predicted</button>
    </div>
    <div id="inner-fc-${idx}"     class="inner-panel active"><div id="plot-fc-${idx}"     style="height:380px"></div></div>
    <div id="inner-candle-${idx}" class="inner-panel">       <div id="plot-candle-${idx}" style="height:460px"></div></div>
    <div id="inner-raw-${idx}"    class="inner-panel">       <div id="plot-raw-${idx}"    style="height:380px"></div></div>
    <div id="inner-cmp-${idx}"    class="inner-panel">       <div id="plot-cmp-${idx}"    style="height:420px"></div></div>
  `;
}

function switchInner(tabIdx, key, btn) {
  const panel = document.getElementById(`panel-${tabIdx}`);
  panel.querySelectorAll(".inner-tab-btn").forEach(b => b.classList.remove("active"));
  panel.querySelectorAll(".inner-panel").forEach(p  => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(`inner-${key}-${tabIdx}`).classList.add("active");
  const plotEl = document.getElementById(`plot-${key}-${tabIdx}`);
  if (plotEl && plotEl.data) Plotly.Plots.resize(plotEl);
}

// ── Shared candlestick renderer ───────────────────────────────────────────────
function renderCandlestick(elId, symbol, ohlcv, forecastRes, fcDates, accentColor = "red") {
  const tail = 80;  // show last N candles
  const n    = ohlcv.close.length;
  const from = Math.max(0, n - tail);

  const cDates  = ohlcv.dates.slice(from);
  const cOpen   = ohlcv.open.slice(from);
  const cHigh   = ohlcv.high.slice(from);
  const cLow    = ohlcv.low.slice(from);
  const cClose  = ohlcv.close.slice(from);
  const cVol    = ohlcv.volume ? ohlcv.volume.slice(from) : null;

  const traces = [
    {
      type: "candlestick",
      x: cDates,
      open: cOpen, high: cHigh, low: cLow, close: cClose,
      name: "OHLC",
      increasing: { line: { color: "#e63946" }, fillcolor: "#e63946" },
      decreasing: { line: { color: "#457b9d" }, fillcolor: "#457b9d" },
      hovertemplate:
        "<b>%{x}</b><br>" +
        "O: %{open:,.2f}  H: %{high:,.2f}<br>" +
        "L: %{low:,.2f}   C: %{close:,.2f}<extra></extra>",
      xaxis: "x", yaxis: "y",
    },
  ];

  // MA20 overlay
  const ma20 = [];
  for (let i = 0; i < cClose.length; i++) {
    if (i < 19) { ma20.push(null); continue; }
    let s = 0; for (let j = i - 19; j <= i; j++) s += cClose[j];
    ma20.push(s / 20);
  }
  traces.push({
    type: "scatter", mode: "lines", x: cDates, y: ma20,
    name: "MA20", line: { color: "orange", width: 1.2, dash: "dot" },
    hovertemplate: "%{x}<br>MA20: %{y:,.2f}<extra></extra>",
    xaxis: "x", yaxis: "y",
  });

  // Forecast overlay
  if (forecastRes && fcDates) {
    const fcF = forecastRes.map(f => f.forecast);
    const fcL = forecastRes.map(f => f.lower);
    const fcU = forecastRes.map(f => f.upper);
    const fcLo = forecastRes.map(f => f.limitLo);
    const fcHi = forecastRes.map(f => f.limitHi);

    traces.push({
      type: "scatter", mode: "lines+markers", x: fcDates, y: fcF,
      name: "Dự báo", line: { color: accentColor, width: 2, dash: "dash" },
      marker: { size: 5 }, xaxis: "x", yaxis: "y",
      hovertemplate: "%{x}<br>Dự báo: %{y:,.2f}<extra></extra>",
    });
    traces.push({
      type: "scatter", x: [...fcDates, ...fcDates.slice().reverse()],
      y: [...fcU, ...fcL.slice().reverse()],
      fill: "toself", fillcolor: `rgba(${accentColor === "#e63946" ? "230,57,70" : "255,0,0"},0.1)`,
      line: { color: "rgba(0,0,0,0)" }, name: "95% CI",
      hoverinfo: "skip", xaxis: "x", yaxis: "y",
    });
    if (fcLo && fcHi) {
      traces.push({
        type: "scatter", mode: "lines", x: fcDates, y: fcHi,
        name: "Trần giá", line: { color: "#e63946", width: 1, dash: "dot" },
        hovertemplate: "%{x}<br>Trần: %{y:,.2f}<extra></extra>",
        xaxis: "x", yaxis: "y",
      });
      traces.push({
        type: "scatter", mode: "lines", x: fcDates, y: fcLo,
        name: "Sàn giá", line: { color: "#457b9d", width: 1, dash: "dot" },
        hovertemplate: "%{x}<br>Sàn: %{y:,.2f}<extra></extra>",
        xaxis: "x", yaxis: "y",
      });
    }
  }

  // Volume bars
  if (cVol) {
    const volColors = cClose.map((c, i) =>
      i === 0 ? "#aaa" : (c >= cOpen[i] ? "rgba(230,57,70,0.5)" : "rgba(69,123,157,0.5)")
    );
    traces.push({
      type: "bar", x: cDates, y: cVol, name: "Volume",
      marker: { color: volColors },
      hovertemplate: "%{x}<br>Vol: %{y:,.0f}<extra></extra>",
      xaxis: "x", yaxis: "y2",
    });
  }

  const layout = {
    title: `${symbol} — Biểu đồ nến`,
    xaxis: {
      title: "", rangeslider: { visible: false },
      type: "category",          // evenly spaced, no weekend gaps
      tickangle: -45,
      tickmode: "auto", nticks: 12,
    },
    yaxis:  { title: "Giá (nghìn VND)", domain: cVol ? [0.28, 1] : [0, 1] },
    yaxis2: cVol ? { title: "Volume", domain: [0, 0.22], showgrid: false } : undefined,
    hovermode: "x unified", template: "plotly_white",
    margin: { t: 40, b: 60 },
    legend: { orientation: "h", y: -0.12 },
    shapes: forecastRes ? [{
      type: "line",
      x0: ohlcv.dates[n - 1], x1: ohlcv.dates[n - 1],
      y0: 0, y1: 1, xref: "x", yref: "paper",
      line: { color: "gray", dash: "dot", width: 1.5 },
    }] : [],
  };

  Plotly.newPlot(elId, traces, layout, { responsive: true });
}

function renderPlots(r, idx) {
  const { symbol, values, dates, splitIdx, testVals, testPreds, forecastRes, fcDates, p, d, q, metrics, ohlcv } = r;

  // ── Candlestick ────────────────────────────────────────────────────────────
  if (ohlcv && ohlcv.close.length) {
    renderCandlestick(`plot-candle-${idx}`, symbol, ohlcv, forecastRes, fcDates);
  }

  // ── Raw ────────────────────────────────────────────────────────────────────
  const meanV = values.reduce((s, v) => s + v, 0) / values.length;
  Plotly.newPlot(`plot-raw-${idx}`, [
    { x: dates, y: values, type: "scatter", mode: "lines", name: "Giá đóng cửa",
      line: { color: "steelblue", width: 1.5 },
      hovertemplate: "%{x}<br>Giá: %{y:,.2f}<extra></extra>" },
    { x: [dates[0], dates[dates.length-1]], y: [meanV, meanV],
      type: "scatter", mode: "lines", name: `Mean: ${fmt(meanV)}`,
      line: { color: "orange", dash: "dash", width: 1.2 } },
  ], {
    title: `${symbol} — Giá đóng cửa`,
    xaxis: { title: "Ngày" }, yaxis: { title: "Giá (nghìn VND)" },
    hovermode: "x unified", template: "plotly_white", margin: { t: 40 },
  }, { responsive: true });

  // ── Forecast ───────────────────────────────────────────────────────────────
  const histDates  = dates.slice(-60);
  const histValues = values.slice(-60);
  const fcF = forecastRes.map(f => f.forecast);
  const fcL = forecastRes.map(f => f.lower);
  const fcU = forecastRes.map(f => f.upper);
  const fcLimitLo = forecastRes.map(f => f.limitLo);
  const fcLimitHi = forecastRes.map(f => f.limitHi);

  Plotly.newPlot(`plot-fc-${idx}`, [
    { x: histDates, y: histValues, type: "scatter", mode: "lines", name: "Lịch sử",
      line: { color: "steelblue", width: 2 },
      hovertemplate: "%{x}<br>Giá: %{y:,.2f}<extra></extra>" },
    { x: fcDates, y: fcF, type: "scatter", mode: "lines+markers", name: "Dự báo",
      line: { color: "red", width: 2, dash: "dash" }, marker: { size: 5 },
      hovertemplate: "%{x}<br>Dự báo: %{y:,.2f}<extra></extra>" },
    { x: [...fcDates, ...fcDates.slice().reverse()],
      y: [...fcU, ...fcL.slice().reverse()],
      type: "scatter", fill: "toself", fillcolor: "rgba(255,0,0,0.1)",
      line: { color: "rgba(255,0,0,0)" }, name: "95% CI", hoverinfo: "skip" },
    { x: fcDates, y: fcLimitHi, type: "scatter", mode: "lines", name: "Trần giá",
      line: { color: "#e63946", width: 1.2, dash: "dot" },
      hovertemplate: "%{x}<br>Trần: %{y:,.2f}<extra></extra>" },
    { x: fcDates, y: fcLimitLo, type: "scatter", mode: "lines", name: "Sàn giá",
      line: { color: "#457b9d", width: 1.2, dash: "dot" },
      hovertemplate: "%{x}<br>Sàn: %{y:,.2f}<extra></extra>" },
  ], {
    title: `${symbol} — ARIMA(${p},${d},${q}) Forecast`,
    xaxis: { title: "Ngày" }, yaxis: { title: "Giá (nghìn VND)" },
    hovermode: "x unified", template: "plotly_white", margin: { t: 40 },
    shapes: [{ type: "line",
      x0: dates[dates.length-1], x1: dates[dates.length-1], y0: 0, y1: 1,
      xref: "x", yref: "paper", line: { color: "gray", dash: "dot", width: 1.5 } }],
    annotations: [{ x: dates[dates.length-1], y: 1, xref: "x", yref: "paper",
      text: "Forecast start", showarrow: false, xanchor: "left", yanchor: "top",
      font: { color: "gray", size: 11 } }],
  }, { responsive: true });

  // ── Comparison ─────────────────────────────────────────────────────────────
  const xArr   = testVals.map((_, i) => i);
  const errors = testVals.map((v, i) => v - testPreds[i]);
  const barColors = errors.map(e => e >= 0 ? "green" : "red");

  Plotly.newPlot(`plot-cmp-${idx}`, [
    { x: xArr, y: testVals,  type: "scatter", mode: "lines+markers", name: "Thực tế",
      line: { color: "steelblue" }, marker: { size: 4 },
      hovertemplate: "Bước %{x}<br>Thực tế: %{y:,.2f}<extra></extra>",
      xaxis: "x", yaxis: "y" },
    { x: xArr, y: testPreds, type: "scatter", mode: "lines+markers", name: "Dự báo",
      line: { color: "red", dash: "dash" }, marker: { size: 4 },
      hovertemplate: "Bước %{x}<br>Dự báo: %{y:,.2f}<extra></extra>",
      xaxis: "x", yaxis: "y" },
    { x: xArr, y: errors, type: "bar", name: "Residual",
      marker: { color: barColors },
      hovertemplate: "Bước %{x}<br>Residual: %{y:,.2f}<extra></extra>",
      xaxis: "x2", yaxis: "y2" },
  ], {
    title: `Actual vs Predicted | MAE=${metrics.mae.toFixed(2)}  RMSE=${metrics.rmse.toFixed(2)}  MAPE=${metrics.mape.toFixed(2)}%`,
    xaxis:  { domain: [0,1], anchor: "y",  title: "" },
    yaxis:  { domain: [0.38,1], title: "Giá (nghìn VND)" },
    xaxis2: { domain: [0,1], anchor: "y2", title: "Bước" },
    yaxis2: { domain: [0,0.32], title: "Residual" },
    hovermode: "x unified", template: "plotly_white", margin: { t: 50 },
  }, { responsive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(v) {
  return v == null ? "N/A" : v.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
}
function setStatus(msg)      { document.getElementById("statusMsg").textContent = msg; }
function setLoadingMsg(msg)  { document.getElementById("loadingMsg").textContent = msg; }
function showLoading(show, msg = "") {
  document.getElementById("loadingOverlay").classList.toggle("hidden", !show);
  if (msg) setLoadingMsg(msg);
}

// ── ARIMAX UI bindings ────────────────────────────────────────────────────────
(function bindArimaxUI() {
  // Wait for DOM
  window.addEventListener("DOMContentLoaded", () => {
    // Sliders
    ["axP","axD","axQ"].forEach(k => {
      const sl  = document.getElementById(k + "Slider");
      const lbl = document.getElementById(k + "Val");
      if (sl) sl.addEventListener("input", () => { lbl.textContent = sl.value; });
    });

    // Auto checkbox
    const autoCb = document.getElementById("arimaxAutoParams");
    if (autoCb) {
      autoCb.addEventListener("change", e => {
        const manual = document.getElementById("arimaxManualParams");
        manual.style.opacity       = e.target.checked ? "0.4" : "1";
        manual.style.pointerEvents = e.target.checked ? "none" : "auto";
      });
    }

    const runBtn = document.getElementById("arimaxRunBtn");
    if (runBtn) runBtn.addEventListener("click", runArimaxAnalysis);
  });
})();

// ── ARIMAX Analysis ───────────────────────────────────────────────────────────
async function runArimaxAnalysis() {
  if (!db || !arimaxWorkerReady) return;
  if (!selectedSymbols.length) { setArimaxStatus("⚠️ Chọn ít nhất 1 mã"); return; }

  const days          = parseInt(document.getElementById("period").value);
  const forecastSteps = parseInt(document.getElementById("forecastSteps").value);
  const autoParams    = document.getElementById("arimaxAutoParams").checked;
  const p = parseInt(document.getElementById("axPSlider").value);
  const d = parseInt(document.getElementById("axDSlider").value);
  const q = parseInt(document.getElementById("axQSlider").value);
  const { minPct, maxPct } = getPriceLimits();

  showArimaxLoading(true, "Đang khởi động ARIMAX...");
  document.getElementById("arimaxRunBtn").disabled = true;

  const results = [];
  for (let i = 0; i < selectedSymbols.length; i++) {
    const sym  = selectedSymbols[i];
    const ohlcv = loadStockOHLCV(sym, days);
    setArimaxLoadingMsg(`ARIMAX: ${sym} (${i + 1}/${selectedSymbols.length})...`);

    if (!ohlcv || ohlcv.close.length < 50) {
      results.push({ symbol: sym, error: `Không đủ dữ liệu OHLCV (cần ≥ 50 phiên)` });
      continue;
    }

    try {
      const result = await arimaxWorkerCall("analyse_arimax", {
        symbol: sym,
        ...ohlcv,
        autoParams, p, d, q, forecastSteps, minPct, maxPct,
      });
      result.ohlcv = ohlcv;   // attach for candlestick chart
      results.push(result);
    } catch (e) {
      results.push({ symbol: sym, error: e.message });
    }
  }

  showArimaxLoading(false);
  document.getElementById("arimaxRunBtn").disabled = false;
  renderArimaxResults(results);
  setArimaxStatus(`✅ ARIMAX hoàn thành ${results.length} mã`);
  updateForecastContext(results, "ARIMAX");
  document.getElementById("chatBubbleBadge").classList.remove("hidden");
}

// ── Render ARIMAX results ─────────────────────────────────────────────────────
function renderArimaxResults(results) {
  const section = document.getElementById("arimaxResultsSection");
  const tabBar  = document.getElementById("arimaxTabBar");
  const panels  = document.getElementById("arimaxTabPanels");
  section.classList.remove("hidden");
  tabBar.innerHTML  = "";
  panels.innerHTML  = "";

  results.forEach((r, i) => {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (i === 0 ? " active" : "");
    btn.textContent = r.symbol;
    btn.addEventListener("click", () => switchArimaxTab(i));
    tabBar.appendChild(btn);

    const panel = document.createElement("div");
    panel.className = "tab-panel" + (i === 0 ? " active" : "");
    panel.id = `ax-panel-${i}`;

    if (r.error) {
      panel.innerHTML = `<div class="info-card"><h3>❌ ${r.symbol}</h3><p>${r.error}</p></div>`;
    } else {
      panel.innerHTML = buildArimaxPanelHTML(r, i);
    }
    panels.appendChild(panel);

    if (!r.error) setTimeout(() => renderArimaxPlots(r, i), 0);
  });

  section.scrollIntoView({ behavior: "smooth" });
}

function switchArimaxTab(idx) {
  document.querySelectorAll("#arimaxTabBar .tab-btn").forEach((b, i)   => b.classList.toggle("active", i === idx));
  document.querySelectorAll("#arimaxTabPanels .tab-panel").forEach((p, i) => p.classList.toggle("active", i === idx));
}

function buildArimaxPanelHTML(r, idx) {
  const { symbol, p, d, q, metrics, values, dates, splitIdx, fcDates, forecastRes, featureImportance } = r;
  const mapeStyle = metrics.mape < 5 ? "color:green" : metrics.mape < 10 ? "color:orange" : "color:red";

  const fcRows = forecastRes.map((f, i) =>
    `<tr><td>${fcDates[i]}</td><td>${fmt(f.forecast)}</td><td>${fmt(f.lower)}</td><td>${fmt(f.upper)}</td></tr>`
  ).join("");

  const featRows = featureImportance.map(f =>
    `<tr>
      <td><strong>${f.name}</strong></td>
      <td style="color:${f.coef >= 0 ? '#2a9d8f' : '#e63946'}">${f.coef >= 0 ? "+" : ""}${f.coef.toFixed(4)}</td>
      <td>${f.absCoef.toFixed(4)}</td>
    </tr>`
  ).join("");

  return `
    <div class="info-card arimax-card">
      <h3>✅ ${symbol} — ARIMAX(${p},${d},${q})</h3>
      <p>
        <strong>Dữ liệu:</strong> ${dates[0]} → ${dates[dates.length-1]} (${values.length} phiên) &nbsp;|&nbsp;
        <strong>Train/Test:</strong> ${splitIdx} / ${values.length - splitIdx} phiên
      </p>
      <p>
        <strong>Metrics (test):</strong>
        MAE = ${metrics.mae.toFixed(4)} &nbsp;|&nbsp;
        RMSE = ${metrics.rmse.toFixed(4)} &nbsp;|&nbsp;
        <span style="${mapeStyle}">MAPE = ${metrics.mape.toFixed(2)}%</span>
      </p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <details style="flex:1;min-width:200px">
          <summary style="cursor:pointer;font-weight:600;font-size:0.85rem">📋 Bảng dự báo</summary>
          <table style="margin-top:6px;width:100%;border-collapse:collapse;font-size:0.82rem">
            <tr style="background:#fff0f0"><th style="padding:4px 8px;border:1px solid #fcc">Ngày</th><th style="padding:4px 8px;border:1px solid #fcc">Dự báo</th><th style="padding:4px 8px;border:1px solid #fcc">CI thấp</th><th style="padding:4px 8px;border:1px solid #fcc">CI cao</th></tr>
            ${fcRows}
          </table>
        </details>
        <details style="flex:1;min-width:200px">
          <summary style="cursor:pointer;font-weight:600;font-size:0.85rem">🔍 Feature Signals (last bar)</summary>
          <table style="margin-top:6px;width:100%;border-collapse:collapse;font-size:0.82rem">
            <tr style="background:#fff0f0"><th style="padding:4px 8px;border:1px solid #fcc">Feature</th><th style="padding:4px 8px;border:1px solid #fcc">Giá trị</th><th style="padding:4px 8px;border:1px solid #fcc">|z-score|</th></tr>
            ${featRows}
          </table>
        </details>
      </div>
    </div>

    <div class="inner-tab-bar">
      <button class="inner-tab-btn active"  onclick="switchArimaxInner(${idx},'fc',this)">📈 Dự báo ARIMAX</button>
      <button class="inner-tab-btn"         onclick="switchArimaxInner(${idx},'candle',this)">🕯️ Nến</button>
      <button class="inner-tab-btn"         onclick="switchArimaxInner(${idx},'cmp',this)">📊 Actual vs Predicted</button>
      <button class="inner-tab-btn"         onclick="switchArimaxInner(${idx},'feat',this)">🔍 Feature Importance</button>
    </div>
    <div id="ax-inner-fc-${idx}"     class="inner-panel active"><div id="ax-plot-fc-${idx}"     style="height:380px"></div></div>
    <div id="ax-inner-candle-${idx}" class="inner-panel">       <div id="ax-plot-candle-${idx}" style="height:460px"></div></div>
    <div id="ax-inner-cmp-${idx}"    class="inner-panel">       <div id="ax-plot-cmp-${idx}"    style="height:420px"></div></div>
    <div id="ax-inner-feat-${idx}"   class="inner-panel">       <div id="ax-plot-feat-${idx}"   style="height:340px"></div></div>
  `;
}

function switchArimaxInner(tabIdx, key, btn) {
  const panel = document.getElementById(`ax-panel-${tabIdx}`);
  panel.querySelectorAll(".inner-tab-btn").forEach(b => b.classList.remove("active"));
  panel.querySelectorAll(".inner-panel").forEach(p  => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(`ax-inner-${key}-${tabIdx}`).classList.add("active");
  const plotEl = document.getElementById(`ax-plot-${key}-${tabIdx}`);
  if (plotEl && plotEl.data) Plotly.Plots.resize(plotEl);
}

function renderArimaxPlots(r, idx) {
  const { symbol, values, dates, splitIdx, testClose, testPreds, forecastRes, fcDates, p, d, q, metrics, featureImportance } = r;

  // ── Candlestick ────────────────────────────────────────────────────────────
  // ARIMAX already has full OHLCV in the result (passed via ohlcv field from runArimaxAnalysis)
  if (r.ohlcv && r.ohlcv.close.length) {
    renderCandlestick(`ax-plot-candle-${idx}`, symbol, r.ohlcv, forecastRes, fcDates, "#e63946");
  }

  // ── Forecast ───────────────────────────────────────────────────────────────
  const histDates  = dates.slice(-60);
  const histValues = values.slice(-60);
  const fcF = forecastRes.map(f => f.forecast);
  const fcL = forecastRes.map(f => f.lower);
  const fcU = forecastRes.map(f => f.upper);
  const fcLimitLo = forecastRes.map(f => f.limitLo);
  const fcLimitHi = forecastRes.map(f => f.limitHi);

  Plotly.newPlot(`ax-plot-fc-${idx}`, [
    { x: histDates, y: histValues, type: "scatter", mode: "lines", name: "Lịch sử",
      line: { color: "steelblue", width: 2 },
      hovertemplate: "%{x}<br>Giá: %{y:,.2f}<extra></extra>" },
    { x: fcDates, y: fcF, type: "scatter", mode: "lines+markers", name: "Dự báo ARIMAX",
      line: { color: "#e63946", width: 2, dash: "dash" }, marker: { size: 5 },
      hovertemplate: "%{x}<br>Dự báo: %{y:,.2f}<extra></extra>" },
    { x: [...fcDates, ...fcDates.slice().reverse()],
      y: [...fcU, ...fcL.slice().reverse()],
      type: "scatter", fill: "toself", fillcolor: "rgba(230,57,70,0.1)",
      line: { color: "rgba(0,0,0,0)" }, name: "95% CI", hoverinfo: "skip" },
    { x: fcDates, y: fcLimitHi, type: "scatter", mode: "lines", name: "Trần giá",
      line: { color: "#e63946", width: 1.2, dash: "dot" },
      hovertemplate: "%{x}<br>Trần: %{y:,.2f}<extra></extra>" },
    { x: fcDates, y: fcLimitLo, type: "scatter", mode: "lines", name: "Sàn giá",
      line: { color: "#457b9d", width: 1.2, dash: "dot" },
      hovertemplate: "%{x}<br>Sàn: %{y:,.2f}<extra></extra>" },
  ], {
    title: `${symbol} — ARIMAX(${p},${d},${q}) Forecast`,
    xaxis: { title: "Ngày" }, yaxis: { title: "Giá (nghìn VND)" },
    hovermode: "x unified", template: "plotly_white", margin: { t: 40 },
    shapes: [{ type: "line",
      x0: dates[dates.length-1], x1: dates[dates.length-1], y0: 0, y1: 1,
      xref: "x", yref: "paper", line: { color: "gray", dash: "dot", width: 1.5 } }],
    annotations: [{ x: dates[dates.length-1], y: 1, xref: "x", yref: "paper",
      text: "Forecast start", showarrow: false, xanchor: "left", yanchor: "top",
      font: { color: "gray", size: 11 } }],
  }, { responsive: true });

  // ── Comparison ─────────────────────────────────────────────────────────────
  const xArr   = testClose.map((_, i) => i);
  const errors = testClose.map((v, i) => v - testPreds[i]);
  const barColors = errors.map(e => e >= 0 ? "#2a9d8f" : "#e63946");

  Plotly.newPlot(`ax-plot-cmp-${idx}`, [
    { x: xArr, y: testClose, type: "scatter", mode: "lines+markers", name: "Thực tế",
      line: { color: "steelblue" }, marker: { size: 4 },
      hovertemplate: "Bước %{x}<br>Thực tế: %{y:,.2f}<extra></extra>",
      xaxis: "x", yaxis: "y" },
    { x: xArr, y: testPreds, type: "scatter", mode: "lines+markers", name: "Dự báo ARIMAX",
      line: { color: "#e63946", dash: "dash" }, marker: { size: 4 },
      hovertemplate: "Bước %{x}<br>Dự báo: %{y:,.2f}<extra></extra>",
      xaxis: "x", yaxis: "y" },
    { x: xArr, y: errors, type: "bar", name: "Residual",
      marker: { color: barColors },
      hovertemplate: "Bước %{x}<br>Residual: %{y:,.2f}<extra></extra>",
      xaxis: "x2", yaxis: "y2" },
  ], {
    title: `Actual vs Predicted | MAE=${metrics.mae.toFixed(2)}  RMSE=${metrics.rmse.toFixed(2)}  MAPE=${metrics.mape.toFixed(2)}%`,
    xaxis:  { domain: [0,1], anchor: "y",  title: "" },
    yaxis:  { domain: [0.38,1], title: "Giá (nghìn VND)" },
    xaxis2: { domain: [0,1], anchor: "y2", title: "Bước" },
    yaxis2: { domain: [0,0.32], title: "Residual" },
    hovermode: "x unified", template: "plotly_white", margin: { t: 50 },
  }, { responsive: true });

  // ── Feature Importance ─────────────────────────────────────────────────────
  const FEAT_LABELS = {
    returns:   "Log Return",
    hlRange:   "H-L Range / Close",
    volumeMa5: "Volume / MA5(Vol)",
    rsi14:     "RSI 14 (scaled)",
    macdHist:  "MACD Histogram",
    varPred:   "VAR(1) Pred (ratio)",
  };
  const fi = [...featureImportance].reverse(); // ascending for horizontal bar
  Plotly.newPlot(`ax-plot-feat-${idx}`, [{
    type: "bar",
    orientation: "h",
    x: fi.map(f => f.absCoef),
    y: fi.map(f => FEAT_LABELS[f.name] || f.name),
    text: fi.map(f => f.absCoef.toFixed(2) + "σ"),
    textposition: "outside",
    marker: { color: fi.map(f => f.absCoef > 1.5 ? "#e63946" : "#457b9d") },
    hovertemplate: "%{y}<br>|z-score|: %{x:.2f}σ<extra></extra>",
  }], {
    title: "Feature Signal Strength — |z-score| của giá trị phiên cuối<br><sup>Đỏ = tín hiệu mạnh (>1.5σ)</sup>",
    xaxis: { title: "|z-score|" },
    yaxis: { automargin: true },
    template: "plotly_white",
    margin: { t: 60, l: 160 },
  }, { responsive: true });
}

// ── ARIMAX helpers ────────────────────────────────────────────────────────────
function setArimaxStatus(msg)     { document.getElementById("arimaxStatusMsg").textContent = msg; }
function setArimaxLoadingMsg(msg) { document.getElementById("arimaxLoadingMsg").textContent = msg; }
function showArimaxLoading(show, msg = "") {
  document.getElementById("arimaxLoadingOverlay").classList.toggle("hidden", !show);
  if (msg) setArimaxLoadingMsg(msg);
}


// ═══════════════════════════════════════════════════════════════════════════════
// LLM Chat — transformers.js + WebGPU  (Qwen2-0.5B)
// Protocol matches: https://huggingface.co/spaces/Xenova/webgpu-chat-qwen2
// ═══════════════════════════════════════════════════════════════════════════════

let llmWorker      = null;
let llmModelLoaded = false;
let llmGenerating  = false;
let llmChatHistory = [];   // { role, content }[]
const LLM_HISTORY_LIMIT = 5;

// Lưu kết quả forecast theo symbol: { [symbol]: { arima?, arimax?, updatedAt } }
const forecastStore = {};

// ── Boot worker (lazy) ────────────────────────────────────────────────────────
function ensureLlmWorker() {
  if (llmWorker) return;
  llmWorker = new Worker("llm.worker.js", { type: "module" });
  llmWorker.onmessage = handleLlmMessage;
  llmWorker.onerror   = (e) => setLlmStatus("❌ Worker lỗi: " + e.message);
  // Check cache immediately after worker boots
  llmWorker.postMessage({ type: "check_cache" });
}

// ── Batched DOM render for streaming tokens ───────────────────────────────────
function _renderLlmUpdate() {
  const raw = _llmFullText;
  const thinkStart = raw.indexOf("<think>");
  const thinkEnd   = raw.indexOf("</think>");

  if (thinkStart !== -1) {
    _inThink = thinkEnd === -1;
    const thinkContent = thinkEnd !== -1
      ? raw.slice(thinkStart + 7, thinkEnd)
      : raw.slice(thinkStart + 7);
    const answerContent = thinkEnd !== -1
      ? raw.slice(thinkEnd + 8).replace(/^[\n\r]+/, "")
      : "";

    const hasThinkContent = thinkContent.trim().length > 0;
    if (_thinkBubble) {
      // Always keep think bubble visible (contains debug context)
      if (hasThinkContent) {
        if (_inThink) _thinkBubble.open = true;
        const body = _thinkBubble.querySelector(".llm-think-body");
        if (body) {
          // Preserve debug prefix (everything up to =====THINKING=====), append think content after
          const marker = "=====THINKING=====";
          const markerIdx = body.textContent.indexOf(marker);
          if (markerIdx !== -1) {
            body.textContent = body.textContent.slice(0, markerIdx + marker.length) + "\n" + thinkContent;
          } else {
            body.textContent = thinkContent;
          }
          body.scrollTop = body.scrollHeight;
        }
        const summary = _thinkBubble.querySelector("summary");
        if (summary) summary.textContent = _inThink ? "💭 Đang suy luận..." : "💭 Suy luận xong";
      }
    }
    if (_currentBubble) {
      _currentBubble.textContent = answerContent;
      _currentBubble.appendChild(_currentCursor);
    }
  } else {
    // No think tags — plain answer, but keep think bubble for debug context
    if (_currentBubble) {
      _currentBubble.textContent = raw;
      _currentBubble.appendChild(_currentCursor);
    }
  }
  scrollChatToBottom();
}

// ── Worker message handler ────────────────────────────────────────────────────
function handleLlmMessage({ data }) {
  const { status } = data;

  if (status === "cache_result") {
    if (data.cached) {
      setLlmStatus("⚡ Model đã có trong cache — đang tải...");
      // Auto-load without user interaction
      llmWorker.postMessage({ type: "load" });
      document.getElementById("llmLoadBtn").disabled = true;
    } else {
      setLlmStatus("Model chưa tải. Nhấn ⬇️ để tải (~750 MB).");
    }
    return;
  }

  if (status === "loading") {
    setLlmStatus("⏳ " + data.data);
    return;
  }

  if (status === "initiate") {
    setLlmStatus(`⏳ Khởi tạo: ${data.file}`);
    document.getElementById("llmProgressWrap").classList.remove("hidden");
    return;
  }

  if (status === "progress") {
    const pct = data.progress ?? 0;
    document.getElementById("llmProgressBar").style.width = pct + "%";
    setLlmStatus(`⏳ ${data.file} — ${pct.toFixed(1)}%`);
    return;
  }

  if (status === "done") {
    setLlmStatus(`✅ Đã tải: ${data.file}`);
    return;
  }

  if (status === "ready") {
    llmModelLoaded = true;
    document.getElementById("llmProgressBar").style.width = "100%";
    setLlmStatus("✅ Model sẵn sàng — Qwen3-0.6B (WebGPU)");
    document.getElementById("llmInput").disabled   = false;
    document.getElementById("llmSendBtn").disabled = false;
    document.getElementById("llmLoadBtn").disabled = false;
    appendSystemMsg("Model đã tải xong. Hãy chạy phân tích ARIMA/ARIMAX rồi đặt câu hỏi.");
    return;
  }

  if (status === "start") {
    // New assistant turn begins — create think bubble + answer bubble
    _llmThinkText  = "";
    _llmAnswerText = "";
    _inThink       = false;

    const wrap = document.getElementById("llmMessages");

    // Build debug context sections
    const debugParts = [];
    if (_llmDebugCtx.forecastCtx && _llmDebugCtx.forecastCtx.trim()) {
      debugParts.push("=====FORECAST CONTEXT=====\n" + _llmDebugCtx.forecastCtx.trim());
    }
    if (_llmDebugCtx.dbCtx && _llmDebugCtx.dbCtx.trim()) {
      debugParts.push("=====DB QUERY RESULT=====\n" + _llmDebugCtx.dbCtx.trim());
    }
    const debugText = debugParts.length
      ? debugParts.join("\n\n") + "\n\n=====THINKING====="
      : "";

    _thinkBubble = document.createElement("details");
    _thinkBubble.className = "llm-msg llm-msg--think";
    _thinkBubble.open = true;
    _thinkBubble.innerHTML = '<summary>💭 Đang suy luận...</summary><div class="llm-think-body"></div>';
    const thinkBody = _thinkBubble.querySelector(".llm-think-body");
    if (debugText) thinkBody.textContent = debugText;
    wrap.appendChild(_thinkBubble);

    _currentBubble = document.createElement("div");
    _currentBubble.className = "llm-msg llm-msg--assistant";
    _currentCursor = document.createElement("span");
    _currentCursor.className = "llm-cursor";
    _currentCursor.textContent = "▋";
    _currentBubble.appendChild(_currentCursor);
    wrap.appendChild(_currentBubble);
    scrollChatToBottom();
    return;
  }

  if (status === "update") {
    _llmFullText += data.output;

    // Throttle DOM updates — schedule at most one render per animation frame
    if (!_renderScheduled) {
      _renderScheduled = true;
      requestAnimationFrame(() => {
        _renderScheduled = false;
        _renderLlmUpdate();
      });
    }
    return;
  }

  if (status === "complete") {
    if (_currentCursor) _currentCursor.remove();

    // Final answer = text after </think>, or full text if no think
    const raw = _llmFullText;
    const thinkEnd = raw.indexOf("</think>");
    const finalAnswer = thinkEnd !== -1
      ? raw.slice(thinkEnd + 8).replace(/^[\n\r]+/, "")
      : raw;

    if (_currentBubble) _currentBubble.textContent = finalAnswer;
    if (_thinkBubble) {
      const summary = _thinkBubble.querySelector("summary");
      if (summary) summary.textContent = "💭 Suy luận xong";
    }

    if (finalAnswer) llmChatHistory.push({ role: "assistant", content: finalAnswer });

    _currentBubble  = null;
    _currentCursor  = null;
    _thinkBubble    = null;
    _renderScheduled = false;
    _llmFullText   = "";
    _llmThinkText  = "";
    _llmAnswerText = "";
    _inThink       = false;
    llmGenerating  = false;
    document.getElementById("llmSendBtn").disabled  = false;
    document.getElementById("llmAbortBtn").classList.add("hidden");
    document.getElementById("llmInput").disabled    = false;
    document.getElementById("llmInput").focus();
    scrollChatToBottom();
    return;
  }

  if (status === "error") {
    setLlmStatus("❌ " + data.message);
    llmGenerating = false;
    document.getElementById("llmSendBtn").disabled  = false;
    document.getElementById("llmAbortBtn").classList.add("hidden");
    document.getElementById("llmInput").disabled    = false;
    return;
  }
}

// Streaming state
let _currentBubble  = null;
let _currentCursor  = null;
let _thinkBubble    = null;
let _renderScheduled = false;  // throttle DOM updates to one per animation frame
let _llmFullText   = "";
let _llmThinkText  = "";
let _llmAnswerText = "";
let _inThink       = false;
let _llmDebugCtx   = { forecastCtx: "", dbCtx: "" };  // debug context for think bubble

// ── Load model ────────────────────────────────────────────────────────────────
function loadLlmModel() {
  ensureLlmWorker();
  document.getElementById("llmLoadBtn").disabled = true;
  document.getElementById("llmProgressWrap").classList.remove("hidden");
  document.getElementById("llmProgressBar").style.width = "0%";
  setLlmStatus("⏳ Đang tải model — lần đầu có thể mất vài phút…");
  llmWorker.postMessage({ type: "load" });
}
// ── Forecast context ──────────────────────────────────────────────────────────
function buildForecastContext(symbols = []) {
  if (!Object.keys(forecastStore).length) {
    return "(Chưa có dữ liệu dự báo — hãy chạy ARIMA hoặc ARIMAX trước.)";
  }

  // Lấy symbol liên quan: nếu có symbols thì filter, không thì lấy tất cả
  const keys = symbols.length
    ? symbols.filter(s => forecastStore[s])
    : Object.keys(forecastStore);

  if (!keys.length) {
    return "(Không có dữ liệu dự báo cho các mã được hỏi.)";
  }

  const lines = [];
  for (const sym of keys) {
    const entry = forecastStore[sym];
    lines.push(`\n[${sym}]`);
    for (const modelKey of ["arima", "arimax"]) {
      const d = entry[modelKey];
      if (!d) continue;
      if (d.error) { lines.push(`  ${modelKey.toUpperCase()}: LỖI — ${d.error}`); continue; }
      lines.push(`  Mô hình: ${d.model} | Cập nhật: ${d.updatedAt}`);
      if (d.lastOhlcv) {
        const o = d.lastOhlcv;
        lines.push(`  Phiên ${o.date}: Mở ${o.open} | Cao ${o.high} | Thấp ${o.low} | Đóng ${o.close} (nghìn đ/cp) | KL ${o.volume.toLocaleString("vi-VN")}`);
      }
      lines.push(`  Sai số: MAE=${d.metrics.mae} | RMSE=${d.metrics.rmse} | MAPE=${d.metrics.mape}%`);
      if (d.forecast?.length) {
        lines.push(`  Dự báo: ${d.forecast.map(f => `${f.date}:${f.forecast}(${f.lower}-${f.upper})`).join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

function updateForecastContext(results, modelType) {
  const key = modelType.toLowerCase(); // "arima" hoặc "arimax"
  for (const r of results) {
    if (r.error) {
      forecastStore[r.symbol] = forecastStore[r.symbol] ?? {};
      forecastStore[r.symbol][key] = { error: r.error };
      continue;
    }
    const ohlcv = r.ohlcv;
    const lastOhlcv = ohlcv && ohlcv.dates?.length ? {
      date:   ohlcv.dates[ohlcv.dates.length - 1],
      open:   +ohlcv.open[ohlcv.dates.length - 1].toFixed(2),
      high:   +ohlcv.high[ohlcv.dates.length - 1].toFixed(2),
      low:    +ohlcv.low[ohlcv.dates.length - 1].toFixed(2),
      close:  +ohlcv.close[ohlcv.dates.length - 1].toFixed(2),
      volume: Math.round(ohlcv.volume[ohlcv.dates.length - 1]),
    } : null;

    const m  = r.metrics ?? {};
    const fr = r.forecastRes ?? [];
    const fd = r.fcDates    ?? [];

    forecastStore[r.symbol] = forecastStore[r.symbol] ?? {};
    forecastStore[r.symbol][key] = {
      model:    `${modelType}(${r.p},${r.d},${r.q})`,
      lastOhlcv,
      metrics:  { mae: +m.mae?.toFixed(2), rmse: +m.rmse?.toFixed(2), mape: +m.mape?.toFixed(2) },
      forecast: fr.map((f, i) => ({
        date:     fd[i] ?? `+${i + 1}`,
        forecast: +f.forecast.toFixed(2),
        lower:    +f.lower.toFixed(2),
        upper:    +f.upper.toFixed(2),
      })),
      updatedAt: new Date().toLocaleString("vi-VN"),
    };
  }

  // Vẫn cập nhật textarea để hiển thị (tóm tắt ngắn)
  const lines = [`\n--- ${modelType} (${new Date().toLocaleString("vi-VN")}) ---`];
  for (const r of results) {
    if (r.error) { lines.push(`${r.symbol}: LỖI — ${r.error}`); continue; }
    lines.push(`${r.symbol}: đã lưu (${(r.forecastRes ?? []).length} bước dự báo)`);
  }
  const el = document.getElementById("forecastContext");
  if (el) el.value = (el.value + lines.join("\n")).slice(-3000); // giới hạn textarea
}

// ── Auto DB query for LLM context ────────────────────────────────────────────
function queryDbForContext(userText) {
  if (!db) return "";

  // Detect symbols: ưu tiên selectedSymbols, fallback scan text
  const allSymbols = (() => {
    try {
      const res = db.exec("SELECT symbol FROM symbols");
      return res.length ? res[0].values.map(r => r[0]) : [];
    } catch { return []; }
  })();

  const mentionedSymbols = allSymbols.filter(s =>
    userText.toUpperCase().includes(s.toUpperCase())
  );
  const symbols = mentionedSymbols.length ? mentionedSymbols : (selectedSymbols ?? []);
  if (!symbols.length) return "";

  // Detect time range from text
  const txt = userText.toLowerCase();

  // Try to detect a specific date: 2026/02/06, 2026-02-06, 06/02/2026, ngày 6 tháng 2 năm 2026, etc.
  let exactDate = null;
  const isoSlash  = userText.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);   // yyyy/mm/dd
  const dmySlash  = userText.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);   // dd/mm/yyyy
  const viDate    = userText.match(/ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(\d{4})/i);
  if (isoSlash) {
    exactDate = `${isoSlash[1]}-${isoSlash[2].padStart(2,"0")}-${isoSlash[3].padStart(2,"0")}`;
  } else if (dmySlash) {
    exactDate = `${dmySlash[3]}-${dmySlash[2].padStart(2,"0")}-${dmySlash[1].padStart(2,"0")}`;
  } else if (viDate) {
    exactDate = `${viDate[3]}-${viDate[2].padStart(2,"0")}-${viDate[1].padStart(2,"0")}`;
  }

  let sql, cutoff, rangeLabel;
  if (exactDate) {
    const d = new Date(exactDate);
    if (isNaN(d.getTime())) {
      console.warn("[DB] Invalid exactDate parsed:", exactDate, "— falling back to default range");
      exactDate = null;
    }
  }

  if (exactDate) {
    // Query exact date (and ±3 days around it in case of holiday/weekend)
    const d = new Date(exactDate);
    const from = new Date(d - 3 * 86400000).toISOString().slice(0, 10);
    const to   = new Date(d.getTime() + 3 * 86400000).toISOString().slice(0, 10);
    sql        = "SELECT date, open, high, low, close, volume, percent_change FROM stock_prices " +
                 "WHERE symbol=? AND date>=? AND date<=? ORDER BY date DESC LIMIT 10";
    cutoff     = [from, to];
    rangeLabel = `ngày ${exactDate} (±3 ngày)`;
  } else {
    let days = 1;
    if (/tu[aầ]n/.test(txt))              days = 7;
    else if (/tháng/.test(txt))            days = 30;
    else if (/quý/.test(txt))              days = 90;
    else if (/năm/.test(txt))              days = 365;
    else if (/(\d+)\s*ngày/.test(txt))     days = parseInt(txt.match(/(\d+)\s*ngày/)[1]);
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    sql        = "SELECT date, open, high, low, close, volume, percent_change FROM stock_prices " +
                 "WHERE symbol=? AND date>=? ORDER BY date DESC LIMIT 30";
    cutoff     = [from];
    rangeLabel = days === 1 ? "hôm nay / phiên gần nhất" : `${days} ngày gần nhất`;
  }

  const lines = ["\n--- Dữ liệu DB truy vấn tự động ---"];
  for (const sym of symbols.slice(0, 5)) { // giới hạn 5 mã
    try {
      const params = [sym, ...cutoff];
      console.log(`[DB] SQL: ${sql}`);
      console.log(`[DB] Params:`, params);

      const res = db.exec(sql, params);

      if (!res.length || !res[0].values.length) {
        console.log(`[DB] ${sym}: no rows returned`);
        lines.push(`\n${sym}: Không có dữ liệu trong khoảng thời gian này.`);
        continue;
      }

      console.log(`[DB] ${sym}: ${res[0].values.length} rows`, res[0].values);

      lines.push(`\nMã ${sym} (${rangeLabel}):`);
      lines.push("  Ngày       | Mở    | Cao   | Thấp  | Đóng  | KL          | %Thay đổi");
      for (const [date, o, h, l, c, vol, pct] of res[0].values) {
        const fmt = v => v != null ? parseFloat(v).toFixed(1) : "N/A";
        const fmtVol = v => v != null ? Math.round(v).toLocaleString("vi-VN") : "N/A";
        const fmtPct = v => v != null ? `${parseFloat(v).toFixed(2)}%` : "N/A";
        lines.push(`  ${date} | ${fmt(o)} | ${fmt(h)} | ${fmt(l)} | ${fmt(c)} | ${fmtVol(vol)} | ${fmtPct(pct)}`);
      }
    } catch (e) {
      console.error(`[DB] ${sym}: query error`, e);
      lines.push(`\n${sym}: Lỗi truy vấn — ${e.message}`);
    }
  }

  const result = lines.join("\n");
  console.log("[DB] Final context injected to LLM:\n" + result);
  return result;
}

// ── Send message ──────────────────────────────────────────────────────────────
function sendLlmMessage() {
  if (!llmModelLoaded || llmGenerating) return;
  const input = document.getElementById("llmInput");
  const text  = input.value.trim();
  if (!text) return;

  input.value   = "";
  llmGenerating = true;
  document.getElementById("llmSendBtn").disabled  = true;
  document.getElementById("llmAbortBtn").classList.remove("hidden");
  document.getElementById("llmInput").disabled    = true;

  appendChatBubble("user", text);

  try {
    // Detect symbols mentioned in the message — chỉ xét trong selectedSymbols đang chọn
    const mentioned = (selectedSymbols ?? []).filter(s => text.toUpperCase().includes(s.toUpperCase()));
    // Nếu có nhắc đến mã cụ thể thì chỉ lấy mã đó, không thì lấy tất cả selectedSymbols
    const targetSymbols = [...new Set(mentioned.length ? mentioned : (selectedSymbols ?? []))];

    const forecastCtx = mentioned.length > 0 ? buildForecastContext(targetSymbols) : "";
    let dbCtx = "";
    try {
      dbCtx = queryDbForContext(text);
    } catch (dbErr) {
      console.error("[DB] queryDbForContext error:", dbErr);
      appendSystemMsg(`⚠️ Lỗi truy vấn DB: ${dbErr.message}`);
    }

    const systemPrompt =
      "Dữ liệu dự báo:\n" + forecastCtx +
      (dbCtx ? "\n" + dbCtx : "") +
      "\n\n---\n" +
      "Bạn là trợ lý tra cứu số liệu chứng khoán Việt Nam. " +
      "Đơn vị giá trong dữ liệu trên là nghìn đồng/cổ phiếu (ví dụ: 75.1 = 75,100 VND). " +
      "Chỉ trả lời câu hỏi của người dùng dựa trên dữ liệu trên. " +
      "Không tự phân tích hay khuyến nghị đầu tư. " +
      "Không bịa số liệu. Trả lời ngắn gọn bằng tiếng Việt.";

    console.log("[LLM] selectedSymbols:", selectedSymbols);
    console.log("[LLM] mentioned in text:", mentioned);
    console.log("[LLM] targetSymbols (final):", targetSymbols);
    console.log("[LLM] forecastCtx:\n" + forecastCtx);
    console.log("[LLM] dbCtx:\n" + (dbCtx || "(empty)"));

    _llmDebugCtx = { forecastCtx, dbCtx };
    console.log("[LLM] systemPrompt length:", systemPrompt.length, "chars");

    llmChatHistory.push({ role: "user", content: text });
    if (llmChatHistory.length > LLM_HISTORY_LIMIT) llmChatHistory = llmChatHistory.slice(-LLM_HISTORY_LIMIT);

    const messages = [
      { role: "system", content: systemPrompt },
      ...llmChatHistory,
    ];

    console.log("[LLM] messages sent to model:", JSON.stringify(messages, null, 2));

    _llmFullText = "";
    const enableThinking = document.getElementById("llmThinkChk")?.checked ?? false;
    llmWorker.postMessage({ type: "generate", data: { messages, enableThinking } });
  } catch (e) {
    console.error("[LLM] sendLlmMessage error:", e);
    appendSystemMsg(`❌ Lỗi: ${e.message}`);
    llmGenerating = false;
    document.getElementById("llmSendBtn").disabled  = false;
    document.getElementById("llmAbortBtn").classList.add("hidden");
    document.getElementById("llmInput").disabled    = false;
  }
}

function abortLlm() {
  if (llmWorker) llmWorker.postMessage({ type: "interrupt" });
}

function clearLlmChat() {
  llmChatHistory = [];
  llmWorker?.postMessage({ type: "reset" });
  document.getElementById("llmMessages").innerHTML =
    '<div class="llm-msg llm-msg--system">Lịch sử đã xóa.</div>';
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function appendChatBubble(role, text) {
  const wrap = document.getElementById("llmMessages");
  const div  = document.createElement("div");
  div.className   = `llm-msg llm-msg--${role}`;
  div.textContent = text;
  wrap.appendChild(div);
  scrollChatToBottom();
  return div;
}

function appendSystemMsg(text) {
  const wrap = document.getElementById("llmMessages");
  const div  = document.createElement("div");
  div.className   = "llm-msg llm-msg--system";
  div.textContent = text;
  wrap.appendChild(div);
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const box = document.getElementById("llmChatBox");
  if (box) box.scrollTop = box.scrollHeight;
}

function setLlmStatus(msg) {
  const el = document.getElementById("llmStatusMsg");
  if (el) el.textContent = msg;
}

// ── Bind LLM UI ───────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const bubbleBtn = document.getElementById("chatBubbleBtn");
  const chatPanel = document.getElementById("chatPanel");
  const closeBtn  = document.getElementById("chatCloseBtn");

  function openChat() {
    chatPanel.classList.remove("hidden");
    chatPanel.classList.add("chat-panel--opening");
    chatPanel.addEventListener("animationend",
      () => chatPanel.classList.remove("chat-panel--opening"), { once: true });
    bubbleBtn.style.background = "#2d6fe0";
    document.getElementById("chatBubbleBadge").classList.add("hidden");
    // Boot worker on first open so cache check runs early
    ensureLlmWorker();
    scrollChatToBottom();
  }
  function closeChat() {
    chatPanel.classList.add("hidden");
    bubbleBtn.style.background = "";
  }

  bubbleBtn.addEventListener("click", () =>
    chatPanel.classList.contains("hidden") ? openChat() : closeChat());
  closeBtn.addEventListener("click", closeChat);

  document.addEventListener("click", (e) => {
    if (!chatPanel.classList.contains("hidden") &&
        !chatPanel.contains(e.target) &&
        e.target !== bubbleBtn) closeChat();
  });

  document.getElementById("llmLoadBtn") .addEventListener("click", loadLlmModel);
  document.getElementById("llmSendBtn") .addEventListener("click", sendLlmMessage);
  document.getElementById("llmAbortBtn").addEventListener("click", abortLlm);
  document.getElementById("llmClearBtn").addEventListener("click", clearLlmChat);

  document.getElementById("llmInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendLlmMessage(); }
  });

  // Think checkbox — notify worker immediately so next generate picks it up
  document.getElementById("llmThinkChk").addEventListener("change", (e) => {
    const enabled = e.target.checked;
    appendSystemMsg(enabled ? "💭 Think: BẬT" : "💭 Think: TẮT");
  });
});

