"use strict";
/* Horários de pregão e fuso de cada mercado. Tudo em UTC para não depender do fuso do servidor. */
const MIN = 60000;

// B3: 10h00 às 17h55 (horário de Brasília, UTC-3, sem horário de verão desde 2019) = 13h00 às 20h55 UTC.
// EUA: 9h30 às 16h00 (Nova York) = 13h30 às 20h00 UTC (inverno: 14h30 às 21h00). Usamos a janela larga.
const MKT = {
  BR: { open: 12 * 60 + 45, close: 21 * 60 + 5, tzOffsetMin: -180, ccy: "BRL", label: "B3" },
  US: { open: 13 * 60 + 25, close: 21 * 60 + 5, tzOffsetMin: -300, ccy: "USD", label: "EUA" }
};

function isWeekday(d) { const w = d.getUTCDay(); return w >= 1 && w <= 5; }
function minutesUTC(d) { return d.getUTCHours() * 60 + d.getUTCMinutes(); }

function marketOpenNow(mkt = "US", now = new Date()) {
  const m = MKT[mkt] || MKT.US;
  return isWeekday(now) && minutesUTC(now) >= m.open && minutesUTC(now) <= m.close;
}
// Data (AAAA-MM-DD) de "hoje" no fuso da bolsa.
function exchangeDate(mkt = "US", now = new Date()) {
  const m = MKT[mkt] || MKT.US;
  // EUA: usa UTC-5 como aproximação; o pregão (13h30-21h UTC) sempre cai no mesmo dia civil nos dois fusos.
  return new Date(now.getTime() + m.tzOffsetMin * MIN).toISOString().slice(0, 10);
}
// Instante (ms) em que o pregão da data "YYYY-MM-DD" terminou de vez.
function closeInstant(dateStr, mkt = "US") {
  const m = MKT[mkt] || MKT.US;
  return Date.parse(dateStr + "T00:00:00Z") + m.close * MIN;
}
// Minutos desde o fechamento de hoje (negativo antes de fechar; null fora de dia útil).
function minutesSinceClose(mkt = "US", now = new Date()) {
  if (!isWeekday(now)) return null;
  return minutesUTC(now) - (MKT[mkt] || MKT.US).close;
}

module.exports = { MKT, marketOpenNow, exchangeDate, closeInstant, minutesSinceClose };
