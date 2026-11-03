"use strict";
/*
 * Sinal Semanal — servidor
 * Preços: cripto (Binance), ações EUA e B3 (Yahoo → Twelve Data → brapi).
 * Análise estatística em worker, notícias reais, IA (Gemini/Groq).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const WebSocket = require("ws");

const yahoo = require("./lib/yahoo");
const news = require("./lib/news");
const bcb = require("./lib/bcb");
const mk = require("./lib/markets");
const { analyze, minHistory } = require("./analysis");
const memory = require("./lib/memory");

/* ---------- .env mínimo ---------- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const ENV = process.env;
const PORT = +ENV.PORT || 3000;
const ACCESS = ENV.ACCESS_TOKEN || "";
const GEMINI_KEY = ENV.GEMINI_API_KEY || "";
const GROQ_KEY = ENV.GROQ_API_KEY || "";
const TWELVE = ENV.TWELVEDATA_KEY || "";
const BRAPI = ENV.BRAPI_TOKEN || "";
const AI_EVERY = (+ENV.AI_EVERY_MIN || 30) * 60000;
const AI_CONC = 1;
const MOCK = !!ENV.MOCK;

const HZN = { "1s": 5, "1m": 21, "5m": 105 }; // pregões (ações)
const HZN_C = { "1s": 7, "1m": 30, "5m": 150 }; // dias (cripto)

/* ---------- Universo ---------- */
let universe = {};
try { universe = require("./lib/universe"); } catch (e) { console.log("Aviso universe:", e.message); }
const BR = Array.isArray(universe) ? universe : (universe.BR || universe.acoesBR || universe.BRA || []);
const termsFor = typeof universe.termsFor === "function" ? universe.termsFor : ((n, s) => [n, s].filter(Boolean));

const CRYPTO = [
  ["BTC", "Bitcoin"], ["ETH", "Ethereum"], ["BNB", "BNB"], ["XRP", "XRP"],
  ["SOL", "Solana"], ["TRX", "TRON"], ["DOGE", "Dogecoin"], ["ADA", "Cardano"],
  ["LINK", "Chainlink"], ["AVAX", "Avalanche"]
];
const STOCKS = [
  ["AAPL", "Apple"], ["NVDA", "NVIDIA"], ["MSFT", "Microsoft"], ["GOOGL", "Alphabet"],
  ["AMZN", "Amazon"], ["TSM", "TSMC"], ["TSLA", "Tesla"], ["META", "Meta Platforms"],
  ["AVGO", "Broadcom"], ["LLY", "Eli Lilly"], ["BRK-B", "Berkshire Hathaway"], ["MU", "Micron"],
  ["WMT", "Walmart"], ["JPM", "JPMorgan"], ["AMD", "AMD"], ["V", "Visa"],
  ["XOM", "ExxonMobil"], ["JNJ", "Johnson & Johnson"], ["ASML", "ASML"], ["MA", "Mastercard"]
];

const assets = new Map();
for (const [s, n] of CRYPTO) {
  assets.set(s, { kind: "crypto", mkt: "CRYPTO", ccy: "USD", sym: s, name: n, pair: s + "USDT", H: 7, ysyms: [s + "-USD"], terms: [s, n] });
}
for (const [s, n] of STOCKS) {
  assets.set(s, { kind: "stock", mkt: "US", ccy: "USD", sym: s, name: n, H: 5, ysyms: [s], terms: [s, n] });
}
for (const b of BR) {
  if (b && b.sym) {
    assets.set(b.sym, {
      kind: "stock", mkt: "BR", ccy: "BRL", sym: b.sym, name: b.name || b.sym,
      H: 5, ysyms: b.y || [b.sym + ".SA"], terms: b.terms || termsFor(b.name || "", b.sym)
    });
  }
}

