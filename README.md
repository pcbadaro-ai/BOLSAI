# Sinal Semanal (versão servidor)

O servidor fica ligado, recebe os preços da Binance em tempo real, refaz a análise a cada minuto em três horizontes (1 semana, 1 mês e 5 meses),
lê notícias e posts do X, pede a leitura da IA (Google Gemini) e avisa quando um sinal muda.

## Rodar no computador
1. Instale o Node 20 ou mais novo (nodejs.org).
2. Nesta pasta: `npm install`
3. Copie `.env.example` para `.env` e preencha só o que for usar.
4. `npm start` e abra http://localhost:3000
   - Para testar sem internet e sem chaves: `npm run mock`

## Publicar para abrir no celular de qualquer lugar
O servidor precisa ficar ligado o tempo todo. Planos grátis que dormem por inatividade (como o grátis do Render) param o monitoramento e os alertas.

**Render (mais simples)**
1. Coloque esta pasta num repositório do GitHub (pode ser privado).
2. No Render: New > Blueprint, escolha o repositório. Ele lê o `render.yaml`.
3. Preencha as variáveis pedidas (deixe em branco o que não for usar). Defina `ACCESS_TOKEN` com uma senha sua.
4. Abra `https://SEU-APP.onrender.com/?t=SUASENHA` no celular.

**Railway ou Fly.io**: aponte para o repositório. O `Dockerfile` já está pronto (comando `node server.js`, porta lida de `PORT`). Cadastre as mesmas variáveis no painel.

**Na sua rede**: abra `http://IP-DO-COMPUTADOR:3000` no celular, com o computador ligado.

Teste rápido depois de publicar: abra `/health`. Deve mostrar `ok:true`, `live:true` e `analisados` igual ao número de ativos.

## O que cada chave liga
| Variável | Liga | Custo |
|---|---|---|
| (nenhuma) | Cripto ao vivo, análise, notícias | grátis |
| GEMINI_API_KEY | Leitura da IA (Gemini) | conforme o plano da sua conta Google AI (cerca de 3 chamadas por hora por ativo; uma única chamada cobre os 3 horizontes) |
| X_BEARER_TOKEN | Posts do X | exige plano pago da API do X |
| TWELVEDATA_KEY | 20 maiores ações dos EUA por valor de mercado (preço com atraso de até 30 min) | plano grátis serve (cada rodada usa 20 das 800 consultas diárias) |
| TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID | Alerta no celular quando o sinal muda | grátis |

## Horizontes: 1 semana, 1 mês e 5 meses
Os botões do topo mudam o prazo da previsão. Cripto usa 7, 30 e 150 dias; ações usam 5, 21 e 105 pregões.
Quanto maior o prazo, menos janelas independentes existem no histórico, então o acerto fica mais difícil de comprovar. No horizonte de 5 meses a confiança quase sempre será "baixa" e o painel avisa isso. Leia como cenário, não como sinal.
Ações: AAPL, NVDA, MSFT, GOOGL, AMZN, TSM, TSLA, META, AVGO, LLY, BRK.B, MU, WMT, JPM, AMD, V, XOM, JNJ, ASML e MA (ranking por valor de mercado de 30/10/2026; a SpaceX, listada há pouco tempo, ficou de fora por falta de histórico). Para trocar, edite a lista `STOCKS` no `server.js`.

## Como ler os números (importante)
- **Nenhum modelo de mercado acerta 99,9%.** Em teste com dados puramente aleatórios o acerto fica perto de 50%. O painel só dá confiança alta quando o histórico comprova vantagem estatística.
- **Acerto do sinal** vem de teste no passado, usando em cada data só o que existia antes dela. Não garante o futuro.
- **Confiança** só sobe quando o acerto supera o do mercado com folga estatística (limite inferior de Wilson de 90%). Em dados puramente aleatórios, cerca de 5% dos ativos ainda recebem "Comprar" por sorte. Com 20 ativos, espere ver um ou outro sinal falso. Dê mais peso a confiança "alta" ou "média".
- **Horário**: o painel só destaca uma hora do dia se ela se distinguir do ruído (t >= 3). Na maior parte do tempo vai dizer que nenhuma se destaca, e isso é o resultado correto.
- O rótulo do sinal só muda depois de 3 análises seguidas (cerca de 3 minutos) e o Telegram avisa no máximo uma vez a cada 30 minutos por ativo.
- Preço de ações tem atraso de até 30 minutos (plano grátis da Twelve Data).

## Regras de segurança do código
- A IA só pode manter ou rebaixar o sinal estatístico, nunca melhorá-lo.
- Se o X ou a API falhar, o servidor pausa aquela fonte e segue com o resto.
- Nada aqui executa ordens de compra ou venda.
