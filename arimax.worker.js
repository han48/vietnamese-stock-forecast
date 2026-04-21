/**
 * arimax.worker.js  — ARIMAX using the WASM SARIMAX engine with real exog.
 *
 * Features (exogenous regressors) tính từ OHLCV:
 *   returns    — log return của close  (momentum)
 *   hlRange    — (high − low) / close  (intraday volatility)
 *   volumeMa5  — volume / MA5(volume)  (volume pressure)
 *   rsi14      — RSI 14, scaled 0–1    (overbought/oversold)
 *   macdHist   — MACD histogram / close (trend signal)
 *   varPred    — VAR(1) 1-step-ahead ratio: predicted_close/close − 1
 *
 * Model:  ARIMAX(p,d,q)  ≡  SARIMAX(p,d,q)(0,0,0) with nexog exogenous cols.
 * The WASM fit_sarimax / predict_sarimax functions accept a flat row-major
 * exog matrix, so we flatten [n × nexog] → Float64 before passing.
 *
 * Forecast exog: carry-forward the last observed row (naive, but consistent
 * with the fact that we have no future OHLCV).
 */

"use strict";

// ── WASM bootstrap ────────────────────────────────────────────────────────────
let _wasm = null;   // raw Emscripten module
let _fit, _pred, _freeS, _freeR;

async function loadWASM() {
  if (_wasm) return;
  const wasmResp   = await fetch("native.wasm");
  const wasmBinary = await wasmResp.arrayBuffer();
  importScripts("native-async.js");                          // sets global Module
  _wasm = await Module({ wasmBinary: new Uint8Array(wasmBinary) }); // eslint-disable-line no-undef

  _fit   = _wasm.cwrap("fit_sarimax",     "number",
             ["array","array","number","number","number",
              "number","number","number","number","number",
              "number","number","number","boolean"]);
  _pred  = _wasm.cwrap("predict_sarimax", "number",
             ["number","array","array","array","number"]);
  _freeS = _wasm.cwrap("free_sarimax",    null, ["number"]);
  _freeR = _wasm.cwrap("free_result",     null, ["number"]);
}

function f64bytes(arr) {
  return new Uint8Array(Float64Array.from(arr).buffer);
}

function readHeap(addr, len) {
  const base = addr / Float64Array.BYTES_PER_ELEMENT;
  const preds = [], vars = [];
  for (let i = 0; i < len; i++) {
    preds.push(_wasm.HEAPF64[base + i]);
    vars.push( _wasm.HEAPF64[base + len + i]);
  }
  return [preds, vars];
}

// ── Math helpers ──────────────────────────────────────────────────────────────
function rollingMean(arr, w) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= w) sum -= arr[i - w];
    if (i >= w - 1) out[i] = sum / w;
  }
  return out;
}

function ema(arr, span) {
  const k = 2 / (span + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i-1] * (1 - k));
  return out;
}