const clients = new Set();
const diag = {
  started: Date.now(),
  crypto: { ok: false, err: null },
  stocks: { okN: 0, fails: 0, err: null, sym: null },
  macro: { selic: null, usdbrl: null, ipca12m: null }
};
let aiLastError = null;
let macroCache = null;
let shuttingDown = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- fetch com timeout ---------- */
async function fetchT(url, opts = {}, timeout = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

/* ---------- Worker de análise ---------- */
const worker = new Worker(path.join(__dirname, "worker.js"));
const pending = new Map();
let wid = 0;
worker.on("message", ({ id, result, error }) => {
  const p = pending.get(id); pending.delete(id);
  if (p) error ? p.rej(new Error(error)) : p.res(result);
});
worker.on("error", e => log("worker", e.message));

function runAnalysis(closes, H, price) {
  return new Promise((res, rej) => {
    const id = ++wid;
    pending.set(id, { res, rej });
    worker.postMessage({ id, closes, H, price });
    setTimeout(() => { if (pending.delete(id)) rej(new Error("análise demorou demais")); }, 300000);
  });
}

/* ---------- Utilitários de mercado ---------- */
function completedSeries(a, now = Date.now()) {
  const candles = a.candles || [];
  if (candles.length < 50) return null;
  const mkt = a.mkt === "BR" ? "BR" : "US";
  const today = mk.exchangeDate(mkt, new Date(now));
  const last = candles[candles.length - 1];
  const lastDay = new Date(last.t).toISOString().slice(0, 10);
  let closes = candles.map(c => c.c);
  if (lastDay === today) {
    const closeAt = mk.closeInstant(today, mkt);
    if (now < closeAt || (a.fetchedAt && a.fetchedAt < closeAt)) {
      closes = closes.slice(0, -1);
    }
  }
  if (closes.length < 50) return null;
  return { closes, lastDay };
}

function stockDue(a, now = Date.now()) {
  if (!a.fetchedAt) return true;
  const mkt = a.mkt === "BR" ? "BR" : "US";
  const open = mk.marketOpenNow(mkt, new Date(now));
  const since = now - a.fetchedAt;
  if (a.lastTry && now - a.lastTry < 60000) return false;
  if (open) return since > 30 * 60000;
  const today = mk.exchangeDate(mkt, new Date(now));
  const closeAt = mk.closeInstant(today, mkt);
  if (now > closeAt && a.fetchedAt < closeAt) return true;
  return since > 6 * 3600000;
}

function validateFeed(a, data, now = Date.now()) {
  if (!data || !Array.isArray(data.candles) || data.candles.length < 2) throw new Error("sem candles");
  const last = data.candles[data.candles.length - 1];
  if (now - last.t > 12 * 86400000) throw new Error("dados desatualizados");
  if (a.price && data.price && Math.abs(data.price / a.price - 1) > 0.35) throw new Error("preço destoa do último");
  return true;
}

function debounce(a, rec, hz, need) {
  if (!a._deb) a._deb = {};
  if (!a._deb[hz]) a._deb[hz] = { last: null, n: 0, stable: null };
  const d = a._deb[hz];
  if (rec === d.last) {
    d.n++;
    if (d.n >= need) { d.stable = rec; return rec; }
    return null;
  }
  d.last = rec; d.n = 1;
  return d.stable;
}

function finalRec(a) {
  if (!a.analyses) return null;
  const h = "1s";
  return (a.finals && a.finals[h]) || (a.analyses[h] && a.analyses[h].rec) || null;
}

/* ---------- Providers de preço ---------- */
async function fetchFromProviders(a) {
  const errs = [];
  for (const y of (a.ysyms || [])) {
    try {
      const r = await yahoo.fetchYahoo(fetchT, y, "6y", "1d");
      if (r.candles.length >= 200 || (a.ysyms.length === 1 && r.candles.length >= 50)) {
        return { ...r, src: "Yahoo Finance", yUsed: y };
      }
      errs.push(y + ": histórico curto (" + r.candles.length + ")");
    } catch (e) {
      errs.push(y + ": " + e.message);
    }
  }
  if (TWELVE && a.kind === "stock") {
    try {
      const ticker = a.mkt === "BR" ? a.sym + ":BVMF" : a.sym;
      const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(ticker) + "&interval=1day&outputsize=5000&apikey=" + TWELVE;
      const r = await fetchT(url, {}, 25000);
      if (!r.ok) throw new Error("Twelve HTTP " + r.status);
      const j = await r.json();
      const parsed = yahoo.parseTwelve(j);
      return { ...parsed, src: "Twelve Data" };
    } catch (e) { errs.push("Twelve: " + e.message); }
  }
  if (BRAPI && a.mkt === "BR") {
    try {
      const r = await yahoo.fetchBrapi(fetchT, a.sym, BRAPI);
      return { ...r, src: "brapi" };
    } catch (e) { errs.push("brapi: " + e.message); }
  }
  throw new Error(errs.join(" | ") || "sem provedor");
}

async function loadStock(a) {
  a.lastTry = Date.now();
  const data = await fetchFromProviders(a);
  validateFeed(a, data);
  a.candles = data.candles;
  a.price = data.price;
  a.open24 = data.prevClose || (data.candles.length >= 2 ? data.candles[data.candles.length - 2].c : data.price);
  a.src = data.src;
  a.fetchedAt = Date.now();
  a.currency = data.currency || a.ccy;
  a.baseT = data.candles.at(-1).t;
  return a;
}

/* ---------- Cripto (Binance → Yahoo fallback) ---------- */
async function loadCryptoFromBinance(a) {
  const pair = a.pair || a.sym + "USDT";
  const url = "https://api.binance.com/api/v3/klines?symbol=" + pair + "&interval=1d&limit=1000";
  const r = await fetchT(url, {}, 15000);
  if (!r.ok) throw new Error("Binance HTTP " + r.status);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length < 50) throw new Error("Binance sem dados");
  const candles = rows.map(k => ({
    t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4]
  })).filter(c => c.c > 0);
  const turl = "https://api.binance.com/api/v3/ticker/24hr?symbol=" + pair;
  const tr = await fetchT(turl, {}, 10000);
  let price = candles.at(-1).c, open24 = candles.length >= 2 ? candles.at(-2).c : price;
  if (tr.ok) {
    const j = await tr.json();
    if (+j.lastPrice > 0) price = +j.lastPrice;
    if (+j.prevClosePrice > 0) open24 = +j.prevClosePrice;
  }
  return { candles, price, open24, src: "Binance" };
}

