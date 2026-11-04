"use strict";
/* Motor de análise por padrões parecidos. Entrada: fechamentos diários JÁ ENCERRADOS + preço atual opcional.
   Tudo o que o modelo sabe em cada data vem só de dados anteriores a ela. */
const D = 15, START = 50, MIN_POOL = 120;
const MAX_HIST = 1500; // atalho: BTC/ETH têm histórico enorme e travavam; ~4 anos bastam
const STEP = 2;        // atalho: backtest avalia 1 dia sim, 1 não (metade do custo)

let K = 28, MIN_N = 12;
let PUP = .58, THR = .25, TREND = 200; // TREND: filtro de tendência (média de N dias) p/ compras; 0 = desligado
let WEIGHTS = [.55,.55,.55,.55,.55,.55,.55,.55,.55,.55, 1.35,1.4,1.25,1.0,1.3];

const getParams = () => ({ K, MIN_N, PUP, THR, TREND, WEIGHTS: WEIGHTS.slice(), D, START, MIN_POOL });
function setParams(p) {
  if (!p) return getParams();
  if (Number.isFinite(p.K) && p.K >= 10 && p.K <= 60) K = Math.round(p.K);
  if (Number.isFinite(p.pUp) && p.pUp >= .5 && p.pUp <= .75) PUP = p.pUp;
  if (Number.isFinite(p.thr) && p.thr >= 0 && p.thr <= 1) THR = p.thr;
  if (Number.isFinite(p.trend) && (p.trend === 0 || (p.trend >= 50 && p.trend <= 250))) TREND = Math.round(p.trend);
  cache.clear(); // parâmetros mudaram: backtest em cache ficou velho
  const mn = Number.isFinite(p.minN) ? p.minN : p.MIN_N;
  if (Number.isFinite(mn) && mn >= 6 && mn <= 40) MIN_N = Math.round(mn);
  const w = Array.isArray(p.weights) ? p.weights : p.WEIGHTS;
  if (Array.isArray(w) && w.length === D)
    WEIGHTS = w.map((x, i) => Number.isFinite(Number(x)) ? Math.max(0.2, Math.min(2.5, Number(x))) : WEIGHTS[i]);
  return getParams();
}

function stdev(a, from, to) {
  let m = 0; const n = to - from + 1;
  for (let i = from; i <= to; i++) m += a[i];
  m /= n; let s = 0;
  for (let i = from; i <= to; i++) { const d = a[i] - m; s += d * d; }
  return Math.sqrt(s / n);
}
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}
// Limite inferior de Wilson (z=0.84 ≈ 80%; antes 90%) — com poucos testes independentes o de 90% quase nunca passava
function wilsonLower(p, n, z = 0.8416) {
  if (!n) return 0;
  const z2 = z * z, d = 1 + z2 / n;
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / d;
}

function buildModel(closes, H, splitOverride) {
  const n = closes.length, lr = new Float64Array(n);
  for (let i = 1; i < n; i++) lr[i] = Math.log(closes[i] / closes[i - 1]);
  const raw = new Array(n).fill(null);
  for (let i = START; i < n; i++) {
    const v20 = Math.max(stdev(lr, i - 19, i), 1e-6), v5 = stdev(lr, i - 4, i);
    let up = 0, dn = 0;
    for (let k = i - 13; k <= i; k++) { const d = closes[k] - closes[k - 1]; if (d > 0) up += d; else dn -= d; }
    const rsi = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
    let s20 = 0, s50 = 0;
    for (let k = i - 19; k <= i; k++) s20 += closes[k];
    for (let k = i - 49; k <= i; k++) s50 += closes[k];
    s20 /= 20; s50 /= 50;
    const f = new Float64Array(D);
    for (let k = 0; k < 10; k++) f[k] = lr[i - 9 + k] / v20;
    f[10] = (rsi - 50) / 50;
    f[11] = (closes[i] / s20 - 1) / v20;
    f[12] = (closes[i] / s50 - 1) / v20;
    f[13] = v5 / v20;
    f[14] = Math.log(closes[i] / closes[i - 20]) / v20;
    raw[i] = f;
  }
  // padronização só nos primeiros 60% da história (sem vazamento no backtest)
  const split = splitOverride || Math.max(START + 150, Math.floor(n * 0.6));
  const mean = new Float64Array(D), sd = new Float64Array(D), cnt = split - START;
  for (let i = START; i < split; i++) for (let k = 0; k < D; k++) mean[k] += raw[i][k] / cnt;
  for (let i = START; i < split; i++) for (let k = 0; k < D; k++) sd[k] += (raw[i][k] - mean[k]) ** 2;
  for (let k = 0; k < D; k++) sd[k] = Math.sqrt(sd[k] / cnt) || 1;
  const F = new Array(n).fill(null);
  for (let i = START; i < n; i++) {
    const f = new Float64Array(D);
    for (let k = 0; k < D; k++) f[k] = ((raw[i][k] - mean[k]) / sd[k]) * WEIGHTS[k];
    F[i] = f;
  }
  const fwd = new Float64Array(n).fill(NaN), path = new Float32Array(n * H).fill(NaN);
  for (let i = 0; i + H < n; i++) {
    fwd[i] = closes[i + H] / closes[i] - 1;
    for (let d = 1; d <= H; d++) path[i * H + d - 1] = closes[i + d] / closes[i] - 1;
  }
  // desvio-padrão dos retornos de H dias usando só o que já era conhecido até idx
  const P1 = new Float64Array(n + 1), P2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const x = i >= START && Number.isFinite(fwd[i]) ? fwd[i] : 0;
    P1[i + 1] = P1[i] + x; P2[i + 1] = P2[i] + x * x;
  }
  const sigmaAt = idx => {
    const c = idx - START + 1; if (c < 30) return NaN;
    const m1 = (P1[idx + 1] - P1[START]) / c, m2 = (P2[idx + 1] - P2[START]) / c;
    return Math.sqrt(Math.max(0, m2 - m1 * m1));
  };
  // soma acumulada p/ média móvel de qualquer tamanho (filtro de tendência) sem refazer o modelo
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + closes[i];
  const trendAt = (i, L) => i >= L - 1 ? closes[i] / ((cs[i + 1] - cs[i + 1 - L]) / L) - 1 : NaN;
  return { n, H, F, fwd, path, split, sigmaAt, trendAt };
}

