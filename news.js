"use strict";
// news.js — cruza manchetes de G1, UOL e NYT, acompanha ativos e pessoas por 7 dias e sinaliza movimentos suspeitos.
// Uso: const news = require("./news"); news.start();  →  news.forAsset("BTCUSDT", variação3dias)  /  news.pessoas()
const fs = require("fs");
const FEEDS = [ // [fonte, url] — se um feed sair do ar, só ele é ignorado
  ["g1", "https://g1.globo.com/rss/g1/economia/"],
  ["g1", "https://g1.globo.com/rss/g1/mundo/"],
  ["uol", "https://rss.uol.com.br/feed/economia.xml"],
  ["nyt", "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"],
  ["nyt", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"],
];
const FILE = process.env.NEWS_FILE || "/tmp/bolsai-news.json";
const KEY = process.env.GEMINI_API_KEY, MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const DAY = 864e5, KEEP = 7 * DAY;
const ALIASES = { // como cada ativo aparece nas manchetes (adicione os seus)
  BTC: /bitcoin|\bbtc\b/i, ETH: /ethereum|\bether\b/i, SOL: /solana/i, BNB: /binance/i, XRP: /ripple|\bxrp\b/i, ADA: /cardano/i, DOGE: /dogecoin/i,
  PETR4: /petrobras|petr4/i, VALE3: /\bVale\b(?! a pena)|\bVALE3\b/, ITUB4: /ita[úu]/i, BBDC4: /bradesco/i, BBAS3: /banco do brasil/i,
  ABEV3: /ambev/i, WEGE3: /\bWEG\b/, MGLU3: /magazine luiza|magalu/i, JBSS3: /\bJBS\b/, SUZB3: /suzano/i, RENT3: /localiza/i, LREN3: /renner/i,
};
const NEG = /queda|cai[ur]?\b|despenc|desaba|preju[ií]zo|fraude|investiga|rebaix|crise|calote|fal[êe]ncia|multa|den[úu]ncia|plunge|fall|slump|probe|fraud|lawsuit|crash|\bban\b|hack/gi;
const POS = /alta\b|sobe\b|dispara|recorde|lucro|aprova|surge|rally|gain|record|approve|soar/gi;
let items = {}; // link -> { src, title, ts, ativos, pessoas, tom }
try { items = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : ""; };
async function pull([src, url]) {
  const xml = await (await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0" } })).text();
  return (xml.match(/<item[\s\S]*?<\/item>/g) || []).slice(0, 40).map(i => ({
    src, title: tag(i, "title"), text: tag(i, "description").slice(0, 300), link: tag(i, "link"), ts: Date.parse(tag(i, "pubDate")) || Date.now(),
  }));
}
// Gemini (opcional): extrai pessoas e o tom de cada manchete nova numa chamada só. Sem chave, cai no léxico simples (sem pessoas).
async function ai(list) {
  if (!KEY || !list.length) return null;
  const prompt = 'Para cada manchete numerada responda SOMENTE JSON: [{"i":n,"pessoas":[nomes de pessoas citadas],"tom":número de -1 (péssimo para o preço dos ativos/empresas citados) a 1 (ótimo)}]. Manchetes:\n'
    + list.map((x, i) => `${i}. ${x.title} — ${x.text.slice(0, 150)}`).join("\n");
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
      signal: AbortSignal.timeout(20000),
    });
    const a = JSON.parse((await r.json()).candidates[0].content.parts[0].text);
    return Array.isArray(a) ? a : null;
  } catch { return null; }
}
const clamp = v => Math.max(-1, Math.min(1, v));
async function refresh() {
  const got = (await Promise.all(FEEDS.map(f => pull(f).catch(() => [])))).flat();
  const fresh = got.filter(x => x.link && x.title && !items[x.link]).slice(0, 60);
  const res = await ai(fresh);
  fresh.forEach((x, i) => {
    const a = res && res.find(y => y && y.i === i), txt = x.title + " " + x.text;
    const tomLex = ((txt.match(POS) || []).length - (txt.match(NEG) || []).length) / 2;
    items[x.link] = {
      src: x.src, title: x.title, ts: x.ts, ativos: Object.keys(ALIASES).filter(k => ALIASES[k].test(txt)),
      pessoas: a && Array.isArray(a.pessoas) ? a.pessoas.slice(0, 5).map(String) : [],
      tom: clamp(a && Number.isFinite(a.tom) ? a.tom : tomLex),
    };
  });
  for (const k in items) if (items[k].ts < Date.now() - KEEP) delete items[k];
  try { fs.writeFileSync(FILE, JSON.stringify(items)); } catch {}
  return fresh.length;
}

/* Resumo de um ativo. chg3d = variação do preço nos últimos 3 dias (ex.: -0.08). Os alertas são heurísticas, não prova de manipulação. */
function forAsset(sym, chg3d) {
  const s = sym.toUpperCase().replace(/(USDT|BUSD|USDC)$/, "").replace(/\.SA$/, "");
  const re = ALIASES[s] || new RegExp("\\b" + s + "\\b", "i"), now = Date.now();
  const L = Object.values(items).filter(x => x.ativos.includes(s) || re.test(x.title));
  const rec = L.filter(x => x.ts > now - 3 * DAY), old = L.filter(x => x.ts <= now - 3 * DAY);
  const avg = a => a.length ? a.reduce((t, x) => t + x.tom, 0) / a.length : null;
  const fontes = [...new Set(rec.map(x => x.src))], tom = avg(rec), tomAntes = avg(old), flags = [];
  if (chg3d <= -0.05) {
    if (!rec.length) flags.push("queda sem notícia");
    else if (tom < -0.3) flags.push(fontes.length > 1 ? "queda com notícia negativa em várias fontes" : "queda com notícia negativa de uma fonte só");
  }
  if (chg3d >= 0.05 && !rec.length) flags.push("alta sem notícia");
  if (tomAntes != null && tomAntes < -0.3 && tom != null && tom > 0.1) flags.push("tom virou de negativo para positivo");
  const p = {};
  L.forEach(x => x.pessoas.forEach(n => p[n] = (p[n] || 0) + 1));
  return {
    n: rec.length, fontes, cruzado: fontes.length > 1, tom, flags,
    pessoas: Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]),
    manchetes: rec.sort((a, b) => b.ts - a.ts).slice(0, 3).map(x => x.src + ": " + x.title),
  };
}
// Pessoas citadas pelo menos `min` vezes nos últimos 7 dias, com fontes e tom médio (precisa da chave Gemini).
function pessoas(min = 2) {
  const m = {};
  for (const x of Object.values(items)) for (const n of x.pessoas) {
    const e = m[n] ||= { nome: n, n: 0, fontes: new Set(), tom: 0 };
    e.n++; e.fontes.add(x.src); e.tom += x.tom;
  }
  return Object.values(m).filter(e => e.n >= min).map(e => ({ nome: e.nome, n: e.n, fontes: [...e.fontes], tom: +(e.tom / e.n).toFixed(2) }))
    .sort((a, b) => b.fontes.length - a.fontes.length || b.n - a.n).slice(0, 20);
}
function start(ms = 15 * 60e3) {
  refresh().catch(() => {});
  return setInterval(() => refresh().catch(() => {}), ms).unref();
}
module.exports = { start, refresh, forAsset, pessoas, FEEDS };
