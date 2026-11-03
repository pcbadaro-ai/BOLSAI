"use strict";
process.env.GEMINI_API_KEY = "chave-secreta-teste";
process.env.AI_MODEL = "gemini-modelo-inexistente";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server");
after(() => { S.shutdown(); setTimeout(() => process.exit(0), 50).unref(); });

const DAY = 86400000, NOW = Date.parse("2026-11-03T15:00:00Z"); // terça, 12h em Brasília: B3 aberta
const mkAsset = (over = {}) => ({ kind: "stock", mkt: "BR", ccy: "BRL", sym: "TEST3", name: "Teste", candles: [], news: [], tweets: [], ...over });
const candlesTo = (lastDay, n = 450) => Array.from({ length: n }, (_, i) => ({ t: Date.parse(lastDay) - (n - 1 - i) * DAY, o: 10, h: 11, l: 9, c: 10 + i * 0.001 }));

test("parseAI: tolera cercas de código, limita números e descarta lixo", () => {
  const p = S.parseAI('```json\n{"sentimento": 9, "veredito":"xpto","recomendacao":"buy","recomendacao_1m":"zzz","resumo":"ok","fontes":["n1"," N2 ","lixo"],"cenarios":{"alta":"a"},"riscos":[1,2,3,4]}\n```');
  assert.equal(p.sentimento, 1); assert.equal(p.veredito, "neutro"); assert.equal(p.recomendacao_1m, null);
  assert.deepEqual(p.fontes, ["N1", "N2"]); // "lixo" descartado assert.equal(p.riscos.length, 3); assert.equal(p.cenarios.baixa, "");
  assert.throws(() => S.parseAI("sem json"), /sem JSON/);
});

test("conferência de números: aceita arredondamento e milhar, acusa número inventado", () => {
  const dados = "Preço 38.69 mediana +3.2% chance 61% em 30 casos BTC 76627.23";
  assert.deepEqual(S.numbersNotFound("Subiu 3% com chance de 61%, R$ 38,69 e 76.627", dados), []);
  assert.deepEqual(S.numbersNotFound("A Selic vai a 17%", dados), ["17"]);
});

test("validateAI: IA não pode citar manchete inexistente nem rebaixar sem fonte real", () => {
  const ctx = { news: [{ id: "N1", title: "Titulo real", url: "https://x.com/1", src: "Fonte", when: 1 }], text: "mediana 3.2% 61% N1" };
  const an = { "1s": { rec: "buy" }, "1m": { rec: "buy" }, "5m": { rec: "obs" } };
  const bruto = () => S.parseAI(JSON.stringify({ veredito: "contradiz", recomendacao: "avoid", recomendacao_1m: "wait", recomendacao_5m: "obs", resumo: "queda de 3%", fontes: ["N7"], cenarios: {}, riscos: [] }));
  const v1 = S.validateAI(bruto(), ctx, an);
  assert.equal(v1.recomendacao, null); assert.equal(v1.recomendacao_1m, null);   // rebaixamentos sem fonte: ignorados
  assert.equal(v1.recomendacao_5m, "obs"); assert.equal(v1.verificado, false); assert.equal(v1.fontes.length, 0);
  assert.ok(v1.notas.some(n => /não existem/.test(n)));
  const b2 = bruto(); b2.fontes = ["N1"];
  const v2 = S.validateAI(b2, ctx, an);
  assert.equal(v2.recomendacao, "avoid"); assert.equal(v2.fontes[0].url, "https://x.com/1"); assert.equal(v2.verificado, true);
  const b3 = bruto(); b3.fontes = ["N1"]; b3.resumo = "alta de 41,7% em 2027";
  assert.equal(S.validateAI(b3, ctx, an).verificado, false); // números fora dos dados
});

test("finalRec: a IA só rebaixa, nunca melhora", () => {
  const a = { analyses: { "1s": { rec: "wait" } }, ai: { recomendacao: "buy" } };
  assert.equal(S.finalRec(a), "wait");
  a.ai.recomendacao = "avoid"; assert.equal(S.finalRec(a), "avoid");
  assert.equal(S.finalRec({ analyses: {} }), null);
});

