"use strict";
/*
 * Motor de análise por padrões parecidos.
 * Entrada: fechamentos diários JÁ ENCERRADOS (sem a vela do dia em andamento) e, opcionalmente,
 * o preço atual. Tudo o que o modelo "sabe" em cada data vem só de dados anteriores a ela.
 */
const D = 15, START = 50, K = 30, MIN_POOL = 120;
const WEIGHTS = [.55,.55,.55,.55,.55,.55,.55,.55,.55,.55, 1.2,1.2,1.2,1.0,1.2];

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
// Limite inferior de Wilson (90%) para uma proporção observada p em n tentativas independentes.
function wilsonLower(p, n, z = 1.2816) {
  if (!n) return 0;
  const z2 = z * z, d = 1 + z2 / n;
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / d;
}

function buildModel(closes, H, splitOverride) {
  const n = closes.length;
  const lr = new Float64Array(n);
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
  // A padronização usa só os primeiros 60% da história; o backtest roda depois disso, sem vazamento.
  const split = splitOverride || Math.max(START + 150, Math.floor(n * 0.6));
  const mean = new Float64Array(D), sd = new Float64Array(D);
  const cnt = split - START;
  for (let i = START; i < split; i++) for (let k = 0; k < D; k++) mean[k] += raw[i][k] / cnt;
  for (let i = START; i < split; i++) for (let k = 0; k < D; k++) sd[k] += Math.pow(raw[i][k] - mean[k], 2);
  for (let k = 0; k < D; k++) sd[k] = Math.sqrt(sd[k] / cnt) || 1;
  const F = new Array(n).fill(null);
  for (let i = START; i < n; i++) {
    const f = new Float64Array(D);
    for (let k = 0; k < D; k++) f[k] = ((raw[i][k] - mean[k]) / sd[k]) * WEIGHTS[k];
    F[i] = f;
  }
  const fwd = new Float64Array(n).fill(NaN);
  const path = new Float64Array(n * H).fill(NaN);
  for (let i = 0; i + H < n; i++) {
    fwd[i] = closes[i + H] / closes[i] - 1;
    for (let d = 1; d <= H; d++) path[i * H + d - 1] = closes[i + d] / closes[i] - 1;
  }
  // Desvio-padrão dos retornos de H dias usando SÓ o que já era conhecido até a data idx.
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
  return { n, H, F, fwd, path, split, sigmaAt };
}

function neighbors(m, i, maxIdx) {
  const fi = m.F[i], arr = [];
  for (let j = START; j <= maxIdx; j++) {
    const fj = m.F[j]; let d = 0;
    for (let k = 0; k < D; k++) { const x = fi[k] - fj[k]; d += x * x; }
    arr.push([d, j]);
  }
  arr.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [, j] of arr) { // evita pegar dias colados (mesmo episódio) como se fossem casos distintos
    if (out.every(o => Math.abs(o - j) >= 3)) out.push(j);
    if (out.length >= K) break;
  }
  return out;
}

/* shift = preço atual / último fechamento - 1. Reancora os retornos no preço de agora. */
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
  const thr = 0.25 * sigma;
  if (st.pUp >= 0.58 && st.med >= thr) return "buy";
  if (st.pUp <= 0.42 && st.med <= -thr) return "avoid";
  return "wait";
}

/* Sinais que o modelo teria dado em cada dia t, usando só dados até t. */
function backtestSignals(m) {
  const out = [];
  const from = Math.max(m.split, START + MIN_POOL + m.H);
  for (let t = from; t + m.H < m.n; t++) {
    const maxIdx = t - m.H; // só entram casos cujo resultado já era conhecido em t
    if (maxIdx - START < MIN_POOL) continue;
    const st = stats(m, neighbors(m, t, maxIdx), 0);
    out.push({ t, sig: rawSignal(st, m.sigmaAt(maxIdx)), actual: m.fwd[t] });
  }
  return out;
}

function summarize(recs, H) {
  const all = recs.length;
  const base = all ? recs.filter(r => r.actual > 0).length / all : NaN;
  const buys = recs.filter(r => r.sig === "buy"), avoids = recs.filter(r => r.sig === "avoid");
  const buyWin = buys.length ? buys.filter(r => r.actual > 0).length / buys.length : null;
  return {
    all, base, buyN: buys.length, buyWeeks: Math.round(buys.length / H), buyWin,
    buyAvg: buys.length ? buys.reduce((a, r) => a + r.actual, 0) / buys.length : null,
    avoidN: avoids.length, avoidRight: avoids.length ? avoids.filter(r => r.actual < 0).length / avoids.length : null
  };
}

function analyze(closes, H, price) {
  const m = buildModel(closes, H);
  const last = m.n - 1, C0 = closes[last];
  const shift = price ? price / C0 - 1 : 0;
  const st = stats(m, neighbors(m, last, last - H), shift);
  const sigma = m.sigmaAt(last - H);
  const sig = rawSignal(st, sigma);
  const bt = summarize(backtestSignals(m), H);
  // Os dias de uma mesma semana se sobrepõem; o número de testes independentes é ~ n/H.
  const nEff = bt.buyN / H;
  let conf = "baixa";
  if (bt.buyWin != null) {
    bt.buyLower = wilsonLower(bt.buyWin, Math.max(1, nEff));
    if (nEff >= 10 && bt.buyLower > bt.base) conf = "alta";
    else if (nEff >= 6 && bt.buyWin >= bt.base + 0.08) conf = "média";
  }
  let rec = sig;
  if (sig === "buy" && conf === "baixa") rec = "obs";
  let exitDay = null, best = 0.002;
  st.days.forEach((d, i) => { if (d.p50 > best) { best = d.p50; exitDay = i + 1; } });
  return { st, sig, rec, conf, bt, exitDay, sigma, H, shift, C0 };
}

module.exports = { analyze, buildModel, backtestSignals, stats, neighbors, rawSignal, wilsonLower, stdev, quantile };
