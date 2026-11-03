"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("../analysis");

function walk(n, seed, vol = 0.015, drift = 0) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const c = [100]; for (let i = 1; i < n; i++) c.push(c[i - 1] * Math.exp(drift + vol * g())); return c;
}

test("SEM OLHAR O FUTURO: sinais até o dia T não mudam se os preços depois de T mudarem", () => {
  const H = 5, T = 650, split = 300;
  const a = walk(900, 11), b = a.slice(0, T + 1).concat(walk(900 - T - 1, 99, 0.05).map(x => x * a[T] / 100));
  const sa = A.backtestSignals(A.buildModel(a, H, split)).filter(r => r.t + H <= T);
  const sb = A.backtestSignals(A.buildModel(b, H, split)).filter(r => r.t + H <= T);
  assert.ok(sa.length > 100);
  assert.deepEqual(sa.map(r => [r.t, r.sig]), sb.map(r => [r.t, r.sig]));
});

test("ruído puro: acerto perto de 50% e quase nunca confiança alta", () => {
  let alta = 0, wins = [];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = A.analyze(walk(1500, seed), 5, null);
    assert.ok(r && r.st.n >= 12);
    if (r.conf === "alta") alta++;
    if (r.bt.buyWin != null) wins.push(r.bt.buyWin - r.bt.base);
  }
  assert.ok(alta <= 1, "confiança alta em " + alta + " de 8 passeios aleatórios");
  const avg = wins.reduce((x, y) => x + y, 0) / (wins.length || 1);
  assert.ok(Math.abs(avg) < 0.1, "vantagem média em ruído = " + avg);
});

test("histórico curto: sem análise em vez de chute", () => {
  assert.equal(A.analyze(walk(200, 3), 5, null), null);
  assert.equal(A.analyze(walk(400, 3), 105, null), null);
});

test("regime de volatilidade: choque recente rebaixa 'Comprar' e é informado", () => {
  const calm = walk(420, 5, 0.008), shock = walk(21, 6, 0.04).slice(1);
  const c = calm.concat(shock.map((x, i) => calm.at(-1) * x / 100));
  const v = A.volRegime(c);
  assert.ok(v.ratio >= A.VOL_CAP, "ratio=" + v.ratio);
  const r = A.analyze(c, 5, null);
  assert.ok(r.volRatio >= A.VOL_CAP); assert.notEqual(r.rec, "buy");
  assert.equal(A.volRegime(walk(100, 1)).ratio, null);
});

test("reancoragem no preço atual e Wilson", () => {
  const c = walk(900, 21), base = A.analyze(c, 5, null), up = A.analyze(c, 5, c.at(-1) * 1.05);
  assert.ok(Math.abs(up.shift - 0.05) < 1e-9);
  assert.ok(up.st.med < base.st.med, "com preço 5% acima, o retorno esperado cai");
  assert.ok(A.wilsonLower(0.6, 100) < 0.6 && A.wilsonLower(0.6, 10) < A.wilsonLower(0.6, 100));
  assert.equal(A.wilsonLower(0.5, 0), 0);
});
