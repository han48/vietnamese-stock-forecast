/**
 * arima.worker.js — Web Worker for ARIMA analysis
 * Loads WASM-compiled ctsa C library (same backend as Python statsmodels)
 */

let ARIMAClass = null;

// ── Load ARIMA WASM ───────────────────────────────────────────────────────────
async function loadARIMA() {
  if (ARIMAClass) return;

  // Fetch WASM binary
  const wasmResp = await fetch("native.wasm");
  const wasmBinary = await wasmResp.arrayBuffer();

  // Load Emscripten module factory (sets global `Module`)
  importScripts("native-async.js");

  // Module is now a global factory function
  const m = await Module({ wasmBinary: new Uint8Array(wasmBinary) }); // eslint-disable-line no-undef

  // Build ARIMA class wrapper
  ARIMAClass = buildARIMAClass(m);
}

function buildARIMAClass(m) {
  // C function wrappers
  const _fit   = m.cwrap("fit_sarimax",     "number", ["array","array","number","number","number","number","number","number","number","number","number","number","number","boolean"]);
  const _pred  = m.cwrap("predict_sarimax", "number", ["number","array","array","array","number"]);
  const _freeS = m.cwrap("free_sarimax",    null,     ["number"]);
  const _freeR = m.cwrap("free_result",     null,     ["number"]);

  function uintify(arr) {
    return new Uint8Array(Float64Array.from(arr).buffer);
  }

  function getResults(addr, len) {
    const res = [[], []];  // [predictions, variances]
    for (let i = 0; i < len * 2; i++) {
      res[i < len ? 0 : 1].push(m.HEAPF64[addr / Float64Array.BYTES_PER_ELEMENT + i]);
    }
    return res;
  }

  return class ARIMA {
    constructor(opts = {}) {
      const defaults = { method: 0, optimizer: 6, verbose: false, p: 1, d: 1, q: 1 };
      this.o = Object.assign({}, defaults, opts);
      this.model = null;
    }

    train(ts) {
      const o = this.o;
      const minLen = o.d + Math.max(o.p + o.q, 10);
      if (ts.length < minLen) throw new Error(`Series too short (${ts.length}), need ≥ ${minLen}`);

      if (this.model) { _freeS(this.model); this.model = null; }

      this.ts  = uintify(ts);
      this.lin = ts.length;

      // fit_sarimax(ts, exog, p, d, q, P, D, Q, s, nexog, lin, method, optimizer, verbose)
      this.model = _fit(
        this.ts, uintify([]),  // ts, exog (empty)
        o.p, o.d, o.q,         // ARIMA params
        0, 0, 0, 0,            // seasonal P,D,Q,s (disabled)
        0,                     // nexog
        this.lin,              // length
        o.method,              // 0 = MLE
        o.optimizer,           // 6 = L-BFGS
        o.verbose
      );

      return this;
    }

    predict(steps) {
      // predict_sarimax(model, ts, exog_old, exog_new, steps)
      const addr = _pred(this.model, this.ts, uintify([]), uintify([]), steps);
      const res  = getResults(addr, steps);
      _freeR(addr);
      return res;  // [predictions[], variances[]]
    }

    destroy() {
      if (this.model) { _freeS(this.model); this.model = null; }
    }
  };
}

// ── AIC computation ───────────────────────────────────────────────────────────
function computeAIC(ts, p, d, q) {
  try {
    const model = new ARIMAClass({ p, d, q, verbose: false });
    model.train(ts);

    // Predict 1 step to get variance estimate
    const [preds, vars] = model.predict(1);
    const sigma2 = vars[0] || 1;

    const n = ts.length;
    const k = p + q + (d > 0 ? 1 : 0) + 1;  // params count
    const aic = 2 * k + n * Math.log(Math.max(sigma2, 1e-10));

    model.destroy();
    return { aic };
  } catch {
    return { aic: Infinity };
  }
}

