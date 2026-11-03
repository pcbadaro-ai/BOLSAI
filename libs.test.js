"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const news = require("../lib/news"), yahoo = require("../lib/yahoo"), bcb = require("../lib/bcb"), mk = require("../lib/markets");
const { BR } = require("../lib/universe");

const NOW = Date.parse("2026-11-03T12:00:00Z");
const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map(i => `<item><title>${i.t}</title><link>${i.l}</link><pubDate>${i.d}</pubDate>${i.s ? `<source url="x">${i.s}</source>` : ""}</item>`).join("")}</channel></rss>`;

test("universo BR: 20 ações, sem repetição, com códigos Yahoo .SA", () => {
  assert.equal(BR.length, 20);
  assert.equal(new Set(BR.map(b => b.sym)).size, 20);
  for (const b of BR) { assert.ok(b.y.length && b.y.every(y => y.endsWith(".SA"))); assert.ok(b.name); }
});

test("RSS: aceita manchete real, descarta sem data, futura, velha e link perigoso", () => {
  const xml = rss([
    { t: "Petrobras sobe com petróleo - Valor Econômico", l: "https://x.com/a", d: "Mon, 02 Nov 2026 10:00:00 GMT", s: "Valor Econômico" },
    { t: "Sem data", l: "https://x.com/b", d: "" },
    { t: "Do futuro", l: "https://x.com/c", d: "Sat, 14 Nov 2026 10:00:00 GMT" },
    { t: "Velha", l: "https://x.com/d", d: "Mon, 01 Sep 2026 10:00:00 GMT" },
    { t: "Link perigoso", l: "javascript:alert(1)", d: "Mon, 02 Nov 2026 10:00:00 GMT" },
    { t: "Entidades &amp; &lt;b&gt;tag&lt;/b&gt; Vale", l: "https://x.com/e", d: "Mon, 02 Nov 2026 11:00:00 GMT" }
  ]);
  const out = news.parseRSS(xml, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "Petrobras sobe com petróleo"); // sufixo " - fonte" removido
  assert.equal(out[0].src, "Valor Econômico");
  assert.ok(!/[<>]/.test(out[1].title));
});

test("dedupe, relevância e URL segura", () => {
  const d = news.dedupe([{ title: "Vale sobe!", when: 1 }, { title: "vale  sobe", when: 5 }, { title: "Outra", when: 3 }]);
  assert.equal(d.length, 2); assert.equal(d[0].when, 5);
  assert.equal(news.relevant("Valentine day", ["Vale"]), false);
  assert.equal(news.relevant("Vale (VALE3) sobe", ["Vale"]), true);
  assert.equal(news.safeUrl("data:text/html,x"), null);
  assert.ok(news.googleNewsURL(["Rede D'Or", "RDOR3"], "pt").includes("hl=pt-BR"));
});

test("Yahoo: candles ajustados, dia repetido e valores inválidos", () => {
  const ts = [1761915000, 1762001400, 1762087800, 1762087900]; // últimos dois no mesmo dia
  const j = { chart: { result: [{ meta: { gmtoffset: -10800, regularMarketPrice: 40, currency: "BRL" }, timestamp: ts,
    indicators: { quote: [{ open: [10, 10, 10, 10], high: [11, 11, 11, 11], low: [9, 9, 9, null], close: [10, 10, 10, 10.5] }], adjclose: [{ adjclose: [9, 9.5, 10, 10.5] }] } }] } };
  const r = yahoo.parseYahooChart(j);
  assert.equal(r.candles.length, 3);                // a vela com low nulo é descartada
  assert.ok(Math.abs(r.candles[0].c - 9) < 1e-9);    // ajustada por proventos
  assert.equal(r.price, 40);
  assert.throws(() => yahoo.parseYahooChart({ chart: { result: null, error: { description: "Not Found" } } }), /Not Found/);
});

test("brapi e Twelve Data", () => {
  const b = yahoo.parseBrapi({ results: [{ regularMarketPrice: 50, historicalDataPrice: [
    { date: 1761915000, open: 1, high: 2, low: 1, close: 2, adjustedClose: 1.8 }, { date: 1762001400, open: 2, high: 3, low: 2, close: 3, adjustedClose: 3 }] }] });
  assert.equal(b.candles.length, 2); assert.equal(b.price, 50);
  const t = yahoo.parseTwelve({ values: [{ datetime: "2026-11-02", open: "2", high: "3", low: "1", close: "2.5" }, { datetime: "2026-11-01", open: "1", high: "2", low: "1", close: "1.5" }] });
  assert.equal(t.candles[0].c, 1.5); assert.equal(t.price, 2.5);
  assert.throws(() => yahoo.parseTwelve({ status: "error", message: "limite" }), /limite/);
});

test("Banco Central: datas e vírgula decimal", async () => {
  const rows = bcb.parseSGS([{ data: "02/11/2026", valor: "13,75" }, { data: "01/11/2026", valor: "13.5" }, { data: "x", valor: "1" }]);
  assert.deepEqual(rows.map(r => r.d), ["2026-11-01", "2026-11-02"]); assert.equal(rows[1].v, 13.75);
  const fake = async url => ({ json: async () => url.includes("sgs.432") ? [{ data: "02/11/2026", valor: "13.75" }] : url.includes("sgs.1/") ? [{ data: "30/10/2026", valor: "5.00" }, { data: "02/11/2026", valor: "5.44" }] : [{ data: "01/10/2026", valor: "0.5" }] });
  const m = await bcb.fetchMacro(fake);
  assert.equal(m.selic, 13.75); assert.equal(m.usdbrl, 5.44); assert.ok(Math.abs(m.usdbrl5d - 0.088) < 1e-9);
});

test("horários de mercado: B3 e EUA", () => {
  const at = s => new Date(s);
  assert.equal(mk.marketOpenNow("BR", at("2026-11-03T14:00:00Z")), true);   // terça 11h Brasília
  assert.equal(mk.marketOpenNow("BR", at("2026-11-03T22:00:00Z")), false);  // depois do fechamento
  assert.equal(mk.marketOpenNow("BR", at("2026-11-07T14:00:00Z")), false);  // sábado
  assert.equal(mk.exchangeDate("BR", at("2026-11-03T02:00:00Z")), "2026-11-02"); // 23h do dia anterior em Brasília
  assert.equal(mk.closeInstant("2026-11-03", "BR"), Date.parse("2026-11-03T21:05:00Z"));
});