async function loadCryptoFromYahoo(a) {
  const errs = [];
  for (const y of (a.ysyms || [a.sym + "-USD"])) {
    try {
      const r = await yahoo.fetchYahoo(fetchT, y, "5y", "1d");
      if (r.candles.length < 50) throw new Error("histórico curto");
      return {
        candles: r.candles,
        price: r.price,
        open24: r.prevClose || r.candles[r.candles.length - 2].c,
        src: "Yahoo Finance"
      };
    } catch (e) { errs.push(y + ": " + e.message); }
  }
  throw new Error(errs.join(" | ") || "Yahoo cripto falhou");
}

async function loadCrypto(a) {
  a.lastTry = Date.now();
  let data;
  try {
    data = await loadCryptoFromBinance(a);
  } catch (e) {
    // Render/EUA costuma levar 451 da Binance — cai no Yahoo
    log("cripto", a.sym, e.message, "→ tentando Yahoo");
    data = await loadCryptoFromYahoo(a);
  }
  a.candles = data.candles;
  a.price = data.price;
  a.open24 = data.open24;
  a.src = data.src;
  a.fetchedAt = Date.now();
  a.baseT = data.candles.at(-1).t;
  diag.crypto.ok = true;
  diag.crypto.err = data.src === "Binance" ? null : ("fallback " + data.src);
  return a;
}

/* ---------- Notícias ---------- */
async function fetchNews(a) {
  const terms = a.terms || [a.name, a.sym].filter(Boolean);
  const lang = a.mkt === "BR" ? "pt" : "en";
  let list = [];
  if (a.kind === "crypto") {
    try {
      const r = await fetchT("https://min-api.cryptocompare.com/data/v2/news/?categories=" + a.sym + "&lang=EN", {}, 12000);
      if (r.ok) list = news.parseCryptoCompare(await r.json());
    } catch {}
  }
  try {
    const g = await news.fetchGoogleNews(fetchT, terms, lang);
    list = list.concat(g);
  } catch (e) {
    if (!list.length) throw e;
  }
  const filtered = news.dedupe(list).filter(n => news.relevant(n.title, terms)).slice(0, 12);
  a.news = filtered.map((n, i) => ({ ...n, id: "N" + (i + 1) }));
  a.newsAt = Date.now();
  return a.news;
}

