"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const WebSocket = require("ws");

/* ---------- .env mínimo ---------- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const ENV = process.env;
const PORT = +ENV.PORT || 3000;
const GROQ_KEY = ENV.GROQ_API_KEY || ENV.GEMINI_API_KEY || "";
const AI_EVERY = (+ENV.AI_EVERY_MIN || 30) * 60000;
const AI_CONC = 1;

// --- COLE AQUI (Substitui a forma antiga de carregar o universe) ---
let universe = {};
try { universe = require("./lib/universe"); } catch (e) { console.log("Aviso universe:", e.message); }

const BR = Array.isArray(universe) ? universe : (universe.BR || universe.acoesBR || universe.BRA || []);
const termsFor = typeof universe.termsFor === "function" ? universe.termsFor : (n => [n]);
// -----------------------------------------------------------------

const CRYPTO = [
  ["BTC", "Bitcoin"], ["ETH", "Ethereum"], ["SOL", "Solana"], ["BNB", "BNB"],
  ["XRP", "XRP"], ["ADA", "Cardano"], ["AVAX", "Avalanche"], ["DOGE", "Dogecoin"],
  ["LINK", "Chainlink"], ["DOT", "Polkadot"], ["NEAR", "NEAR Protocol"], ["MATIC", "Polygon"]
];

const STOCKS = [
  ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "NVIDIA"], ["AMZN", "Amazon"],
  ["GOOGL", "Alphabet"], ["META", "Meta Platforms"], ["TSLA", "Tesla"], ["BRK-B", "Berkshire Hathaway"],
  ["JPM", "JPMorgan Chase"], ["V", "Visa"], ["XOM", "ExxonMobil"], ["JNJ", "Johnson & Johnson"],
  ["WMT", "Walmart"], ["MA", "Mastercard"], ["NFLX", "Netflix"], ["AMD", "AMD"],
  ["INTC", "Intel"], ["DIS", "Disney"], ["PYPL", "PayPal"], ["COIN", "Coinbase"]
];

const assets = new Map();
for (const [s, n] of CRYPTO) assets.set(s, { kind:"crypto", mkt:"CRYPTO", ccy:"USD", sym:s, name:n, pair:s + "USDT", H:7, ysyms:[s + "-USD"] });
for (const [s, n] of STOCKS) assets.set(s, { kind:"stock", mkt:"US", ccy:"USD", sym:s, name:n, H:5, ysyms:[s], terms:[s, n] });

for (const b of BR) {
  if (b && b.sym) {
    assets.set(b.sym, { 
      kind: "stock", 
      mkt: "BR", 
      ccy: "BRL", 
      sym: b.sym, 
      name: b.name || b.sym, 
      H: 5, 
      ysyms: b.y || [b.sym], 
      terms: b.terms || termsFor(b.name || "") 
    });
  }
}

const clients = new Set();
const diag = { started: Date.now(), crypto: { ok:false, err:null }, stocks: { okN:0, fails:0, err:null, sym:null }, macro: { selic:null, usdbrl:null } };
let aiLastError = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Worker de Análise Estatística ---------- *
const worker = new Worker(path.join(__dirname, "worker.js"));
const pending = new Map();
let wid = 0;
worker.on("message", ({ id, result, error }) => {
  const p = pending.get(id); pending.delete(id);
  error ? p.rej(new Error(error)) : p.res(result);
});
worker.on("error", e => log("worker", e.message));

function runAnalysis(closes, H, price) {
  return new Promise((res, rej) => {
    const id = ++wid; pending.set(id, { res, rej });
    worker.postMessage({ id, closes, H, price });
    setTimeout(() => { if (pending.delete(id)) rej(new Error("análise demorou demais")); }, 300000);
  });
}

/* ---------- Chamada à IA via Groq (Llama 3 70B) ---------- */
function aiPrompt(a, now = Date.now()) {
  const fresh = (a.news || []).filter(n => now - n.when <= 48 * 3600000);
  const text = fresh.map((n, i) => `[${i + 1}] (${n.src}, há ${Math.round((now - n.when) / 60000)}m): ${n.title}`).join("\n");
  const tw = (a.tweets || []).slice(0, 3).map(t => `- ${t.text}`).join("\n");
  const prompt = `Analise o ativo ${a.sym} (${a.name}). Retorne estritamente um JSON válido com esta estrutura exata:
{"veredito":"confirma"|"neutro"|"contradiz","sentimento":-1 a 1,"resumo":"texto curto","riscos":["risco 1"],"cenarios":{"alta":"...","base":"...","baixa":"..."},"x":"...","fontes":[{"id":"1","src":"...","url":"..."}]}
Notícias:\n${text || "Nenhuma"}\nPosts X:\n${tw || "Nenhum"}`;
  return { text: prompt, ctx: { news: fresh, text } };
}

async function callGroq(promptText) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: "llama3-70b-8192",
      messages: [{ role: "user", content: promptText }],
      temperature: 0.3,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq HTTP ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return { out: data.choices[0].message.content, model: "llama3-70b-8192" };
}

