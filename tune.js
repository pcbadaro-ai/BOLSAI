"use strict";
// Uso: node tune.js   (precisa de internet, Node 18+)
// Baixa preços reais, testa variações dos parâmetros, ESCOLHE pela 1ª metade do backtest e CONFERE na 2ª (dados que a escolha não viu).
const A = require("./analysis");
const CRYPTO = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA"].map(s => s + "USDT");
const STOCKS = ["PETR4", "VALE3", "ITUB4", "BBDC4", "WEGE3", "ABEV3"].map(s => s + ".SA");
const J = u => fetch(u).then(r => r.json());
async function binance(sym) { // 2 páginas de 1000 dias; descarta o candle de hoje (aberto)
  const u = e => `https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1d&limit=1000` + (e ? `&endTime=${e}` : "");
  const a = await J(u()), b = await J(u(a[0][0] - 1));
  return b.concat(a).slice(0, -1).map(k => +k[4]);
}
async function yahoo(sym) {
  const r = (await J(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=6y&interval=1d`)).chart.result[0];
  return r.indicators.quote[0].close.filter(Number.isFinite).slice(0, -1);
}
const GRID = [];
for (const pUp of [.55, .58, .62]) for (const trend of [0, 100, 200]) for (const thr of [.15, .25, .4]) GRID.push({ pUp, trend, thr });

function evalCfg(sets, cfg, part) { // part 0 = 1ª metade (escolha), 1 = 2ª metade (conferência)
  A.setParams(cfg);
  let n = 0, up = 0, b = 0, w = 0, ret = 0;
  for (const { m, recs } of sets) {
    A.resignal(m, recs);
    const h = recs.length >> 1;
    for (const x of part ? recs.slice(h) : recs.slice(0, h)) {
      n++; if (x.actual > 0) up++;
      if (x.sig === "buy") { b++; ret += x.actual; if (x.actual > 0) w++; }
    }
  }
  return { buys: b, win: b ? w / b : 0, base: n ? up / n : 0, avg: b ? ret / b : 0 };
}
const pc = x => (100 * x).toFixed(1) + "%";
const show = (l, cfg, s) => console.log(l.padEnd(9), JSON.stringify(cfg).padEnd(34), `compras ${s.buys}`.padEnd(13), `acerto ${pc(s.win)}`.padEnd(15), `mercado ${pc(s.base)}`.padEnd(16), `média ${pc(s.avg)}`);

async function run(name, syms, get, H) {
  console.log(`\n=== ${name} (horizonte ${H} dias) ===`);
  const sets = [];
  for (const s of syms) {
    try {
      const c = (await get(s)).slice(-1500);
      if (c.length < A.minHistory(H)) continue;
      A.setParams({ trend: 200 });
      const m = A.buildModel(c, H);
      sets.push({ m, recs: A.backtestSignals(m) });
    } catch (e) { console.log("sem dados:", s, e.message); }
  }
  if (!sets.length) return;
  let best = null;
  for (const cfg of GRID) {
    const s = evalCfg(sets, cfg, 0), score = s.buys >= 30 ? s.win - s.base : -1;
    if (!best || score > best.score) best = { cfg, score };
  }
  const antes = { pUp: .58, trend: 0, thr: .25 };
  show("antes", antes, evalCfg(sets, antes, 1));
  const t = evalCfg(sets, best.cfg, 1);
  show("escolhido", best.cfg, t);
  console.log(t.buys >= 30 && t.win > t.base ? "→ melhorou na conferência. Aplique com setParams(" + JSON.stringify(best.cfg) + ")" : "→ NÃO se sustentou fora da amostra: não mude.");
}
(async () => { await run("CRIPTO", CRYPTO, binance, 7); await run("AÇÕES BR", STOCKS, yahoo, 5); })()
  .catch(e => console.error("Falha ao baixar dados:", e.message));