/* ---------- Análise ---------- */
async function refreshAnalysis(a) {
  const series = completedSeries(a);
  if (!series) return null;
  const { closes } = series;
  const horizons = a.kind === "crypto" ? HZN_C : HZN;
  const analyses = {};
  const finals = {};
  for (const [key, H] of Object.entries(horizons)) {
    try {
      const res = await runAnalysis(closes, H, a.price);
      if (!res) continue;
      analyses[key] = res;
      const need = a.kind === "crypto" ? 3 : 2;
      const stable = debounce(a, res.rec, key, need);
      finals[key] = stable || res.rec;
    } catch (e) {
      log("análise", a.sym, key, e.message);
    }
  }
  if (!Object.keys(analyses).length) return null;
  a.analyses = analyses;
  a.finals = finals;
  a.analysisAt = Date.now();
  a.analysis = true;
  // baseT = último fechamento da série usada (evita Invalid Date no "Sair em")
  if (a.candles && a.candles.length) {
    const nCloses = series.closes.length;
    const idx = Math.min(nCloses, a.candles.length) - 1;
    a.baseT = a.candles[Math.max(0, idx)].t;
  }
  if (a.mkt === "BR" && macroCache) a.macro = macroCache;
  return a;
}

/* ---------- IA ---------- */
function numbersNotFound(text, dados) {
  const nums = String(text).match(/\d+[.,]?\d*/g) || [];
  const out = [];
  for (const n of nums) {
    const clean = n.replace(",", ".");
    if (/^\d{1,2}$/.test(clean) && +clean <= 31) continue;
    if (dados.includes(n) || dados.includes(clean) || dados.includes(n.replace(".", ","))) continue;
    const v = parseFloat(clean);
    if (Number.isFinite(v) && dados.match(new RegExp(String(Math.round(v)) + "(\\.\\d+)?"))) continue;
    out.push(n);
  }
  return out;
}

function parseAI(raw) {
  const s = String(raw).replace(/^```json\s*|\s*```$/g, "").trim();
  let d;
  try { d = JSON.parse(s); } catch { throw new Error("sem JSON"); }
  const recOk = r => ["buy", "wait", "avoid", "obs"].includes(r) ? r : null;
  return {
    sentimento: typeof d.sentimento === "number" ? Math.max(-1, Math.min(1, d.sentimento)) : 0,
    veredito: ["confirma", "neutro", "contradiz"].includes(d.veredito) ? d.veredito : "neutro",
    recomendacao: recOk(d.recomendacao),
    recomendacao_1m: recOk(d.recomendacao_1m),
    recomendacao_5m: recOk(d.recomendacao_5m),
    resumo: String(d.resumo || "").slice(0, 600),
    riscos: Array.isArray(d.riscos) ? d.riscos.map(String).slice(0, 3) : [],
    cenarios: {
      alta: String((d.cenarios && d.cenarios.alta) || ""),
      base: String((d.cenarios && d.cenarios.base) || ""),
      baixa: String((d.cenarios && d.cenarios.baixa) || "")
    },
    x: String(d.x || ""),
    fontes: Array.isArray(d.fontes)
      ? d.fontes.map(f => {
          if (typeof f === "string") return { id: f.toUpperCase().replace(/\s/g, ""), src: "", url: "" };
          return { id: String(f.id || f).toUpperCase(), src: String(f.src || ""), url: String(f.url || "") };
        }).filter(f => /^N\d+$/.test(f.id)).slice(0, 6)
      : [],
    notas: []
  };
}

