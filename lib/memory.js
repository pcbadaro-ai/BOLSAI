"use strict";
/*
 * Memória e auto-aprendizado do modelo.
 * - Carrega/salva model-memory.json
 * - A cada ~30s registra previsões de curto prazo
 * - Depois confere o resultado, identifica o erro e ajusta pesos / K / minN
 * - Persiste sozinho
 */
const fs = require("fs");
const path = require("path");
const analysis = require("../analysis");

const FILE = path.join(__dirname, "..", "model-memory.json");
const MAX_PENDING = 400;
const MAX_LOG = 40;
const CHECK_AFTER_MS = 35 * 1000;   // confere a previsão ~35s depois
const SAVE_EVERY = 8;               // grava em disco a cada N ajustes

const DEFAULT = {
  version: "1.3.0",
  learningCount: 0,
  correct: 0,
  wrong: 0,
  weights: [.55,.55,.55,.55,.55,.55,.55,.55,.55,.55, 1.2,1.2,1.2,1.0,1.2],
  K: 30,
  minN: 12,
  lastConfidence: null,
  winRate: null,
  lastUpdate: null,
  lastReason: null,
  recent: [] // últimos ajustes {ts, sym, ok, reason, move}
};

let state = { ...DEFAULT, weights: DEFAULT.weights.slice(), recent: [] };
let pending = []; // { id, sym, price, signal, conf, ts, mkt }
let saves = 0;
let dirty = false;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    state = {
      ...DEFAULT,
      ...raw,
      weights: Array.isArray(raw.weights) && raw.weights.length === 15
        ? raw.weights.map(Number)
        : DEFAULT.weights.slice(),
      recent: Array.isArray(raw.recent) ? raw.recent.slice(-MAX_LOG) : []
    };
    analysis.setParams({
      K: state.K,
      minN: state.minN,
      weights: state.weights
    });
    return { ok: true, learningCount: state.learningCount, winRate: state.winRate };
  } catch (e) {
    analysis.setParams({ K: DEFAULT.K, minN: DEFAULT.minN, weights: DEFAULT.weights.slice() });
    return { ok: false, err: e.message };
  }
}

function snapshot() {
  return {
    version: state.version,
    learningCount: state.learningCount,
    correct: state.correct,
    wrong: state.wrong,
    weights: state.weights.slice(),
    K: state.K,
    minN: state.minN,
    lastConfidence: state.lastConfidence,
    winRate: state.winRate,
    lastUpdate: state.lastUpdate,
    lastReason: state.lastReason,
    recent: state.recent.slice(-10),
    pending: pending.length
  };
}

function save(force = false) {
  if (!dirty && !force) return false;
  state.lastUpdate = new Date().toISOString();
  const total = state.correct + state.wrong;
  state.winRate = total ? state.correct / total : null;
  try {
    fs.writeFileSync(FILE, JSON.stringify({
      version: state.version,
      learningCount: state.learningCount,
      correct: state.correct,
      wrong: state.wrong,
      weights: state.weights,
      K: state.K,
      minN: state.minN,
      lastConfidence: state.lastConfidence,
      winRate: state.winRate,
      lastUpdate: state.lastUpdate,
      lastReason: state.lastReason,
      recent: state.recent.slice(-MAX_LOG)
    }, null, 2));
    dirty = false;
    saves++;
    return true;
  } catch (e) {
    return false;
  }
}

/** Registra uma previsão de curto prazo a partir do sinal atual. */
function recordPrediction(a) {
  if (!a || !a.price || !a.analyses) return;
  const an = a.analyses["1s"] || a.analyses["1m"];
  if (!an || !an.rec) return;
  // evita spam: só uma pendente recente por símbolo
  const recent = pending.filter(p => p.sym === a.sym && Date.now() - p.ts < CHECK_AFTER_MS);
  if (recent.length) return;

  const signal = (a.finals && a.finals["1s"]) || an.rec;
  // buy espera alta; avoid espera queda; wait/obs = neutro (não pontua acerto/erro direcional)
  if (signal !== "buy" && signal !== "avoid") return;

  pending.push({
    id: a.sym + "-" + Date.now(),
    sym: a.sym,
    price: a.price,
    signal,
    conf: an.conf || "baixa",
    med: an.st && an.st.med,
    ts: Date.now(),
    mkt: a.mkt
  });
  if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
}

/**
 * Confere previsões vencidas com o preço atual do ativo.
 * move = (preço_agora / preço_previsto) - 1
 */
