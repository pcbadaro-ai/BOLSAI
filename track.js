"use strict";
// track.js — acompanhamento real: registra o sinal de cada dia e, passado o horizonte, confere o que aconteceu.
// Uso (1x por dia ou a cada análise): track.update([{ sym:"BTCUSDT", H:7, rec:"buy", price:68000 }, ...]);  track.report()
const fs = require("fs");
const FILE = process.env.TRACK_FILE || "/tmp/bolsai-track.json", DAY = 864e5;
let log = [];
try { log = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

function update(rows, now = Date.now()) {
  for (const r of rows) {
    if (!(r.price > 0)) continue;
    for (const e of log) // fecha os sinais antigos desse ativo/horizonte com o preço de agora
      if (e.out == null && e.sym === r.sym && e.H === r.H && now - e.ts >= r.H * DAY) e.out = r.price / e.price - 1;
    const day = new Date(now).toISOString().slice(0, 10);
    if (!log.some(e => e.sym === r.sym && e.H === r.H && e.day === day)) log.push({ sym: r.sym, H: r.H, rec: r.rec, price: r.price, ts: now, day, out: null });
  }
  log = log.filter(e => now - e.ts < 400 * DAY);
  try { fs.writeFileSync(FILE, JSON.stringify(log)); } catch {}
}
// Acerto real dos sinais já fechados, comparado com todos os dias (o "mercado").
function report() {
  const done = log.filter(e => e.out != null), st = a => ({
    n: a.length, acerto: a.length ? a.filter(e => e.out > 0).length / a.length : null,
    media: a.length ? a.reduce((t, e) => t + e.out, 0) / a.length : null,
  });
  return { abertos: log.length - done.length, mercado: st(done), compra: st(done.filter(e => e.rec === "buy")), observar: st(done.filter(e => e.rec === "obs")) };
}
module.exports = { update, report };