function validateAI(ai, ctx, analyses) {
  const newsIds = new Set((ctx.news || []).map(n => n.id));
  ai.fontes = (ai.fontes || []).filter(f => newsIds.has(f.id));
  for (const f of ai.fontes) {
    const n = (ctx.news || []).find(x => x.id === f.id);
    if (n) { f.src = n.src; f.url = n.url; }
  }
  const hasSource = ai.fontes.length > 0;
  const order = { buy: 0, wait: 1, obs: 2, avoid: 3 };
  const apply = (statRec, aiRec) => {
    if (!aiRec) return statRec;
    if (!hasSource && order[aiRec] > order[statRec || "obs"]) return null;
    if (order[aiRec] < order[statRec || "obs"]) return statRec;
    return aiRec;
  };
  if (analyses) {
    ai.recomendacao = apply(analyses["1s"] && analyses["1s"].rec, ai.recomendacao);
    ai.recomendacao_1m = apply(analyses["1m"] && analyses["1m"].rec, ai.recomendacao_1m);
    ai.recomendacao_5m = apply(analyses["5m"] && analyses["5m"].rec, ai.recomendacao_5m);
  }
  const inventados = numbersNotFound(ai.resumo + " " + JSON.stringify(ai.cenarios), ctx.text || "");
  ai.verificado = hasSource && inventados.length === 0;
  if (inventados.length) ai.notas.push("números não encontrados nos dados: " + inventados.join(", "));
  if (!hasSource && (ai.recomendacao || ai.recomendacao_1m)) ai.notas.push("rebaixamento sem fonte verificável foi ignorado");
  return ai;
}

function aiPrompt(a) {
  const now = Date.now();
  const fresh = (a.news || []).filter(n => now - n.when <= 10 * 86400000);
  const newsBlock = fresh.map(n => {
    const d = new Date(n.when).toISOString().slice(0, 10);
    return n.id + " [" + d + " | " + n.src + "] " + n.title;
  }).join("\n") || "Nenhuma manchete recente.";
  const an = a.analyses || {};
  const lines = [];
  for (const [k, H] of Object.entries(a.kind === "crypto" ? HZN_C : HZN)) {
    const r = an[k];
    if (!r) continue;
    lines.push(k + " (H=" + H + "): rec=" + r.rec + " conf=" + r.conf + " med=" + (r.st.med * 100).toFixed(1) + "% n=" + r.st.n);
  }
  const macro = a.mkt === "BR" && a.macro
    ? "Selic " + (a.macro.selic ?? "n/d") + "%, USD/BRL " + (a.macro.usdbrl ?? "n/d") + ", IPCA12m " + (a.macro.ipca12m != null ? (a.macro.ipca12m * 100).toFixed(1) + "%" : "n/d")
    : "";
  const priceStr = a.ccy === "BRL" ? "R$ " + (a.price || 0).toFixed(2) : "US$ " + (a.price || 0).toFixed(2);
  const text = "Ativo: " + a.sym + " (" + a.name + ") | Preço: " + priceStr + "\nModelo estatístico por horizonte:\n" +
    (lines.join("\n") || "sem análise") + "\n" +
    (macro ? "Macro BR: " + macro + "\n" : "") +
    "\nManchetes numeradas (cite só esses IDs):\n" + newsBlock +
    "\n\nResponda APENAS um JSON válido:\n" +
    '{"sentimento":-1 a 1,"veredito":"confirma"|"neutro"|"contradiz","recomendacao":"buy"|"wait"|"obs"|"avoid"|null,"recomendacao_1m":idem,"recomendacao_5m":idem,"resumo":"...","riscos":["..."],"cenarios":{"alta":"...","base":"...","baixa":"..."},"x":"...","fontes":["N1",...]}\n' +
    "Regras: só rebaixe o sinal estatístico se citar ao menos uma manchete real (N1, N2...). Nunca invente números. Nunca melhore o sinal.";
  return { text, ctx: { news: fresh, text } };
}

async function callGemini(promptText) {
  const models = [ENV.AI_MODEL || "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b"].filter(Boolean);
  let lastErr;
  for (const model of models) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
    const r = await fetchT(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    }, 45000);
    if (!r.ok) {
      const err = await r.text();
      lastErr = new Error("Gemini " + model + " HTTP " + r.status + ": " + err.slice(0, 200));
      if (r.status === 404) continue;
      throw lastErr;
    }
    const j = await r.json();
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const text = parts.filter(p => !p.thought && p.text).map(p => p.text).join("") || parts.map(p => p.text || "").join("");
    return { out: text, model };
  }
  throw lastErr || new Error("nenhum modelo Gemini respondeu");
}

