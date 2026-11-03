"use strict";
/*
 * Memória e autoaprendizado do modelo (versão por estudo histórico).
 *
 * ANTES: registrava previsão e conferia o preço ~35s depois (curto demais
 *        para os horizontes 1 semana / 1 mês / 5 meses).
 *
 * AGORA:
 * - Usa só dados de bolsa já fechados (candles históricos).
 * - Em cada ativo, roda backtest walk-forward nos 3 horizontes (1s, 1m, 5m).
 * - Conta acerto/erro de sinais buy e avoid com o retorno real futuro.
 * - Ajusta pesos / K / minN com base nesse estudo.
 * - Libera estruturas temporárias ao terminar (não guarda fila pending).
 */
const fs = require("fs");
const path = require("path");
const analysis = require("../analysis");

const FILE = path.join(__dirname, "..", "model-memory.json");
const MAX_LOG = 40;
const SAVE_EVERY = 3;
const STUDY_COOLDOWN_MS = 6 * 3600 * 1000; // não restuda o mesmo ativo em menos de 6h
const MAX_STUDY_PER_CYCLE = 4;             // quantos ativos estudar por ciclo (evita travar o event loop)

// Horizontes iguais aos do servidor (pregões para ações; dias para cripto)
const HZN_STOCK = { "1s": 5, "1m": 21, "5m": 105 };
const HZN_CRYPTO = { "1s": 7, "1m": 30, "5m": 150 };

const DEFAULT = {
  version: "2.0.0-hist",
  learningCount: 0,
  correct: 0,
  wrong: 0,
  weights: [.55, .55, .55, .55, .55, .55, .55, .55, .55, .55, 1.2, 1.2, 1.2, 1.0, 1.2],
  K: 30,
  minN: 12,
  lastConfidence: null,
  winRate: null,
  lastUpdate: null,
  lastReason: null,
  recent: [],
  byHorizon: {
    "1s": { correct: 0, wrong: 0 },
    "1m": { correct: 0, wrong: 0 },
    "5m": { correct: 0, wrong: 0 }
  },
  lastStudyAt: {} // sym -> timestamp
};

let state = {
  ...DEFAULT,
  weights: DEFAULT.weights.slice(),
  recent: [],
  byHorizon: {
    "1s": { correct: 0, wrong: 0 },
    "1m": { correct: 0, wrong: 0 },
    "5m": { correct: 0, wrong: 0 }
  },
  lastStudyAt: {}
};
let dirty = false;
let saves = 0;

function clamp(v, lo = 0.2, hi = 2.5) {
  return Math.max(lo, Math.min(hi, v));
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    state = {
      ...DEFAULT,
      ...raw,
      weights: Array.isArray(raw.weights) && raw.weights.length === 15
        ? raw.weights.map(Number)
        : DEFAULT.weights.slice(),
      recent: Array.isArray(raw.recent) ? raw.recent.slice(-MAX_LOG) : [],
      byHorizon: {
        "1s": { ...(DEFAULT.byHorizon["1s"]), ...(raw.byHorizon && raw.byHorizon["1s"]) },
        "1m": { ...(DEFAULT.byHorizon["1m"]), ...(raw.byHorizon && raw.byHorizon["1m"]) },
        "5m": { ...(DEFAULT.byHorizon["5m"]), ...(raw.byHorizon && raw.byHorizon["5m"]) }
      },
      lastStudyAt: raw.lastStudyAt && typeof raw.lastStudyAt === "object" ? raw.lastStudyAt : {}
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

function snapshot(full) {
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
    recent: full ? state.recent.slice() : state.recent.slice(-10),
    pending: 0, // não há mais fila de 35s
    byHorizon: {
      "1s": { ...state.byHorizon["1s"] },
      "1m": { ...state.byHorizon["1m"] },
      "5m": { ...state.byHorizon["5m"] }
    }
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
      recent: state.recent.slice(-MAX_LOG),
      byHorizon: state.byHorizon,
      lastStudyAt: state.lastStudyAt
    }));
    dirty = false;
    saves++;
    return true;
  } catch (e) {
    return false;
  }
}

