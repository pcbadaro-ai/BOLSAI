"use strict";
// Roda a análise pesada fora da thread principal para não atrasar os preços ao vivo.
const { parentPort } = require("worker_threads");
const { analyze } = require("./analysis");
parentPort.on("message", ({ id, closes, H, price }) => {
  try { parentPort.postMessage({ id, result: analyze(closes, H, price) }); }
  catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