async function callGroq(promptText) {
  // llama-3.3-70b-versatile virou Enterprise; free/dev usa estes (ordem de preferência)
  const models = [
    ENV.GROQ_MODEL,
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "llama-3.1-8b-instant"
  ].filter(Boolean);
  let lastErr;
  for (const model of models) {
    try {
      const r = await fetchT("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + GROQ_KEY },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: promptText }],
          temperature: 0.2,
          response_format: { type: "json_object" }
        })
      }, 45000);
      if (!r.ok) {
        const errText = await r.text();
        lastErr = new Error("Groq " + model + " HTTP " + r.status + ": " + errText.slice(0, 180));
        if (r.status === 404 || r.status === 403) continue; // tenta próximo modelo
        throw lastErr;
      }
      const j = await r.json();
      return { out: j.choices[0].message.content, model };
    } catch (e) {
      lastErr = e;
      if (/HTTP (404|403)/.test(e.message)) continue;
      throw e;
    }
  }
  throw lastErr || new Error("nenhum modelo Groq respondeu");
}

const aiQueue = [];
let aiActive = 0;
function queueAI(a, urgent) {
  if ((!GEMINI_KEY && !GROQ_KEY) || !a.analysis || a.aiRunning || aiQueue.includes(a)) return;
  urgent ? aiQueue.unshift(a) : aiQueue.push(a);
  while (aiActive < AI_CONC && aiQueue.length > aiActive) {
    aiActive++;
    drainAI().finally(() => { aiActive--; });
  }
}
async function drainAI() {
  while (aiQueue.length) {
    const a = aiQueue.shift();
    a.aiRunning = true;
    try {
      const { text, ctx } = aiPrompt(a);
      const { out, model } = GEMINI_KEY ? await callGemini(text) : await callGroq(text);
      ctx.model = model;
      a.ai = validateAI(parseAI(out), ctx, a.analyses);
      a.aiAt = Date.now();
      aiLastError = null;
      if (a.ai.recomendacao && a.finals) a.finals["1s"] = a.ai.recomendacao;
      if (a.ai.recomendacao_1m && a.finals) a.finals["1m"] = a.ai.recomendacao_1m;
      if (a.ai.recomendacao_5m && a.finals) a.finals["5m"] = a.ai.recomendacao_5m;
      broadcast({ type: "ai", asset: view(a) });
    } catch (e) {
      a.aiAt = Date.now() - AI_EVERY + 120000;
      aiLastError = e.message;
      log("IA", a.sym, e.message);
    }
    a.aiRunning = false;
    await sleep(1500);
  }
}

/* ---------- View / broadcast ---------- */
function view(a) {
  // Front espera candles como [t, o, h, l, c], não objetos {t,o,h,l,c}
  const candles = (a.candles || []).slice(-120).map(c => [c.t, c.o, c.h, c.l, c.c]);
  let baseT = a.baseT;
  if (baseT == null && a.candles && a.candles.length) baseT = a.candles[a.candles.length - 1].t;
  return {
    sym: a.sym, name: a.name, kind: a.kind, mkt: a.mkt, ccy: a.ccy,
    price: a.price, open24: a.open24,
    candles, baseT,
    analyses: a.analyses, finals: a.finals, analysisAt: a.analysisAt,
    src: a.src, dataAt: a.fetchedAt,
    news: (a.news || []).slice(0, 8),
    tweets: (a.tweets || []).slice(0, 5),
    ai: a.ai, aiAt: a.aiAt,
    macro: a.macro || null
  };
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}
function log(tag, ...args) { console.log("[" + new Date().toISOString().slice(11, 19) + "] [" + tag + "]", ...args); }

/* ---------- Mock para testes ---------- */
function mockData() {
  const day = 86400000;
  const base = Date.parse("2026-10-01");
  for (const a of assets.values()) {
    const n = 500;
    a.candles = Array.from({ length: n }, (_, i) => {
      const c = 10 + i * 0.01 + Math.sin(i / 20) * 0.5;
      return { t: base + i * day, o: c * 0.99, h: c * 1.02, l: c * 0.98, c };
    });
    a.price = a.candles.at(-1).c * 1.005;
    a.open24 = a.candles.at(-2).c;
    a.src = "MOCK";
    a.fetchedAt = Date.now();
    a.news = [{ id: "N1", title: "Manchete de teste " + a.sym, url: "https://example.com/1", src: "MOCK", when: Date.now() - 3600000 }];
    a.newsAt = Date.now();
  }
  macroCache = { selic: 13.75, usdbrl: 5.5, ipca12m: 0.04, at: Date.now() };
  diag.macro = macroCache;
}

