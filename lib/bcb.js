"use strict";
/* Contexto macro do Brasil direto do Banco Central (API aberta, sem chave): Selic meta, dólar PTAX e IPCA. */
const SGS = { selic: 432, usd: 1, ipca: 433 };
const url = (code, n) => `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados/ultimos/${n}?formato=json`;

// Linhas { data:"dd/mm/aaaa", valor:"13.75" } -> [{ d:"aaaa-mm-dd", v:13.75 }] em ordem cronológica.
function parseSGS(rows) {
  if (!Array.isArray(rows)) throw new Error("resposta do BCB inesperada");
  const out = [];
  for (const r of rows) {
    const m = String(r.data || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/), v = parseFloat(String(r.valor).replace(",", "."));
    if (m && Number.isFinite(v)) out.push({ d: `${m[3]}-${m[2]}-${m[1]}`, v });
  }
  return out.sort((a, b) => a.d < b.d ? -1 : 1);
}

async function fetchMacro(fetchT) {
  const get = async (code, n) => parseSGS(await (await fetchT(url(code, n), {}, 15000)).json());
  const [selic, usd, ipca] = await Promise.all([
    get(SGS.selic, 1).catch(() => []), get(SGS.usd, 6).catch(() => []), get(SGS.ipca, 12).catch(() => [])
  ]);
  const m = { at: Date.now() };
  if (selic.length) { m.selic = selic.at(-1).v; m.selicDate = selic.at(-1).d; }
  if (usd.length) {
    m.usdbrl = usd.at(-1).v; m.usdbrlDate = usd.at(-1).d;
    if (usd.length >= 2) m.usdbrl5d = usd.at(-1).v / usd[0].v - 1;
  }
  if (ipca.length) {
    m.ipcaMes = ipca.at(-1).v; m.ipcaDate = ipca.at(-1).d;
    if (ipca.length >= 12) m.ipca12m = ipca.reduce((acc, x) => acc * (1 + x.v / 100), 1) - 1;
  }
  return m;
}

module.exports = { parseSGS, fetchMacro, SGS };
