"use strict";
/*
 * Universo de ativos acompanhados.
 * Ações do Brasil: 20 maiores empresas da B3 por valor de mercado (ranking do Investidor10, consultado em 02/11/2026,
 * depois da queda pós-eleição; o top 12 confere com o levantamento da Elos Ayta de 13/10/2026).
 * Uma empresa aparece uma só vez, na classe de ação mais negociada (ex.: Bradesco = BBDC4, Petrobras = PETR4).
 * Para trocar a lista basta editar BR abaixo: sym = código na B3, y = códigos no Yahoo Finance (testados em ordem).
 * AXIA3 (ex-Eletrobras) e EMBJ3 (Embraer) mudaram de código recentemente: o código antigo fica como reserva
 * para o caso de o histórico do código novo ser curto.
 */
const BR = [
  { sym: "PETR4",  name: "Petrobras",         y: ["PETR4.SA"] },
  { sym: "ITUB4",  name: "Itaú Unibanco",     y: ["ITUB4.SA"] },
  { sym: "VALE3",  name: "Vale",              y: ["VALE3.SA"] },
  { sym: "BPAC11", name: "BTG Pactual",       y: ["BPAC11.SA"] },
  { sym: "ABEV3",  name: "Ambev",             y: ["ABEV3.SA"] },
  { sym: "WEGE3",  name: "WEG",               y: ["WEGE3.SA"] },
  { sym: "BBDC4",  name: "Bradesco",          y: ["BBDC4.SA"] },
  { sym: "ITSA4",  name: "Itaúsa",            y: ["ITSA4.SA"] },   // holding: anda junto com o Itaú
  { sym: "AXIA3",  name: "Axia Energia",      y: ["AXIA3.SA", "ELET3.SA"], terms: ["Axia Energia", "AXIA3", "Eletrobras"] },
  { sym: "VIVT3",  name: "Vivo (Telefônica Brasil)", y: ["VIVT3.SA"], terms: ["Vivo", "VIVT3", "Telefônica Brasil"] },
  { sym: "BBAS3",  name: "Banco do Brasil",   y: ["BBAS3.SA"] },
  { sym: "SANB11", name: "Santander Brasil",  y: ["SANB11.SA"] },
  { sym: "SBSP3",  name: "Sabesp",            y: ["SBSP3.SA"] },
  { sym: "BBSE3",  name: "BB Seguridade",     y: ["BBSE3.SA"] },
  { sym: "EMBJ3",  name: "Embraer",           y: ["EMBJ3.SA", "EMBR3.SA"], terms: ["Embraer", "EMBJ3", "EMBR3"] },
  { sym: "RDOR3",  name: "Rede D'Or",         y: ["RDOR3.SA"], terms: ["Rede D'Or", "Rede Dor", "RDOR3"] },
  { sym: "B3SA3",  name: "B3 (Bolsa)",        y: ["B3SA3.SA"], terms: ["B3SA3", "B3 bolsa", "Bolsa brasileira"] },
  { sym: "CXSE3",  name: "Caixa Seguridade",  y: ["CXSE3.SA"] },
  { sym: "SUZB3",  name: "Suzano",            y: ["SUZB3.SA"] },
  { sym: "PRIO3",  name: "PRIO",              y: ["PRIO3.SA"] }
];

// Termos de busca de notícias: o nome e o código (código só se tiver 3+ letras, para não pegar "V" ou "MA" soltos).
function termsFor(name, sym) {
  if (!name) return ["mercado financeiro"];
  const base = [name.replace(/\s*\(.*\)$/, "").trim()];
  if (sym && String(sym).length >= 3) base.push(String(sym));
  // remove duplicatas e vazios
  return [...new Set(base.filter(Boolean))];
}

module.exports = { BR, termsFor };