/* ---------- Loops ---------- */
async function priceLoop() {
  for (;;) {
    if (shuttingDown) return;
    for (const a of assets.values()) {
      if (shuttingDown) return;
      try {
        if (a.kind === "crypto") {
          if (!a.fetchedAt || Date.now() - a.fetchedAt > 60000) {
            await loadCrypto(a);
            diag.crypto.ok = true;
            diag.crypto.err = null;
          }
        } else if (stockDue(a)) {
          await loadStock(a);
          diag.stocks.okN++;
          diag.stocks.err = null;
        }
        if (a.price) broadcast({ type: "tick", sym: a.sym, price: a.price, open24: a.open24 });
      } catch (e) {
        if (a.kind === "crypto") {
          diag.crypto.ok = false;
          diag.crypto.err = e.message;
        } else {
          diag.stocks.fails++;
          diag.stocks.err = e.message;
          diag.stocks.sym = a.sym;
        }
        log("preço", a.sym, e.message);
      }
      await sleep(a.kind === "crypto" ? 200 : 400);
    }
    await sleep(5000);
  }
}

async function analysisLoop() {
  await sleep(3000);
  for (;;) {
    if (shuttingDown) return;
    for (const a of assets.values()) {
      if (!a.candles || a.candles.length < 80) continue;
      try {
        const before = a.finals && a.finals["1s"];
        await refreshAnalysis(a);
        if (a.analyses) {
          broadcast({ type: "analysis", asset: view(a) });
          const after = a.finals && a.finals["1s"];
          if (before && after && before !== after) {
            broadcast({ type: "alert", text: a.sym + ": sinal " + before + " → " + after });
          }
        }
      } catch (e) { log("análise-loop", a.sym, e.message); }
      await sleep(300);
    }
    await sleep(20000);
  }
}

async function newsLoop() {
  await sleep(8000);
  for (;;) {
    if (shuttingDown) return;
    for (const a of assets.values()) {
      if (a.newsAt && Date.now() - a.newsAt < 45 * 60000) continue;
      try {
        await fetchNews(a);
      } catch (e) { log("news", a.sym, e.message); }
      await sleep(1500);
    }
    await sleep(60000);
  }
}

async function macroLoop() {
  for (;;) {
    if (shuttingDown) return;
    try {
      macroCache = await bcb.fetchMacro(fetchT);
      diag.macro = macroCache;
      for (const a of assets.values()) if (a.mkt === "BR") a.macro = macroCache;
    } catch (e) { log("macro", e.message); }
    await sleep(30 * 60000);
  }
}

async function aiLoop() {
  if (!GEMINI_KEY && !GROQ_KEY) { log("IA desligada (defina GEMINI_API_KEY ou GROQ_API_KEY)"); return; }
  for (;;) {
    if (shuttingDown) return;
    for (const a of assets.values()) {
      if (a.analysis && (a.newsAt || Date.now() - diag.started > 6 * 60000) && Date.now() - (a.aiAt || 0) > AI_EVERY) {
        queueAI(a, false);
      }
    }
    await sleep(15000);
  }
}

