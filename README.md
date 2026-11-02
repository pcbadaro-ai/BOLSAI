# Sinal Semanal (versão servidor)

O servidor fica ligado, recebe os preços da Binance em tempo real, refaz a análise a cada minuto,
lê notícias e posts do X, pede a leitura da IA (Claude) e avisa quando um sinal muda.

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
| ANTHROPIC_API_KEY | Leitura da IA | pago por uso (cerca de 3 chamadas por hora por ativo) |
| X_BEARER_TOKEN | Posts do X | exige plano pago da API do X |
| TWELVEDATA_KEY | 10 maiores ações (preço com atraso de até 30 min) | plano grátis serve |
| TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID | Alerta no celular quando o sinal muda | grátis |

## Como ler os números (importante)
- **Acerto do sinal** vem de teste no passado, usando em cada data só o que existia antes dela. Não garante o futuro.
- **Confiança** só sobe quando o acerto supera o do mercado com folga estatística (limite inferior de Wilson de 90%). Em dados puramente aleatórios, cerca de 5% dos ativos ainda recebem "Comprar" por sorte. Com 20 ativos, espere ver um ou outro sinal falso. Dê mais peso a confiança "alta" ou "média".
- **Horário**: o painel só destaca uma hora do dia se ela se distinguir do ruído (t >= 3). Na maior parte do tempo vai dizer que nenhuma se destaca, e isso é o resultado correto.
- O rótulo do sinal só muda depois de 3 análises seguidas (cerca de 3 minutos) e o Telegram avisa no máximo uma vez a cada 30 minutos por ativo.
- Preço de ações tem atraso de até 30 minutos (plano grátis da Twelve Data).

## Regras de segurança do código
- A IA só pode manter ou rebaixar o sinal estatístico, nunca melhorá-lo.
- Se o X ou a API falhar, o servidor pausa aquela fonte e segue com o resto.
- Nada aqui executa ordens de compra ou venda.