function neighbors(m, i, maxIdx) {
  const fi = m.F[i], gap = Math.max(3, Math.floor(m.H / 3));
  const idx = [], dist = [];
  for (let j = START; j <= maxIdx; j++) {
    const fj = m.F[j]; let d = 0;
    for (let k = 0; k < D; k++) { const x = fi[k] - fj[k]; d += x * x; }
    idx.push(j); dist.push(d);
  }
  idx.sort((a, b) => dist[a - START] - dist[b - START]); // ordena índices (mais leve que pares)
  const out = [];
  for (const j of idx) { // evita dias colados (mesmo episódio)
    if (out.every(o => Math.abs(o - j) >= gap)) out.push(j);
    if (out.length >= K) break;
  }
  return out;
}

/* shift = preço atual / último fechamento - 1 (reancora os retornos no preço de agora) */
function stats(m, idxs, shift) {
  const H = m.H, adj = v => (1 + v) / (1 + shift) - 1;
  const f = idxs.map(j => adj(m.fwd[j])).sort((a, b) => a - b);
  const days = [];
  for (let d = 1; d <= H; d++) {
    const v = idxs.map(j => adj(m.path[j * H + d - 1])).sort((a, b) => a - b);
    days.push({ p10: quantile(v, .1), p50: quantile(v, .5), p90: quantile(v, .9) });
  }
  const mins = idxs.map(j => {
    let mn = 0;
    for (let d = 1; d <= Math.min(3, H); d++) mn = Math.min(mn, adj(m.path[j * H + d - 1]));
    return mn;
  }).sort((a, b) => a - b);
  return {
    n: f.length, pUp: f.filter(x => x > 0).length / f.length,
    med: quantile(f, .5), p10: quantile(f, .1), p25: quantile(f, .25), p75: quantile(f, .75), p90: quantile(f, .9),
    days, dip: quantile(mins, .5), pDip: mins.filter(x => x < -0.005).length / mins.length
  };
}

function rawSignal(st, sigma) {
  if (!(st.n >= MIN_N) || !Number.isFinite(sigma)) return "wait";
  const thr = THR * sigma;
  if (st.pUp >= PUP && st.med >= thr) return "buy";
  if (st.pUp <= 1 - PUP && st.med <= -thr) return "avoid";
  return "wait";
}

// filtro de confirmação RSI 78/22 + SMA20 (um só lugar, usado no analyze e no backtest)
function confirm(sig, f, m, i) {
  if (!f) return sig;
  const rsi = 50 + 50 * f[10];
  // compra só a favor da tendência longa (momentum de série temporal: efeito mais documentado na literatura)
  const tr = TREND ? m.trendAt(i, TREND) : NaN;
  if (sig === "buy" && (rsi > 78 || f[11] <= 0 || tr <= 0)) return "wait";
  if (sig === "avoid" && (rsi < 22 || f[11] >= 0)) return "wait";
  return sig;
}