/* ---------- HTTP + WS ---------- */
function checkAuth(url) {
  if (!ACCESS) return true;
  return url.searchParams.get("t") === ACCESS;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  if (url.pathname === "/health") {
    const brN = [...assets.values()].filter(a => a.mkt === "BR" && a.analysis).length;
    res.setHeader("content-type", "application/json");
    const learn = memory.snapshot();
    res.end(JSON.stringify({
      ok: true, live: true,
      assets: assets.size,
      analisados: [...assets.values()].filter(a => a.analysis).length,
      acoesBRAnalisadas: brN,
      ai: { ligada: !!(GEMINI_KEY || GROQ_KEY), ultimoErro: aiLastError },
      aprendizado: {
        count: learn.learningCount,
        acertos: learn.correct,
        erros: learn.wrong,
        winRate: learn.winRate,
        K: learn.K,
        minN: learn.minN,
        pending: learn.pending,
        lastReason: learn.lastReason,
        lastUpdate: learn.lastUpdate
      },
      diagnostico: diag
    }));
    return;
  }
  if (!checkAuth(url) && url.pathname === "/") {
    res.statusCode = 401;
    res.end("Token inválido. Use ?t=SEU_ACCESS_TOKEN");
    return;
  }
  let fp = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname);
  if (!fp.startsWith(path.join(__dirname, "public"))) { res.statusCode = 403; res.end("Forbidden"); return; }
  try {
    const st = fs.statSync(fp);
    if (st.isDirectory()) fp = path.join(fp, "index.html");
    const ext = path.extname(fp);
    const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" }[ext] || "text/plain";
    res.setHeader("content-type", mime);
    res.setHeader("Referrer-Policy", "no-referrer");
    fs.createReadStream(fp).pipe(res);
  } catch {
    res.statusCode = 404; res.end("Not Found");
  }
});

const wss = new WebSocket.Server({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", "http://localhost");
  if (ACCESS && url.searchParams.get("t") !== ACCESS) {
    ws.close(4001, "unauthorized");
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({
    type: "snapshot",
    live: true,
    ai: !!(GEMINI_KEY || GROQ_KEY),
    x: false,
    assets: [...assets.values()].map(view)
  }));
  ws.on("message", (msg) => {
    try {
      const d = JSON.parse(msg);
      if (d.type === "ping") ws.send(JSON.stringify({ type: "pong", t: d.t }));
    } catch {}
  });
  ws.on("close", () => clients.delete(ws));
});

function shutdown() {
  shuttingDown = true;
  try { memory.save(true); } catch {}
  try { worker.terminate(); } catch {}
  try { server.close(); } catch {}
  for (const c of clients) try { c.close(); } catch {}
}

async function learningLoop() {
  const mem = memory.load();
  log("memória", mem.ok ? ("carregada · aprendizados=" + mem.learningCount + " winRate=" + (mem.winRate != null ? (mem.winRate * 100).toFixed(1) + "%" : "n/d")) : ("nova (" + (mem.err || "") + ")"));
  for (;;) {
    if (shuttingDown) return;
    try {
      // registra previsões dos ativos que já têm análise
      for (const a of assets.values()) {
        if (a.analysis && a.price) memory.recordPrediction(a);
      }
      // confere as que já venceram (~35s)
      const results = memory.evaluate(sym => assets.get(sym));
      for (const r of results) {
        if (r.ok === false) log("aprender", r.sym, r.reason);
        else if (r.ok === true) log("aprender", r.sym, "OK", r.reason);
      }
      if (results.length) {
        const snap = memory.snapshot();
        broadcast({ type: "status", live: true, learning: {
          count: snap.learningCount,
          winRate: snap.winRate,
          lastReason: snap.lastReason,
          pending: snap.pending
        }});
      }
    } catch (e) {
      log("aprender", e.message);
    }
    await sleep(30000); // ciclo de 30s
  }
}

async function main() {
  log("Iniciando Sinal Semanal…");
  log("Ativos: " + assets.size + " (BR: " + [...assets.values()].filter(a => a.mkt === "BR").length + ")");
  if (MOCK) {
    log("MODO MOCK ativo");
    mockData();
  }
  server.listen(PORT, () => log("Servidor na porta " + PORT));
  if (!MOCK) {
    priceLoop();
    analysisLoop();
    newsLoop();
    macroLoop();
  } else {
    for (const a of assets.values()) {
      try { await refreshAnalysis(a); broadcast({ type: "analysis", asset: view(a) }); } catch {}
    }
  }
  aiLoop();
  learningLoop();
}

if (require.main === module) main();

module.exports = {
  assets, view, parseAI, validateAI, numbersNotFound, finalRec, debounce,
  completedSeries, stockDue, validateFeed, fetchFromProviders, loadStock,
  fetchNews, refreshAnalysis, aiPrompt, queueAI, mockData, shutdown,
  runAnalysis
};