function rsi14(close) {
  const out = new Array(close.length).fill(NaN);
  const P = 14;
  let ag = 0, al = 0;
  for (let i = 1; i <= P; i++) {
    const d = close[i] - close[i-1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= P; al /= P;
  out[P] = al === 0 ? 1 : 1 - 1 / (1 + ag / al);
  for (let i = P + 1; i < close.length; i++) {
    const d = close[i] - close[i-1];
    ag = (ag * (P-1) + Math.max(d, 0)) / P;
    al = (al * (P-1) + Math.max(-d, 0)) / P;
    out[i] = al === 0 ? 1 : 1 - 1 / (1 + ag / al);
  }
  return out;
}

function macdHist(close) {
  const ef = ema(close, 12), es = ema(close, 26);
  const ml = ef.map((v, i) => v - es[i]);
  const sl = ema(ml, 9);
  return ml.map((v, i) => (v - sl[i]) / (close[i] || 1));
}

// ── VAR(1) via OLS (Gauss-Jordan) ─────────────────────────────────────────────
function invertMatrix(M) {
  const n = M.length;
  const A = M.map(r => [...r]);
  const I = Array.from({length:n}, (_,i) => Array.from({length:n}, (_,j) => i===j?1:0));
  for (let c = 0; c < n; c++) {
    let piv = c, pivV = 0;
    for (let r = c; r < n; r++) if (Math.abs(A[r][c]) > pivV) { pivV = Math.abs(A[r][c]); piv = r; }
    if (pivV < 1e-12) return null;
    [A[c],A[piv]] = [A[piv],A[c]]; [I[c],I[piv]] = [I[piv],I[c]];
    const sc = A[c][c];
    A[c] = A[c].map(v => v/sc); I[c] = I[c].map(v => v/sc);
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      A[r] = A[r].map((v,j) => v - f*A[c][j]);
      I[r] = I[r].map((v,j) => v - f*I[c][j]);
    }
  }
  return I;
}

function fitVAR1(cols) {
  const n = cols[0].length, k = cols.length;
  const Xint = [], Y = [];
  for (let t = 1; t < n; t++) {
    Xint.push([1, ...cols.map(c => c[t-1])]);
    Y.push(cols.map(c => c[t]));
  }
  const m = n - 1, kk = k + 1;
  const XtX = Array.from({length:kk}, () => new Array(kk).fill(0));
  for (let i = 0; i < m; i++)
    for (let a = 0; a < kk; a++)
      for (let b = 0; b < kk; b++) XtX[a][b] += Xint[i][a] * Xint[i][b];
  const inv = invertMatrix(XtX);
  if (!inv) return null;
  return Array.from({length:k}, (_,j) => {
    const Xty = new Array(kk).fill(0);
    for (let i = 0; i < m; i++)
      for (let a = 0; a < kk; a++) Xty[a] += Xint[i][a] * Y[i][j];
    return inv.map(row => row.reduce((s,v,idx) => s + v*Xty[idx], 0));
  });
}

// ── Feature engineering ───────────────────────────────────────────────────────
/**
 * Returns { matrix: number[][], names: string[], startIdx: number }
 * matrix[t] = [returns, hlRange, volumeMa5, rsi14, macdHist, varPred]  (one row per bar)
 * All features are stationary / bounded — safe as exog regressors.
 */
function buildFeatures(open, high, low, close, volume) {
  const n = close.length;

  // 1. Log return (stationary)
  const ret = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) ret[i] = Math.log(close[i] / close[i-1]);

  // 2. H-L range / close  (bounded > 0)
  const hlr = high.map((h, i) => (h - low[i]) / (close[i] || 1));

  // 3. Volume / MA5(volume)  (≈1 on average)
  const vm5 = rollingMean(volume, 5);
  const volR = volume.map((v, i) => vm5[i] > 0 ? v / vm5[i] : NaN);

  // 4. RSI14 scaled 0–1
  const r14 = rsi14(close);

  // 5. MACD histogram / close
  const mcd = macdHist(close);

  // 6. VAR(1) predicted-close ratio  (fit once on full history)
  const varR = new Array(n).fill(NaN);
  const varBetas = fitVAR1([open, high, low, volume]);
  if (varBetas) {
    for (let t = 1; t < n; t++) {
      const lag = [1, open[t-1], high[t-1], low[t-1], volume[t-1]];
      const pO = varBetas[0].reduce((s,b,i) => s + b*lag[i], 0);
      const pH = varBetas[1].reduce((s,b,i) => s + b*lag[i], 0);
      const pL = varBetas[2].reduce((s,b,i) => s + b*lag[i], 0);
      varR[t] = ((pO + pH + pL) / 3 - close[t]) / (close[t] || 1);
    }
  }

  const cols = [ret, hlr, volR, r14, mcd, varR];
  const names = ["returns","hlRange","volumeMa5","rsi14","macdHist","varPred"];

  // First row where every feature is finite
  let startIdx = 0;
  outer: for (let i = 0; i < n; i++) {
    for (const c of cols) if (!isFinite(c[i])) continue outer;
    startIdx = i; break;
  }

  // Build row-major matrix
  const matrix = [];
  for (let i = startIdx; i < n; i++) matrix.push(cols.map(c => c[i]));

  return { matrix, names, startIdx };
}