test("completedSeries (B3): nunca usa vela parcial como fechamento", () => {
  const today = "2026-11-03", yest = "2026-11-02";
  const aberto = mkAsset({ candles: candlesTo(today), fetchedAt: NOW });
  assert.equal(S.completedSeries(aberto, NOW).closes.length, 449);              // pregão aberto: exclui hoje
  const t2 = Date.parse("2026-11-03T22:00:00Z");                                 // já fechou
  assert.equal(S.completedSeries(mkAsset({ candles: candlesTo(today), fetchedAt: NOW }), t2).closes.length, 449); // buscado ANTES do fechamento: parcial
  assert.equal(S.completedSeries(mkAsset({ candles: candlesTo(today), fetchedAt: t2 }), t2).closes.length, 450);   // buscado depois: final
  assert.equal(S.completedSeries(mkAsset({ candles: candlesTo(yest), fetchedAt: NOW }), NOW).closes.length, 450);  // último pregão de ontem
  assert.equal(S.completedSeries(mkAsset({ candles: candlesTo(today, 100) }), NOW), null);                          // pouco histórico
});

test("stockDue: busca o fechamento final logo após o pregão", () => {
  const a = mkAsset({ fetchedAt: Date.parse("2026-11-03T20:00:00Z") });
  assert.equal(S.stockDue(a, Date.parse("2026-11-03T20:20:00Z")), false);   // aberto, 20 min
  assert.equal(S.stockDue(a, Date.parse("2026-11-03T20:40:00Z")), true);    // aberto, 40 min
  assert.equal(S.stockDue(a, Date.parse("2026-11-03T21:10:00Z")), true);    // fechou: precisa do fechamento final
  const b = mkAsset({ fetchedAt: Date.parse("2026-11-03T21:10:00Z") });
  assert.equal(S.stockDue(b, Date.parse("2026-11-03T23:00:00Z")), false);   // já tem o final
  assert.equal(S.stockDue(mkAsset({ fetchedAt: 0, lastTry: NOW - 60000 }), NOW), false); // falhou há 1 min: espera
  assert.equal(S.stockDue(mkAsset({}), NOW), true);
});

test("validateFeed: recusa dado velho, preço absurdo e vazio", () => {
  const a = mkAsset(), ok = { candles: [{ t: NOW - DAY, c: 10 }, { t: NOW - DAY, c: 10 }], price: 10.2 };
  assert.ok(S.validateFeed(a, ok, NOW));
  assert.throws(() => S.validateFeed(a, { candles: ok.candles, price: 15 }, NOW), /destoa/);
  assert.throws(() => S.validateFeed(a, { candles: [{ t: NOW - 30 * DAY, c: 10 }, { t: NOW - 30 * DAY, c: 10 }], price: 10 }, NOW), /desatualizados/);
  assert.throws(() => S.validateFeed(a, { candles: [], price: 1 }, NOW), /sem candles/);
});

test("debounce: cripto exige 3 leituras iguais, ações 2", () => {
  const a = {}; S.debounce(a, "wait", "1s", 3);
  assert.equal(S.debounce(a, "buy", "1s", 3), null); assert.equal(S.debounce(a, "buy", "1s", 3), null);
  assert.equal(S.debounce(a, "buy", "1s", 3), "wait");
  const b = {}; S.debounce(b, "wait", "1s", 2);
  assert.equal(S.debounce(b, "avoid", "1s", 2), null); assert.equal(S.debounce(b, "avoid", "1s", 2), "wait");
});

test("IA de ponta a ponta (com Gemini simulado): troca de modelo, chave só no cabeçalho, sem temperature, validação", async () => {
  S.mockData();
  const a = S.assets.get("PETR4"); await S.refreshAnalysis(a);
  const { text, ctx } = S.aiPrompt(a);
  assert.match(text, /N1 \[\d{4}-\d{2}-\d{2} \| MOCK\]/); assert.match(text, /R\$/); assert.match(text, /Modelo estatístico por horizonte/);
  const calls = [];
  global.fetch = async (url, opt) => {
    calls.push({ url: String(url), headers: opt.headers, body: JSON.parse(opt.body) });
    if (/inexistente/.test(String(url))) return { ok: false, status: 404, json: async () => ({ error: { message: "models/x is not found" } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ thought: true, text: "pensando" }, { text: JSON.stringify({ sentimento: 0.2, veredito: "neutro", recomendacao: "avoid", recomendacao_1m: "wait", recomendacao_5m: "wait", resumo: "Sem fatos novos.", fontes: ["N1", "N9"], cenarios: { alta: "a", base: "b", baixa: "c" }, riscos: ["r"], x: "sem dados do X" }) }] } }] }) };
  };
  S.queueAI(a, true);
  for (let i = 0; i < 100 && !a.ai; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(a.ai, "a IA deveria ter respondido");
  assert.ok(calls.length >= 2 && /inexistente/.test(calls[0].url) && !/inexistente/.test(calls.at(-1).url));
  assert.ok(calls.every(c => !c.url.includes("chave-secreta-teste")) && calls.at(-1).headers["x-goog-api-key"] === "chave-secreta-teste");
  assert.ok(!("temperature" in calls.at(-1).body.generationConfig));
  assert.deepEqual(a.ai.fontes.map(f => f.id), ["N1"]);                  // N9 não existe: descartada
  assert.equal(a.ai.verificado, false); assert.ok(a.ai.notas.length);
  assert.ok(!a.ai.resumo.includes("pensando"));                          // partes de "pensamento" ignoradas
  const v = S.view(a); assert.equal(v.ccy, "BRL"); assert.equal(v.mkt, "BR"); assert.ok(v.finals["1s"]);
  assert.ok(ctx.news.length === 1);
});