function backtestSignals(m) {
  const out = [], from = Math.max(m.split, START + MIN_POOL + m.H);
  for (let t = from; t + m.H < m.n; t += STEP) {
    const maxIdx = t - m.H; // só casos cujo resultado já era conhecido em t
    if (maxIdx - START < MIN_POOL) continue;
    const st = stats(m, neighbors(m, t, maxIdx), 0);
    const sg = m.sigmaAt(maxIdx);
    out.push({ t, sig: confirm(rawSignal(st, sg), m.F[t], m, t), actual: m.fwd[t], pUp: st.pUp, med: st.med, n: st.n, sg });
  }
  return out;
}
// Reaplica os parâmetros atuais (PUP/THR/TREND) aos registros já calculados — barato, não refaz vizinhos.
function resignal(m, recs) {
  for (const r of recs) r.sig = confirm(rawSignal({ pUp: r.pUp, med: r.med, n: r.n }, r.sg), m.F[r.t], m, r.t);
  return recs;
}

function summarize(recs, H) {
  const all = recs.length * STEP;
  const base = recs.length ? recs.filter(r => r.actual > 0).length / recs.length : NaN;
  const buys = recs.filter(r => r.sig === "buy"), avoids = recs.filter(r => r.sig === "avoid");
  // nEff: buys que não se sobrepõem (gap ~H/3, igual ao dos vizinhos; antes H/2)
  const gap = Math.max(3, Math.floor(H / 3));
  let lastT = -Infinity, nEff = 0;
  for (const r of buys) if (r.t - lastT >= gap) { nEff++; lastT = r.t; }
  return {
    all, base,
    buyN: buys.length * STEP, buyWeeks: Math.round(buys.length * STEP / H),
    buyWin: buys.length ? buys.filter(r => r.actual > 0).length / buys.length : null,
    buyAvg: buys.length ? buys.reduce((a, r) => a + r.actual, 0) / buys.length : null,
    avoidN: avoids.length * STEP,
    avoidRight: avoids.length ? avoids.filter(r => r.actual < 0).length / avoids.length : null,
    nEff
  };
}

// Cache: o modelo só depende dos fechamentos encerrados; a reanálise por minuto só muda o preço atual.
const cache = new Map();
function modelFor(closes, H) {
  const n = closes.length, key = H + "|" + n + "|" + closes[0] + "|" + closes[n >> 1] + "|" + closes[n - 1];
  let e = cache.get(key);
  if (!e) {
    const m = buildModel(closes, H);
    e = { m, bt: summarize(backtestSignals(m), H) };
    cache.set(key, e);
    if (cache.size > 120) cache.delete(cache.keys().next().value);
  }
  return e;
}

// Volatilidade dos últimos 20 dias vs. último ano: regime novo => compra rebaixada.
const VOL_CAP = 2.0;
function volRegime(closes) {
  const n = closes.length;
  if (n < 280) return { ratio: null };
  const lr = [];
  for (let i = n - 250; i < n; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
  const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  const recent = sd(lr.slice(-20)), long = sd(lr);
  return { ratio: long > 0 ? recent / long : null, recent, long };
}

const minHistory = H => START + MIN_POOL + 2 * H + 30;

function analyze(closes, H, price) {
  if (closes.length < minHistory(H)) return null;
  if (closes.length > MAX_HIST) closes = closes.slice(-MAX_HIST);
  const { m, bt: bt0 } = modelFor(closes, H), bt = { ...bt0 };
  const last = m.n - 1, C0 = closes[last], shift = price ? price / C0 - 1 : 0;
  const st = stats(m, neighbors(m, last, last - H), shift);
  const sigma = m.sigmaAt(last - H);
  const sig = confirm(rawSignal(st, sigma), m.F[last], m, last);

  // Confiança: alta = ≥2 testes independentes + Wilson > mercado; média = ≥1 teste e acerto ≥ mercado - 3pp
  let conf = "baixa";
  if (bt.buyWin != null && bt.nEff > 0) {
    bt.buyLower = wilsonLower(bt.buyWin, bt.nEff);
    if (bt.nEff >= 2 && bt.buyLower > bt.base) conf = "alta";
    else if (bt.buyWin >= bt.base - 0.03) conf = "média";
  }

  let rec = sig, cap = null;
  if (sig === "buy" && conf === "baixa") rec = "obs";
  const vr = volRegime(closes);
  if (rec === "buy" && vr.ratio != null && vr.ratio >= VOL_CAP) { rec = "obs"; cap = "volatilidade"; }
  const gapSigma = vr.recent > 0 && shift ? Math.abs(Math.log(1 + shift)) / vr.recent : 0;

  let exitDay = null, best = 0.002;
  st.days.forEach((d, i) => { if (d.p50 > best) { best = d.p50; exitDay = i + 1; } });
  return { st, sig, rec, conf, bt, exitDay, sigma, H, shift, C0, lowData: !(st.n >= MIN_N), cap, volRatio: vr.ratio, gapSigma };
}

module.exports = { analyze, minHistory, volRegime, VOL_CAP, buildModel, backtestSignals, resignal, stats, neighbors, rawSignal, wilsonLower, stdev, quantile, getParams, setParams };