// ── Flatten exog matrix to Float64 row-major ──────────────────────────────────
function flattenExog(matrix) {
  // matrix: rows × cols  →  Float64Array row-major
  if (!matrix.length) return [];
  const rows = matrix.length, cols = matrix[0].length;
  const out = new Array(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) out[r * cols + c] = matrix[r][c];
  return out;
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function calcMetrics(actual, predicted) {
  const n = actual.length;
  let mae = 0, mse = 0, mape = 0;
  for (let i = 0; i < n; i++) {
    const e = actual[i] - predicted[i];
    mae  += Math.abs(e);
    mse  += e * e;
    if (actual[i] !== 0) mape += Math.abs(e / actual[i]);
  }
  return { mae: mae/n, rmse: Math.sqrt(mse/n), mape: (mape/n)*100 };
}

// ── AIC helper ────────────────────────────────────────────────────────────────
function computeAIC_exog(ts, exogFlat, nexog, p, d, q) {
  try {
    const model = _fit(
      f64bytes(ts), f64bytes(exogFlat),
      p, d, q, 0, 0, 0, 0, nexog,
      ts.length, 0, 6, false
    );
    if (!model) return Infinity;
    // predict 1 step with same last exog row carried forward
    const lastExog = exogFlat.slice(-nexog);
    const addr = _pred(model, f64bytes(ts), f64bytes(exogFlat), f64bytes(lastExog), 1);
    const [, vars] = readHeap(addr, 1);
    _freeR(addr); _freeS(model);
    const sigma2 = vars[0] || 1;
    const k = p + q + (d > 0 ? 1 : 0) + nexog + 1;
    return 2 * k + ts.length * Math.log(Math.max(sigma2, 1e-10));
  } catch { return Infinity; }
}

function gridSearch(ts, exogFlat, nexog, pMax, dMax, qMax) {
  let best = { aic: Infinity, p: 1, d: 0, q: 0 };
  for (let d = 0; d <= dMax; d++)
    for (let p = 0; p <= pMax; p++)
      for (let q = 0; q <= qMax; q++) {
        if (p === 0 && q === 0) continue;
        const aic = computeAIC_exog(ts, exogFlat, nexog, p, d, q);
        if (aic < best.aic) best = { aic, p, d, q };
      }
  return best;
}

// ── Main analysis ─────────────────────────────────────────────────────────────
function analyseARIMAX(payload) {
  const {
    symbol, open, high, low, close, volume, dates,
    autoParams, p, d, q, forecastSteps,
    minPct = -0.07, maxPct = 0.07,
  } = payload;

  if (close.length < 50) throw new Error(`Không đủ dữ liệu (${close.length} phiên, cần ≥ 50)`);

  // ── 1. Features ────────────────────────────────────────────────────────────
  const { matrix: exogMatrix, names, startIdx } = buildFeatures(open, high, low, close, volume);
  const nexog = names.length;

  const validClose = close.slice(startIdx);
  const validDates = dates.slice(startIdx);
  const nv = validClose.length;

  // ── 2. Train / test split ──────────────────────────────────────────────────
  const splitIdx   = Math.floor(nv * 0.8);
  const trainClose = validClose.slice(0, splitIdx);
  const testClose  = validClose.slice(splitIdx);
  const trainExog  = exogMatrix.slice(0, splitIdx);   // rows
  const testExog   = exogMatrix.slice(splitIdx);

  const trainExogFlat = flattenExog(trainExog);
  const testExogFlat  = flattenExog(testExog);

  // ── 3. Find params ─────────────────────────────────────────────────────────
  let bestP = p, bestD = d, bestQ = q;
  if (autoParams) {
    const best = gridSearch(trainClose, trainExogFlat, nexog, 3, 2, 3);
    bestP = best.p; bestD = best.d; bestQ = best.q;
  }

  // ── 4. Train ARIMAX on train set ───────────────────────────────────────────
  const trainModel = _fit(
    f64bytes(trainClose), f64bytes(trainExogFlat),
    bestP, bestD, bestQ, 0, 0, 0, 0, nexog,
    trainClose.length, 0, 6, false
  );
  if (!trainModel) throw new Error("ARIMAX fit failed on train set");

  // ── 5. Evaluate on test ────────────────────────────────────────────────────
  const nTest = testClose.length;
  const evalAddr = _pred(
    trainModel,
    f64bytes(trainClose), f64bytes(trainExogFlat), f64bytes(testExogFlat),
    nTest
  );
  const [testPreds] = readHeap(evalAddr, nTest);
  _freeR(evalAddr);
  _freeS(trainModel);
  const metrics = calcMetrics(testClose, testPreds);

  // ── 6. Re-fit on full data for forecast ────────────────────────────────────
  const fullExogFlat = flattenExog(exogMatrix);
  const fullModel = _fit(
    f64bytes(validClose), f64bytes(fullExogFlat),
    bestP, bestD, bestQ, 0, 0, 0, 0, nexog,
    nv, 0, 6, false
  );
  if (!fullModel) throw new Error("ARIMAX fit failed on full data");

  // Carry-forward last exog row for all forecast steps
  const lastExogRow  = exogMatrix[exogMatrix.length - 1];
  const futureExog   = flattenExog(Array(forecastSteps).fill(lastExogRow));

  const fcAddr = _pred(
    fullModel,
    f64bytes(validClose), f64bytes(fullExogFlat), f64bytes(futureExog),
    forecastSteps
  );
  const [fcPreds, fcVars] = readHeap(fcAddr, forecastSteps);
  _freeR(fcAddr);
  _freeS(fullModel);

  // ── 7. Apply per-step price-change limits ──────────────────────────────────
  const lastPrice = validClose[nv - 1];
  const forecastRes = [];
  for (let i = 0; i < forecastSteps; i++) {
    const prevPrice = i === 0 ? lastPrice : forecastRes[i-1].forecast;
    const lo = prevPrice * (1 + minPct);
    const hi = prevPrice * (1 + maxPct);
    const se = Math.sqrt(Math.max(fcVars[i], 0));
    const forecast = Math.min(Math.max(fcPreds[i], lo), hi);
    forecastRes.push({
      forecast,
      lower:   Math.max(forecast - 1.96 * se, lo),
      upper:   Math.min(forecast + 1.96 * se, hi),
      limitLo: lo,
      limitHi: hi,
    });
  }

  // ── 8. Forecast dates (skip weekends) ──────────────────────────────────────
  const fcDates = [];
  let cur = new Date(validDates[nv - 1]);
  for (let i = 0; i < forecastSteps; i++) {
    cur = new Date(cur); cur.setDate(cur.getDate() + 1);
    while (cur.getDay() === 0 || cur.getDay() === 6) cur.setDate(cur.getDate() + 1);
    fcDates.push(cur.toISOString().slice(0, 10));
  }

  // ── 9. Feature importance from last exog row (relative magnitude) ──────────
  // Use the variance of each feature across training as a proxy for importance
  const featureImportance = names.map((name, j) => {
    const col = trainExog.map(r => r[j]);
    const mean = col.reduce((s, v) => s + v, 0) / col.length;
    const std  = Math.sqrt(col.reduce((s, v) => s + (v - mean) ** 2, 0) / col.length) || 1;
    // Standardised last value — how "extreme" is the current signal
    const signal = Math.abs((lastExogRow[j] - mean) / std);
    return { name, coef: lastExogRow[j], absCoef: signal, normCoef: signal };
  }).sort((a, b) => b.absCoef - a.absCoef);

  return {
    symbol,
    values: validClose,
    dates:  validDates,
    splitIdx,
    testClose,
    testPreds,
    metrics,
    p: bestP, d: bestD, q: bestQ,
    forecastRes,
    fcDates,
    featureImportance,
    featureNames: names,
  };
}

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  if (type === "init") {
    try {
      await loadWASM();
      self.postMessage({ id, type: "init_ok" });
    } catch (err) {
      self.postMessage({ id, type: "error", message: `Init failed: ${err.message}` });
    }
    return;
  }

  if (type === "analyse_arimax") {
    try {
      self.postMessage({ id, type: "progress", message: `${payload.symbol}: Tính features + fit ARIMAX...` });
      const result = analyseARIMAX(payload);
      self.postMessage({ id, type: "result", payload: result });
    } catch (err) {
      self.postMessage({ id, type: "error", message: `${payload.symbol}: ${err.message}` });
    }
  }
};