function parseAI(raw) {
  try {
    const d = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "").trim());
    return {
      veredito: ["confirma", "neutro", "contradiz"].includes(d.veredito) ? d.veredito : "neutro",
      sentimento: typeof d.sentimento === "number" ? Math.max(-1, Math.min(1, d.sentimento)) : 0,
      resumo: String(d.resumo || ""),
      riscos: Array.isArray(d.riscos) ? d.riscos.map(String).slice(0, 3) : [],
      cenarios: { alta: String(d.cenarios?.alta || ""), base: String(d.cenarios?.base || ""), baixa: String(d.cenarios?.baixa || "") },
      x: String(d.x || ""),
      fontes: Array.isArray(d.fontes) ? d.fontes.map(f => ({ id: String(f.id || "1"), src: String(f.src || "web"), url: String(f.url || "#") })).slice(0, 4) : [],
      notas: []
    };
  } catch (e) {
    return { veredito: "neutro", sentimento: 0, resumo: "Falha ao processar resposta da IA.", riscos: [], cenarios: { alta: "", base: "", baixa: "" }, x: "", fontes: [], notas: [e.message] };
  }
}
function validateAI(ai, ctx) { return ai; }

const aiQueue = []; let aiActive = 0;
function queueAI(a, urgent) {
  if (!GROQ_KEY || !a.analysis || a.aiRunning || aiQueue.includes(a)) return;
  urgent ? aiQueue.unshift(a) : aiQueue.push(a);
  while (aiActive < AI_CONC && aiQueue.length > aiActive) { aiActive++; drainAI().finally(() => { aiActive--; }); }
}
async function drainAI() {
  while (aiQueue.length) {
    const a = aiQueue.shift(); a.aiRunning = true;
    try {
      const { text, ctx } = aiPrompt(a);
      const { out, model } = await callGroq(text); ctx.model = model;
      a.ai = validateAI(parseAI(out), ctx); a.aiAt = Date.now(); aiLastError = null;
      broadcast({ type: "ai", asset: view(a) });
    } catch (e) { a.aiAt = Date.now() - AI_EVERY + 120000; aiLastError = e.message; log("IA", a.sym, e.message); }
    a.aiRunning = false;
    await sleep(2000);
  }
}
async function aiLoop() {
  if (!GROQ_KEY) { log("IA desligada (defina GROQ_API_KEY)"); return; }
  for (;;) {
    for (const a of assets.values()) if (a.analysis && (a.newsAt || Date.now() - diag.started > 6 * 60000) && Date.now() - (a.aiAt || 0) > AI_EVERY) queueAI(a, false);
    await sleep(15000);
  }
}

function completedSeries(a) {
  const c = a.candles; if (!c || c.length < 400) return null;
  const lastT = c.at(-1).t, today0 = Math.floor(Date.now() / 86400000) * 86400000;
  const closed = lastT < today0 ? c : c.slice(0, -1);
  const out = closed.map(x => x.c);
  return out.every(Number.isFinite) ? out : null;
}

function view(a) {
  return {
    sym: a.sym, name: a.name, kind: a.kind, mkt: a.mkt, ccy: a.ccy,
    price: a.price, open24: a.open24, candles: (a.candles || []).slice(-120),
    analyses: a.analyses, analysisAt: a.analysisAt, src: a.src, dataAt: a.fetchedAt,
    news: (a.news || []).slice(0, 8), tweets: (a.tweets || []).slice(0, 5), ai: a.ai, aiAt: a.aiAt
  };
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}
function log(tag, ...args) { console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}]`, ...args); }

/* ---------- Servidor HTTP e WebSocket ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  if (url.pathname === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true, live: true, assets: assets.size,
      ai: { ligada: !!GROQ_KEY, modelo: "llama3-70b-8192", ultimoErro: aiLastError },
      diagnostico: diag
    }));
    return;
  }
  let fp = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname);
  if (!fp.startsWith(path.join(__dirname, "public"))) { res.statusCode = 403; res.end("Forbidden"); return; }
  try {
    const st = fs.statSync(fp);
    if (st.isDirectory()) fp = path.join(fp, "index.html");
    const ext = path.extname(fp);
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" }[ext] || "text/plain";
    res.setHeader("content-type", mime);
    fs.createReadStream(fp).pipe(res);
  } catch {
    res.statusCode = 404; res.end("Not Found");
  }
});

const wss = new WebSocket.Server({ server, path: "/ws" });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "snapshot", live: true, ai: !!GROQ_KEY, x: false, assets: [...assets.values()].map(view) }));
  ws.on("message", (msg) => {
    try {
      const d = JSON.parse(msg);
      if (d.type === "ping") ws.send(JSON.stringify({ type: "pong", t: d.t }));
    } catch {}
  });
  ws.on("close", () => clients.delete(ws));
});

async function main() {
  log("Iniciando servidor com suporte à Groq...");
  server.listen(PORT, () => log(`Servidor rodando na porta ${PORT}`));
  aiLoop();
}

if (require.main === module) main();
