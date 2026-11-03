"use strict";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY || "";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

// Configuração de ativos (Cripto)
const ASSETS = [
  { sym: "BTCUSDT", name: "Bitcoin", kind: "crypto" },
  { sym: "ETHUSDT", name: "Ethereum", kind: "crypto" },
  { sym: "SOLUSDT", name: "Solana", kind: "crypto" },
  { sym: "BNBUSDT", name: "BNB", kind: "crypto" },
  { sym: "XRPUSDT", name: "XRP", kind: "crypto" },
  { sym: "ADAUSDT", name: "Cardano", kind: "crypto" },
  { sym: "AVAXUSDT", name: "Avalanche", kind: "crypto" },
  { sym: "DOGEUSDT", name: "Dogecoin", kind: "crypto" },
  { sym: "DOTUSDT", name: "Polkadot", kind: "crypto" },
  { sym: "LINKUSDT", name: "Chainlink", kind: "crypto" }
];

// Estado global em memória
const state = new Map();
ASSETS.forEach(a => {
  state.set(a.sym, {
    ...a,
    price: 0,
    open24: 0,
    candles: [],
    analyses: {},
    finals: {},
    news: [],
    tweets: [],
    ai: null,
    aiAt: 0,
    analysisAt: Date.now()
  });
});

/* ----------------------------------------------------
   Função para chamar a API do Google Gemini
---------------------------------------------------- */
async function callGemini(promptText) {
  if (!GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2
        }
      })
    });

    if (!res.ok) {
      console.error("[Gemini Error]", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return rawText ? JSON.parse(rawText) : null;
  } catch (err) {
    console.error("[Gemini Fetch Exception]", err.message);
    return null;
  }
}

/* ----------------------------------------------------
   Análise de Notícias com Gemini (Revisão Automática)
---------------------------------------------------- */
async function runAIForAsset(asset) {
  if (!GEMINI_API_KEY) return;
  
  const newsContext = (asset.news || []).map(n => `- ${n.title} (${n.src})`).join("\n");
  const tweetsContext = (asset.tweets || []).map(t => `- ${t.text}`).join("\n");

  const prompt = `Você é um analista quantitativo e fundamentalista de ativos de mercado financeiro.
Analise as notícias e dados recentes sobre o ativo ${asset.name} (${asset.sym}):

Notícias recentes:
${newsContext || "Sem notícias recentes."}

Posts no X:
${tweetsContext || "Sem posts recentes no X."}

Revise e valide internamente as informações 5 vezes para garantir coerência.
Responda ESTRITAMENTE em formato JSON com o seguinte esquema:
{
  "veredito": "confirma" | "neutro" | "contradiz",
  "sentimento": número entre -1.0 (muito negativo) e 1.0 (muito positivo),
  "resumo": "Um resumo conciso de 2 frases sobre o momento do ativo em português.",
  "riscos": ["Risco 1 em português", "Risco 2 em português"],
  "x": "Resumo rápido do sentimento geral no X em português."
}`;

  const aiData = await callGemini(prompt);
  if (aiData) {
    asset.ai = {
      veredito: aiData.veredito || "neutro",
      sentimento: typeof aiData.sentimento === "number" ? aiData.sentimento : 0,
      resumo: aiData.resumo || "Análise indisponível.",
      riscos: Array.isArray(aiData.riscos) ? aiData.riscos : [],
      x: aiData.x || "Sem dados significativos."
    };
    asset.aiAt = Date.now();
  }
}
/* ----------------------------------------------------
   Busca de Histórico (Binance API) e Servidor
---------------------------------------------------- */
async function fetchBinanceCandles(symbol) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=120`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(c => [c[0], parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4])]);
  } catch {
    return [];
  }
}

async function updateMarketData() {
  for (const asset of state.values()) {
    const rawCandles = await fetchBinanceCandles(asset.sym);
    if (rawCandles.length > 0) {
      asset.candles = rawCandles;
      asset.price = rawCandles[rawCandles.length - 1][4];
      asset.open24 = rawCandles[rawCandles.length - 2]?.[4] || asset.price;
      
      // Simulação rápida de análise estatística para o horizonte de 1 semana ("1s")
      asset.analyses["1s"] = {
        H: 7,
        rec: "buy",
        conf: "média",
        st: { n: 42, med: 0.035, pUp: 0.65, p10: -0.02, p90: 0.09, pDip: 0.2, dip: -0.01, days: [] },
        bt: { buyWin: 0.6, base: 0.5, buyWeeks: 10 }
      };
      asset.finals["1s"] = asset.ai ? asset.ai.veredito === "contradiz" ? "avoid" : "buy" : "buy";

      // Dispara a IA do Gemini para ler as notícias deste ativo
      await runAIForAsset(asset);
    }
  }
}

// Servidor HTTP básico
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ai: !!GEMINI_API_KEY, x: false }));
    return;
  }

  // Servir ficheiros estáticos (index.html)
  let filePath = path.join(__dirname, pathname === "/" ? "index.html" : pathname);
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath);
    const contentType = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : "text/plain";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
});

// WebSocket Server
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", ws => {
  // Envia snapshot inicial para o cliente
  const snapshot = {
    type: "snapshot",
    live: true,
    ai: !!GEMINI_API_KEY,
    x: false,
    assets: [...state.values()]
  };
  ws.send(JSON.stringify(snapshot));

  ws.on("message", message => {
    try {
      const data = JSON.parse(message);
      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: data.t }));
      }
    } catch {}
  });
});

// Inicia atualizações periódicas
setInterval(updateMarketData, 60000);
updateMarketData();

server.listen(PORT, () => {
  console.log(`[Servidor] A rodar na porta ${PORT} com suporte ao Gemini.`);
});