function evaluate(getAsset) {
  const now = Date.now();
  const due = pending.filter(p => now - p.ts >= CHECK_AFTER_MS);
  if (!due.length) return [];

  pending = pending.filter(p => now - p.ts < CHECK_AFTER_MS);
  const results = [];

  for (const p of due) {
    const a = getAsset(p.sym);
    if (!a || !a.price || !p.price) continue;
    const move = a.price / p.price - 1;
    // limiar mínimo de ruído (~0.05%): movimentos minúsculos contam como neutros
    const noise = 0.0005;
    let expected = p.signal === "buy" ? 1 : -1;
    let actual = move > noise ? 1 : move < -noise ? -1 : 0;
    let ok = null;
    let reason = null;

    if (actual === 0) {
      reason = "movimento dentro do ruído (" + (move * 100).toFixed(3) + "%) — sem ajuste";
      results.push({ sym: p.sym, ok: null, move, reason });
      continue;
    }

    ok = actual === expected;
    if (ok) {
      state.correct++;
      reason = p.signal === "buy"
        ? "acertou alta (+" + (move * 100).toFixed(3) + "%)"
        : "acertou queda (" + (move * 100).toFixed(3) + "%)";
      // reforço leve nos pesos de momentum (0-9) e tendência (14)
      nudgeWeights(ok, p);
    } else {
      state.wrong++;
      reason = diagnoseError(p, move);
      nudgeWeights(ok, p, move);
    }

    state.learningCount++;
    state.lastConfidence = p.conf;
    state.lastReason = p.sym + ": " + reason;
    state.recent.push({
      ts: new Date().toISOString(),
      sym: p.sym,
      ok,
      signal: p.signal,
      move: Math.round(move * 1e6) / 1e6,
      reason
    });
    if (state.recent.length > MAX_LOG) state.recent = state.recent.slice(-MAX_LOG);

    analysis.setParams({ K: state.K, minN: state.minN, weights: state.weights });
    dirty = true;
    results.push({ sym: p.sym, ok, move, reason });
  }

  if (dirty && (state.learningCount % SAVE_EVERY === 0 || results.some(r => r.ok === false))) {
    save(true);
  }
  return results;
}

function diagnoseError(p, move) {
  const pct = (move * 100).toFixed(3);
  if (p.signal === "buy" && move < 0) {
    return "errou: sinal COMPRAR mas caiu " + pct + "% — reduz momentum, sobe peso de mean-reversion/RSI";
  }
  if (p.signal === "avoid" && move > 0) {
    return "errou: sinal EVITAR mas subiu +" + pct + "% — sobe momentum de curto prazo";
  }
  return "erro inesperado move=" + pct + "% signal=" + p.signal;
}

/**
 * Ajuste pequeno e limitado dos pesos.
 * Índices 0-9: retornos recentes (momentum curto)
 * 10: RSI  11: dist MA20  12: dist MA50  13: vol ratio  14: retorno 20d
 */
function nudgeWeights(ok, p, move) {
  const step = ok ? 0.01 : 0.025;
  const w = state.weights;

  if (ok) {
    // reforça o que "funcionou": momentum se buy, ou cautela se avoid
    if (p.signal === "buy") {
      for (let i = 5; i < 10; i++) w[i] = clamp(w[i] + step * 0.5);
      w[14] = clamp(w[14] + step * 0.4);
    } else {
      w[10] = clamp(w[10] + step * 0.4); // RSI
      w[13] = clamp(w[13] + step * 0.3); // vol
    }
  } else {
    if (p.signal === "buy") {
      // comprou e caiu → menos momentum, mais RSI/mean-rev
      for (let i = 0; i < 10; i++) w[i] = clamp(w[i] - step * 0.6);
      w[10] = clamp(w[10] + step);
      w[11] = clamp(w[11] + step * 0.5);
      w[14] = clamp(w[14] - step * 0.4);
    } else {
      // evitou e subiu → mais momentum curto
      for (let i = 5; i < 10; i++) w[i] = clamp(w[i] + step);
      w[14] = clamp(w[14] + step * 0.5);
      w[10] = clamp(w[10] - step * 0.3);
    }
    // se erra muito, exige mais vizinhos (mais conservador)
    const total = state.correct + state.wrong;
    const wr = total ? state.correct / total : 0.5;
    if (wr < 0.45 && state.wrong > 15) {
      state.K = Math.min(50, state.K + 1);
      state.minN = Math.min(25, state.minN + 1);
    } else if (wr > 0.58 && state.correct > 20) {
      state.K = Math.max(15, state.K - 1);
      state.minN = Math.max(8, state.minN - 1);
    }
  }
  state.weights = w;
}

function clamp(v) {
  return Math.max(0.2, Math.min(2.5, Math.round(v * 1000) / 1000));
}

module.exports = { load, save, snapshot, recordPrediction, evaluate, FILE };