/** Fecha a série: descarta a vela do dia em andamento se ainda não fechou. */
function completedCloses(a) {
  const candles = a.candles || [];
  if (candles.length < 80) return null;
  let closes = candles.map(c => c.c).filter(c => c > 0);
  if (closes.length < 80) return null;
  // se o último candle é "hoje" e o preço atual ainda bate com ele, mantém;
  // o analysis.js já trata horizonte sem usar o futuro — aqui só precisamos de série estável
  return closes;
}

/**
 * Estuda um ativo com backtest histórico nos 3 horizontes.
 * Usa apenas dados passados (walk-forward já implementado em analysis.backtestSignals).
 * Libera objetos temporários ao final.
 */
function studyAsset(a) {
  if (!a || !a.sym) return null;
  const closes = completedCloses(a);
  if (!closes) return null;

  const horizons = a.kind === "crypto" ? HZN_CRYPTO : HZN_STOCK;
  const tallies = { correct: 0, wrong: 0, byHz: { "1s": { c: 0, w: 0 }, "1m": { c: 0, w: 0 }, "5m": { c: 0, w: 0 } } };
  const samples = [];

  for (const [key, H] of Object.entries(horizons)) {
    if (closes.length < analysis.minHistory(H)) continue;
    let m;
    try {
      m = analysis.buildModel(closes, H);
    } catch (e) {
      continue;
    }
    if (!m) continue;

    let recs;
    try {
      recs = analysis.backtestSignals(m);
    } catch (e) {
      m = null;
      continue;
    }

    // Amostra recente do backtest (últimos ~40 sinais direcionais) para o ajuste não ser dominado por história antiga
    const directed = recs.filter(r => r.sig === "buy" || r.sig === "avoid");
    const slice = directed.slice(-40);
    for (const r of slice) {
      if (!Number.isFinite(r.actual)) continue;
      const expectedUp = r.sig === "buy";
      const actualUp = r.actual > 0;
      const actualDn = r.actual < 0;
      // movimento quase zero: ignora (ruído)
      if (Math.abs(r.actual) < 0.001) continue;
      const ok = expectedUp ? actualUp : actualDn;
      if (ok) {
        tallies.correct++;
        tallies.byHz[key].c++;
      } else {
        tallies.wrong++;
        tallies.byHz[key].w++;
      }
      samples.push({ hz: key, sig: r.sig, actual: r.actual, ok });
    }

    // libera modelo grande (F, path, etc.)
    m = null;
    recs = null;
  }

  const total = tallies.correct + tallies.wrong;
  if (total < 8) return null; // pouca evidência neste ativo

  // aplica contagem global e por horizonte
  state.correct += tallies.correct;
  state.wrong += tallies.wrong;
  for (const key of ["1s", "1m", "5m"]) {
    state.byHorizon[key].correct += tallies.byHz[key].c;
    state.byHorizon[key].wrong += tallies.byHz[key].w;
  }
  state.learningCount += 1;

  const wr = total ? tallies.correct / total : 0;
  const reason =
    a.sym +
    ": estudo histórico · acertos " +
    tallies.correct +
    "/" +
    total +
    " (" +
    (wr * 100).toFixed(0) +
    "%) · 1s " +
    tallies.byHz["1s"].c +
    "/" +
    (tallies.byHz["1s"].c + tallies.byHz["1s"].w) +
    " · 1m " +
    tallies.byHz["1m"].c +
    "/" +
    (tallies.byHz["1m"].c + tallies.byHz["1m"].w) +
    " · 5m " +
    tallies.byHz["5m"].c +
    "/" +
    (tallies.byHz["5m"].c + tallies.byHz["5m"].w);

  state.lastReason = reason;
  state.lastConfidence = wr >= 0.58 ? "alta" : wr >= 0.52 ? "média" : "baixa";
  state.recent.push({
    ts: new Date().toISOString(),
    sym: a.sym,
    ok: wr >= 0.5,
    signal: "study",
    move: null,
    reason,
    byHz: tallies.byHz
  });
  if (state.recent.length > MAX_LOG) state.recent = state.recent.slice(-MAX_LOG);

  nudgeFromStudy(samples, wr);
  analysis.setParams({ K: state.K, minN: state.minN, weights: state.weights });
  state.lastStudyAt[a.sym] = Date.now();
  dirty = true;

  // libera amostras
  samples.length = 0;

  return {
    sym: a.sym,
    ok: wr >= 0.5,
    reason,
    correct: tallies.correct,
    wrong: tallies.wrong,
    winRate: wr
  };
}