// ── Grid search ───────────────────────────────────────────────────────────────
function gridSearch(ts, pMax, dMax, qMax) {
  let best = { aic: Infinity, p: 1, d: 1, q: 1 };
  for (let d = 0; d <= dMax; d++) {
    for (let p = 0; p <= pMax; p++) {
      for (let q = 0; q <= qMax; q++) {
        if (p === 0 && q === 0) continue;
        const { aic } = computeAIC(ts, p, d, q);
        if (aic < best.aic) best = { aic, p, d, q };
      }
    }
  }
  return best;
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
  return {
    mae:  mae / n,
    rmse: Math.sqrt(mse / n),
    mape: (mape / n) * 100,
  };
}

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  if (type === "init") {
    try {
      await loadARIMA();
      self.postMessage({ id, type: "init_ok" });
    } catch (err) {
      self.postMessage({ id, type: "error", message: `Init failed: ${err.message}` });
    }
    return;
  }

  if (type === "analyse") {
    try {
      const { symbol, values, dates, autoParams, p, d, q, forecastSteps, minPct = -0.07, maxPct = 0.07 } = payload;

      if (values.length < 20) {
        throw new Error(`Không đủ dữ liệu (${values.length} phiên, cần ≥ 20)`);
      }

      // Train/test split 80/20
      const splitIdx  = Math.floor(values.length * 0.8);
      const trainVals = values.slice(0, splitIdx);
      const testVals  = values.slice(splitIdx);

      self.postMessage({ id, type: "progress", message: `${symbol}: ${autoParams ? "Grid search..." : "Huấn luyện..."}` });

      let bestP = p, bestD = d, bestQ = q, bestAIC;

      if (autoParams) {
        const best = gridSearch(trainVals, 3, 2, 3);
        bestP = best.p; bestD = best.d; bestQ = best.q; bestAIC = best.aic;
      }

      // Train on train set
      const model = new ARIMAClass({ p: bestP, d: bestD, q: bestQ, verbose: false });
      model.train(trainVals);

      // Compute AIC if not from grid search
      if (!autoParams) {
        const { aic } = computeAIC(trainVals, bestP, bestD, bestQ);
        bestAIC = aic;
      }

      // Evaluate on test set
      const [testPreds] = model.predict(testVals.length);
      const metrics = calcMetrics(testVals, testPreds);

      // Re-train on full series for forecasting
      model.destroy();
      const fullModel = new ARIMAClass({ p: bestP, d: bestD, q: bestQ, verbose: false });
      fullModel.train(values);

      const [fcPreds, fcVars] = fullModel.predict(forecastSteps);
      fullModel.destroy();

      // Build 95% CI: ±1.96 * sqrt(variance), clamp each step by price limit
      const lastPrice = values[values.length - 1];
      const forecastRes = [];
      for (let i = 0; i < fcPreds.length; i++) {
        const fc = fcPreds[i];
        const se = Math.sqrt(Math.max(fcVars[i], 0));
        const prevPrice = i === 0 ? lastPrice : forecastRes[i - 1].forecast;
        const lo = prevPrice * (1 + minPct);
        const hi = prevPrice * (1 + maxPct);
        const forecast = Math.min(Math.max(fc, lo), hi);
        forecastRes.push({
          forecast,
          lower:   Math.max(forecast - 1.96 * se, lo),
          upper:   Math.min(forecast + 1.96 * se, hi),
          limitLo: lo,
          limitHi: hi,
        });
      }

      // Forecast dates (skip weekends)
      const lastDate = new Date(dates[dates.length - 1]);
      const fcDates = [];
      let cur = new Date(lastDate);
      for (let i = 0; i < forecastSteps; i++) {
        cur = new Date(cur);
        cur.setDate(cur.getDate() + 1);
        while (cur.getDay() === 0 || cur.getDay() === 6) {
          cur.setDate(cur.getDate() + 1);
        }
        fcDates.push(cur.toISOString().slice(0, 10));
      }

      self.postMessage({
        id,
        type: "result",
        payload: {
          symbol,
          values,
          dates,
          splitIdx,
          trainVals,
          testVals,
          testPreds,
          metrics,
          p: bestP,
          d: bestD,
          q: bestQ,
          aic: bestAIC,
          forecastRes,
          fcDates,
        },
      });
    } catch (err) {
      self.postMessage({
        id,
        type: "error",
        message: `${payload.symbol}: ${err.message}`,
      });
    }
  }
};
