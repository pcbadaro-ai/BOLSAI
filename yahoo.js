"use strict";
/*
 * Cotações da B3 via Yahoo Finance (endpoint de gráfico, sem chave). É uma fonte não oficial:
 * se falhar, o servidor tenta Twelve Data (plano com B3) e brapi (com token), nessa ordem.
 * Os candles saem AJUSTADOS por dividendos e desdobramentos (retorno total), com a última vela igual
 * ao preço real. Para quem compra e recebe proventos, é o retorno que importa.
 */
const YH = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (compatible; SinalSemanal/1.1)";

function parseYahooChart(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !Array.isArray(r.timestamp) || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) {
    const msg = j && j.chart && j.chart.error && j.chart.error.description;
    throw new Error(msg || "resposta do Yahoo sem dados");
  }
  const q = r.indicators.quote[0];
  const adj = r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
  const off = Number.isFinite(r.meta && r.meta.gmtoffset) ? r.meta.gmtoffset : -10800;
  const candles = [];
  let lastT = -Infinity;
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (![o, h, l, c].every(x => Number.isFinite(x) && x > 0)) continue; // pregão sem dados
    const f = adj && Number.isFinite(adj[i]) && adj[i] > 0 ? adj[i] / c : 1;
    // Data do pregão no fuso da bolsa, gravada como meia-noite UTC (mesmo formato dos outros ativos).
    const t = Date.parse(new Date((r.timestamp[i] + off) * 1000).toISOString().slice(0, 10));
    if (t <= lastT) { // dia repetido (acontece com a vela parcial do dia): a última leitura vence
      if (t === lastT) candles.pop(); else continue;
    }
    candles.push({ t, o: o * f, h: h * f, l: l * f, c: c * f });
    lastT = t;
  }
  if (candles.length < 2) throw new Error("histórico curto demais");
  const m = r.meta || {};
  let price = Number.isFinite(m.regularMarketPrice) && m.regularMarketPrice > 0 ? m.regularMarketPrice : candles.at(-1).c;
  // A vela de hoje (fator 1, pois é a mais recente) deve refletir o preço atual.
  const prevClose = candles.at(-2).c;
  return { candles, price, prevClose, currency: m.currency || null, tz: m.exchangeTimezoneName || null };
}

async function fetchYahoo(fetchT, ticker, range = "6y", interval = "1d") {
  let err;
  for (const base of YH) {
    try {
      const url = `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includeAdjustedClose=true&events=div%2Csplit`;
      const r = await fetchT(url, { headers: { "user-agent": UA, accept: "application/json" } }, 20000);
      if (!r.ok) throw new Error("Yahoo HTTP " + r.status);
      return parseYahooChart(await r.json());
    } catch (e) { err = e; }
  }
  throw err;
}

/* ---------- Alternativas ---------- */
function parseBrapi(j) {
  const r = j && j.results && j.results[0];
  const h = r && r.historicalDataPrice;
  if (!Array.isArray(h) || h.length < 2) throw new Error((j && j.message) || "brapi sem histórico");
  const candles = [];
  let lastT = -Infinity;
  for (const x of h) {
    if (![x.open, x.high, x.low, x.close].every(v => Number.isFinite(v) && v > 0)) continue;
    const t = Date.parse(new Date((x.date - 3 * 3600) * 1000).toISOString().slice(0, 10));
    if (t <= lastT) continue;
    const f = Number.isFinite(x.adjustedClose) && x.adjustedClose > 0 ? x.adjustedClose / x.close : 1;
    candles.push({ t, o: x.open * f, h: x.high * f, l: x.low * f, c: x.close * f });
    lastT = t;
  }
  if (candles.length < 2) throw new Error("brapi: histórico curto demais");
  const price = Number.isFinite(r.regularMarketPrice) && r.regularMarketPrice > 0 ? r.regularMarketPrice : candles.at(-1).c;
  return { candles, price, prevClose: candles.at(-2).c, currency: "BRL", tz: "America/Sao_Paulo" };
}
async function fetchBrapi(fetchT, ticker, token) {
  if (!token) throw new Error("sem BRAPI_TOKEN");
  const r = await fetchT(`https://brapi.dev/api/quote/${encodeURIComponent(ticker)}?range=5y&interval=1d`, { headers: { authorization: "Bearer " + token } }, 25000);
  if (!r.ok) throw new Error("brapi HTTP " + r.status);
  return parseBrapi(await r.json());
}

function parseTwelve(j) {
  if (!j || j.status === "error" || !Array.isArray(j.values)) throw new Error((j && j.message) || "sem dados");
  const candles = j.values.slice().reverse()
    .map(x => ({ t: Date.parse(String(x.datetime).slice(0, 10)), o: +x.open, h: +x.high, l: +x.low, c: +x.close }))
    .filter(c => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) && c.c > 0);
  if (candles.length < 2) throw new Error("histórico curto demais");
  return { candles, price: candles.at(-1).c, prevClose: candles.at(-2).c, currency: null, tz: null };
}

module.exports = { parseYahooChart, fetchYahoo, parseBrapi, fetchBrapi, parseTwelve };