/**
 * Ajuste dos pesos com base no estudo histórico (amostras buy/avoid × retorno real).
 */
function nudgeFromStudy(samples, winRate) {
  if (!samples.length) return;
  const w = state.weights.slice();
  const step = 0.015;

  let buyOk = 0, buyN = 0, avoidOk = 0, avoidN = 0;
  for (const s of samples) {
    if (s.sig === "buy") {
      buyN++;
      if (s.ok) buyOk++;
    } else if (s.sig === "avoid") {
      avoidN++;
      if (s.ok) avoidOk++;
    }
  }

  const buyWr = buyN ? buyOk / buyN : 0.5;
  const avoidWr = avoidN ? avoidOk / avoidN : 0.5;

  // buy acertando → reforça momentum e tendência 20d
  if (buyN >= 4 && buyWr >= 0.55) {
    for (let i = 5; i < 10; i++) w[i] = clamp(w[i] + step * 0.5);
    w[14] = clamp(w[14] + step * 0.4);
  }
  // buy errando → reduz momentum, sobe RSI / distância das médias
  if (buyN >= 4 && buyWr < 0.48) {
    for (let i = 0; i < 10; i++) w[i] = clamp(w[i] - step * 0.5);
    w[10] = clamp(w[10] + step);
    w[11] = clamp(w[11] + step * 0.4);
    w[14] = clamp(w[14] - step * 0.3);
  }
  // avoid acertando → reforça RSI e vol
  if (avoidN >= 4 && avoidWr >= 0.55) {
    w[10] = clamp(w[10] + step * 0.4);
    w[13] = clamp(w[13] + step * 0.3);
  }
  // avoid errando → mais momentum curto
  if (avoidN >= 4 && avoidWr < 0.48) {
    for (let i = 5; i < 10; i++) w[i] = clamp(w[i] + step * 0.6);
    w[14] = clamp(w[14] + step * 0.4);
    w[10] = clamp(w[10] - step * 0.3);
  }

  // calibra K / minN conforme taxa global do estudo
  const total = state.correct + state.wrong;
  const globalWr = total ? state.correct / total : 0.5;
  if (globalWr < 0.47 && state.wrong > 40) {
    state.K = Math.min(50, state.K + 1);
    state.minN = Math.min(25, state.minN + 1);
  } else if (globalWr > 0.56 && state.correct > 50) {
    state.K = Math.max(15, state.K - 1);
    state.minN = Math.max(8, state.minN - 1);
  }

  state.weights = w;
}

/**
 * Ciclo de estudo: pega até MAX_STUDY_PER_CYCLE ativos "frios" e estuda.
 * Não mantém fila pending — libera tudo ao terminar cada ativo.
 */
function studyCycle(getAsset, assetsMap) {
  const now = Date.now();
  const candidates = [];
  for (const a of assetsMap.values()) {
    if (!a.candles || a.candles.length < 100) continue;
    if (!a.analysis) continue;
    const last = state.lastStudyAt[a.sym] || 0;
    if (now - last < STUDY_COOLDOWN_MS) continue;
    candidates.push(a);
  }
  // prioriza quem tem mais histórico e quem nunca foi estudado
  candidates.sort((x, y) => {
    const lx = state.lastStudyAt[x.sym] || 0;
    const ly = state.lastStudyAt[y.sym] || 0;
    if (lx !== ly) return lx - ly;
    return (y.candles.length || 0) - (x.candles.length || 0);
  });

  const results = [];
  const batch = candidates.slice(0, MAX_STUDY_PER_CYCLE);
  for (const a of batch) {
    try {
      const r = studyAsset(a);
      if (r) results.push(r);
    } catch (e) {
      results.push({ sym: a.sym, ok: null, reason: "erro no estudo: " + e.message });
    }
  }

  if (dirty && (state.learningCount % SAVE_EVERY === 0 || results.some(r => r.ok === false))) {
    save(true);
  }
  return results;
}

/* Compat: APIs antigas viram no-op / redirecionam para o estudo histórico */
function recordPrediction(/* a */) {
  // desativado de propósito — aprendizado não usa mais previsão de 35s
}
function evaluate(/* getAsset */) {
  return []; // desativado
}

module.exports = {
  load,
  save,
  snapshot,
  recordPrediction,
  evaluate,
  studyAsset,
  studyCycle,
  FILE
};