// ---- caminho real (sem MOCK) com respostas externas simuladas ----
const yahooJSON = (n, price, lastDayMs) => ({ chart: { result: [{ meta: { gmtoffset: -10800, regularMarketPrice: price, currency: "BRL" },
  timestamp: Array.from({ length: n }, (_, i) => Math.floor((lastDayMs - (n - 1 - i) * DAY) / 1000) + 46800),
  indicators: { quote: [{ open: Array(n).fill(10), high: Array(n).fill(11), low: Array(n).fill(9), close: Array.from({ length: n }, (_, i) => 10 + i * 0.001) }] } }] } });

test("B3: se o código novo (AXIA3) tem pouco histórico, usa o antigo (ELET3); e valida o preço", async () => {
  const a = mkAsset({ sym: "AXIA3", ysyms: ["AXIA3.SA", "ELET3.SA"] });
  const last = Date.now() - DAY;
  global.fetch = async url => {
    const u = String(url), n = /AXIA3/.test(u) ? 120 : 1200;
    return { ok: true, status: 200, json: async () => yahooJSON(n, 10 + (n - 1) * 0.001, last) };
  };
  const r = await S.fetchFromProviders(a);
  assert.ok(r.candles.length >= 1000, "deveria ter usado ELET3 (" + r.candles.length + ")"); assert.equal(r.src, "Yahoo Finance");
  await S.loadStock(a); assert.ok(a.fetchedAt > 0 && a.price > 0 && a.open24 > 0);
  // todos os provedores falham -> erro claro, nada é gravado
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(S.fetchFromProviders(mkAsset({ ysyms: ["X.SA"] })), /429|Yahoo/);
});

test("notícias: só manchetes reais, recentes e relevantes, numeradas e com link", async () => {
  const d = h => new Date(Date.now() - h * 3600000).toUTCString();
  const xml = `<rss><channel>
    <item><title>Petrobras anuncia dividendos extraordinários - InfoMoney</title><link>https://im.com/1</link><pubDate>${d(5)}</pubDate><source url="x">InfoMoney</source></item>
    <item><title>Receita de bolo de cenoura - Receitas</title><link>https://r.com/2</link><pubDate>${d(5)}</pubDate><source url="x">Receitas</source></item>
    <item><title>PETR4 sobe com petróleo - Valor</title><link>https://v.com/3</link><pubDate>${d(30)}</pubDate><source url="x">Valor</source></item>
    <item><title>Petrobras: notícia antiga - Folha</title><link>https://f.com/4</link><pubDate>${d(24 * 20)}</pubDate><source url="x">Folha</source></item></channel></rss>`;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => xml, json: async () => ({}) });
  const a = mkAsset({ sym: "PETR4", name: "Petrobras", terms: ["Petrobras", "PETR4"] });
  await S.fetchNews(a);
  assert.deepEqual(a.news.map(n => n.id), ["N1", "N2"]);
  assert.ok(a.news.every(n => /^https:\/\//.test(n.url) && n.when > 0));
  assert.ok(a.news[0].when > a.news[1].when);   // mais nova primeiro
  global.fetch = async () => { throw new Error("rede fora"); };
  await assert.rejects(S.fetchNews(a), /rede fora/);
  assert.equal(a.news.length, 2);                // falha não apaga as manchetes anteriores
});
