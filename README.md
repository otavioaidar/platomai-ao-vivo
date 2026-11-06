# PlatomAI Ao Vivo

Notícias rápidas do mercado para o Brasil. O sistema vigia fontes oficiais, escreve a manchete em português (modelo fixo para números oficiais, IA para textos), publica no site em tempo real e envia às redes. Cada notícia oficial ganha o "PlatomAI explica" (uma frase) e o "PlatomAI decifra" (análise curta, aprovada com um clique). Manchetes de imprensa entram só com o título do veículo, o crédito e o link.

```
fontes oficiais ──► monitor (consulta de 2 s a 10 min) ─► redator ──► checagem ──► site ao vivo (SSE)
 BCB, Copom, IBGE,       mais rápido perto das              │             │           ├─► Telegram
 SIDRA, Fed, BCE         divulgações da agenda              │             │           ├─► Bluesky
                                                            │             │           └─► RSS próprio
                                         números oficiais: modelo fixo    números da manchete têm
                                         textos: Claude + linha editorial  que existir na fonte
```

## Rodar

Requer Node 24.5 ou mais novo.

```bash
npm install
cp .env.example .env    # opcional: chave da IA e das redes
npm start
```

Abra http://localhost:8080. Na primeira vez, o site mostra as últimas manchetes de cada fonte como histórico e passa a publicar o que surgir dali em diante.

Atrás de um proxy corporativo, use `npm run dev` (liga `NODE_USE_ENV_PROXY=1`); para os comandos abaixo, rode com `NODE_USE_ENV_PROXY=1` na frente (ex.: `NODE_USE_ENV_PROXY=1 npm run probe`).

Valores inválidos no `.env` não derrubam o site: o servidor avisa no log e usa o padrão. `POLL_SCALE` aceita vírgula (`0,5`).

Outros comandos:

| Comando | O que faz |
|---|---|
| `npm test` | Testes automatizados (parsers com dados reais salvos, redator, checagem, servidor) |
| `npm run typecheck` | Checagem de tipos |
| `npm run probe` | Consulta cada fonte uma vez e mostra o que encontrou, sem publicar |
| `npm run amostra` | Mostra como a IA escreveria as últimas notícias de cada fonte, sem publicar (salva em `data/`) |
| `npm run latencia` | Latência por fonte nos últimos 7 dias (`npm run latencia -- 3` para 3 dias): da publicação na fonte à detecção, e da detecção ao site |

## Fontes no ar

Horários de Brasília. As janelas rápidas ficam perto de quando a fonte costuma publicar, para chegar rápido sem sobrecarregar os servidores oficiais (os feeds do BCB não informam se mudaram, então cada consulta baixa o feed inteiro).

| Fonte | Como | Intervalo |
|---|---|---|
| Copom: comunicados | feed oficial do BCB | 5 min; 3 s às quartas, 18h–19h30 |
| Copom: atas | feed oficial do BCB | 10 min; 5 s às terças, 7h55–8h30 |
| BCB: notas à imprensa | feed oficial do BCB | 30 s |
| IBGE: releases de todos os indicadores | API de notícias do IBGE | 30 s; 3 s de 90 s antes a 15 min depois de cada divulgação da agenda |
| IPCA, IPCA-15, desemprego (PNAD) | API SIDRA; mediana Focus para o IPCA, buscada antes da divulgação | 2 min; 2 s na janela da divulgação, até sair o número |
| Agenda de divulgações | API de calendário do IBGE | 30 min (2 min enquanto não carregar) |
| Fed: política monetária e discursos | RSS oficial + texto da página | 20 s / 60 s |
| BCE: comunicados, discursos, entrevistas | RSS oficial + texto da página | 30 s |
| CVM: fatos relevantes | busca oficial do RAD/ENET da CVM + texto do PDF entregue pela empresa | 30 s; 10 s nos dias úteis, 6h30–8h30 e 17h30–20h30 |

Imprensa (título + crédito + link, sem IA): Agência Brasil (economia, política, internacional), InfoMoney, Poder360, g1 (economia e política) e Money Times, a cada 60 s (g1 a cada 3 min); a Folha existe mas fica desligada. Veja "Imprensa" abaixo.

`POLL_SCALE` multiplica os intervalos das fontes, inclusive os das janelas, nunca abaixo de 1 s (a agenda do IBGE não muda).

## Alpha Vantage (já assinada pela PlatomAI)

Com `ALPHAVANTAGE_API_KEY`, o sistema lê o NEWS_SENTIMENT a cada 2 min: notícias de política monetária, macro e fiscal, e de empresas brasileiras listadas nos EUA (PBR, VALE, ITUB, BBD, NU, XP, ERJ, SBS). As consultas vêm de `ALPHAVANTAGE_CONSULTAS`.

- **Licença:** a licença padrão da Alpha Vantage é pessoal e não comercial. Uso por empresa, ou por quem é gestor de recursos, conta como comercial e pede acordo por escrito (premium@alphavantage.co).
- **Modo `interno` (padrão):** as notícias vão só para a página privada de revisão. Não passam pela IA, não aparecem no site e não vão para as redes.
- **Modo `publico`:** use só com o acordo comercial que cubra exibição pública, reescrita por IA e redes. Mesmo assim, o texto original é de terceiros (Reuters, Benzinga, CNBC…): a manchete reescreve o fato, cita o veículo e linka a matéria.
- **Filtro de relevância:** as notas de relevância da Alpha Vantage são generosas, por isso o corte padrão é 0,8.

## CVM: fatos relevantes

Ligada por padrão (`CVM_FATOS=0` desliga). A cada 30 s (`CVM_INTERVALO_S`), o sistema consulta a busca de documentos da própria CVM (RAD/ENET) pelos fatos relevantes de hoje e de ontem. Para cada um novo, baixa o PDF entregue pela empresa e extrai o texto com o `pdftotext` (pacote poppler-utils, já instalado na imagem Docker; fora dela, instale com `apt-get install poppler-utils`). Sem o `pdftotext`, a manchete sai só com a empresa e o assunto. O link de cada manchete abre o documento no site da CVM.

Cuidados embutidos:

- **Bilíngues:** a maioria dos fatos relevantes vem em português e inglês. A IA e a checagem de números recebem só a parte em português; lido como português, "R$ 12.7 billion" viraria 127 bilhões. O documento só em inglês é marcado como inglês.
- **Reapresentação:** a versão substituída sai da lista, e a nova vira histórico no site, marcada como correção, sem alerta nas redes.
- **PDF indisponível:** a manchete sai na hora com a empresa e o assunto, sem esperar horas de novas tentativas.
- **CVM com captcha, sessão expirada ou formato novo:** a fonte aparece com falha em `/api/status`, em vez de parecer um dia sem fatos.

É fonte oficial e gratuita: o documento é da própria empresa, publicado pelo regulador. A manchete segue a régua de empresas da linha editorial: a empresa é a autora do fato, o "PlatomAI explica" fala do efeito no macro e nada vira recomendação.

## Partnr (em teste)

Com `PARTNR_API_KEY`, o sistema consulta a lista de notícias da Partnr a cada 15 s (`PARTNR_INTERVALO_S`) e busca o detalhe só das notícias novas.

- **Modo `interno` (padrão):** as notícias vão só para a página privada de revisão. Não passam pela IA, não aparecem no site e não vão para as redes.
- **Modo `publico`:** use só quando o contrato autorizar por escrito a exibição no site e nas redes. Mesmo assim, a notícia só vai para a IA se trouxer o veículo e o link da matéria original (a página inicial do veículo não serve) e se a relevância da Partnr for válida e passar de `PARTNR_RELEVANCIA_MIN` (padrão 0,5). As outras ficam na revisão, com o motivo. Enquanto o detalhe não carrega, a notícia nunca vai a público.
- **Sem sinal sobre ativos:** o campo de impacto positivo ou negativo por ativo nunca é lido. Para a IA vão só o texto (ou o resumo e os pontos-chave), os nomes dos ativos citados e o veículo.
- **O que a API manda de verdade:** a documentação pública não traz texto integral, veículo nem link. Se a resposta trouxer campos fora da documentação, o log mostra o nome deles uma vez (`Partnr: campos fora da documentação…`), e o sistema já usa texto integral, veículo e link quando eles vêm.
- **Na semana de teste:** rode `npm run latencia` para comparar a Partnr com as fontes oficiais (no Docker: `docker exec aovivo node --disable-warning=ExperimentalWarning scripts/latencia.ts`). Notícias que chegaram com mais de 6 h de atraso entram na conta; o histórico da primeira carga, não. `PARTNR_URL` troca o endereço da API, caso o contrato traga outro.

## Imprensa: título, crédito e link

- **O que entra:** só o título como o veículo escreveu, o nome do veículo ao lado e o link para a matéria. O texto da matéria nunca é guardado nem mostrado, e nada da imprensa vai para a IA ou para as redes. O título isolado não tem proteção autoral (Lei 9.610, art. 8º, VI); o texto tem, e vários veículos proíbem uso por IA.
- **O que fica de fora:** títulos com ticker da B3 (PETR4, BODB11: em geral, indicação de papel; fatos de empresas vêm dos fatos relevantes da CVM), recomendação, preço-alvo, "onde investir", publicidade, cupom, concurso, loteria e blogs "ao vivo". Em feeds gerais, só as seções de economia, política e mundo.
- **Uma vez por história:** a mesma notícia de outro veículo nas últimas 6 h (títulos com quase todas as palavras-chave em comum) não entra de novo.
- **No site:** etiqueta IMPRENSA, crédito "— InfoMoney" e link "ler ↗". Os filtros "Oficiais" e "Imprensa" separam as duas coisas.
- `IMPRENSA_FONTES` escolhe os veículos (`agenciabrasil`, `infomoney`, `poder360`, `g1`, `moneytimes`, `folha`; `nenhuma` desliga). A Agência Brasil fica só no título até a EBC confirmar a licença do texto.

## PlatomAI decifra

- **O que é:** para cada manchete oficial ao vivo (Copom, BCB, Fed, BCE, IBGE, CVM), o agente de `editorial/agente-analise.md` escreve título, subtítulo, Resumo, PlatomAI decifra, Impacto nos mercados e Mensagem-chave, ou responde `NÃO VALE TEXTO | motivo` quando a notícia não muda a leitura de mercado. Histórico, itens em revisão e imprensa não recebem decifra.
- **Checagem automática:** tetos de palavras do prompt (título 14, subtítulo 26, Resumo 60, decifra 75 em até 2 parágrafos, Impacto de 1 a 4 tópicos de até 16 palavras, Mensagem-chave 35, total 270), data no formato "4 de novembro de 2026", fonte citada no Resumo, todo número existindo no documento, expressões vetadas, qualquer coisa que pareça recomendação, "hoje/ontem" e trechos de 12 palavras copiados da fonte (fora de aspas). Se algo falhar, o agente reescreve uma vez com a lista de problemas; o que sobrar aparece em vermelho para quem revisa.
- **Publicação:** com `DECIFRA_PUBLICACAO=revisao` (padrão), todo texto espera "Aprovar e publicar" em `/revisao`; aprovado, ele aparece no site na hora, num quadro "PlatomAI decifra" abaixo da manchete. Com `automatica`, o texto que passa em todas as checagens vai direto. "Copiar texto" leva o texto no formato do agente para os outros apps.
- **Nada se perde:** cada decifra entra numa fila no banco junto com a manchete. Falha da API é tentada de novo 1, 2, 4 e 8 min depois; um reinício retoma a fila. O decifra roda separado do redator: uma análise lenta nunca atrasa uma manchete.
- **Custo:** Opus 5.5 com esforço médio e pensamento adaptativo; o prompt fica em cache. `DECIFRA_FONTES` limita as fontes (a CVM pode ter dezenas de fatos relevantes por dia).

## Página privada de revisão

`/revisao` lista o que não foi para o site: os textos do PlatomAI decifra esperando aprovação (com os botões "Aprovar e publicar", "Descartar" e "Copiar texto"), as respostas NÃO VALE TEXTO do agente, manchetes que falharam na checagem, itens que a IA recusou e fontes de uso interno. Defina `REVIEW_TOKEN` e entre por `https://<site>/revisao#t=<token>`. A página não é indexada, e os dados e as ações só funcionam com o token (`Authorization: Bearer`).

## Como a IA escreve

- **Números oficiais não passam pela IA.** IPCA, IPCA-15 e desemprego saem de um modelo fixo, direto dos dados do IBGE. O IPCA é comparado com a mediana do Focus; o desemprego, com o trimestre anterior sem sobreposição, como o IBGE faz. A IA só acrescenta depois o "PlatomAI explica".
- **Textos** (Copom, notas, Fed, BCE, releases) são lidos pelo Claude, que decide se vira manchete, a urgência e escreve a manchete em português. O pedido usa saída estruturada (JSON validado), pensamento adaptativo, esforço configurável e fallback no servidor quando o modelo recusa.
- **Checagem automática:** todo número da manchete precisa existir na fonte, com a mesma unidade, escala e sinal (aceita só conversões explícitas, como 25 pb = 0,25 p.p. e 3-3/4 = 3,75). Se falhar, ou se a manchete passar de 240 caracteres, ela vai para `revisar`: não aparece no site (a menos que `SHOW_REVIEW=1`) e não vai para as redes.
- **Nada se perde:** cada item novo entra numa fila no banco antes de ser escrito. Se a IA falhar ou o servidor reiniciar, ele é tentado de novo (15 s, 30 s, 1 min… até 30 min de intervalo). Depois de 6 h sem sucesso, ou se a IA recusar o item, ele fica em `revisar` com o título original da fonte.
- **Notícia velha não dispara alerta:** item que chega com mais de 6 h (por exemplo, depois de o servidor ficar fora do ar) entra no site como histórico, sem bipe nem notificação, e não vai para as redes.
- **Linha editorial:** `editorial/linha-editorial.md` diz o que cobrir, o que destacar e o que ignorar. A IA lê esse arquivo em toda manchete e o servidor recarrega quando ele muda. É aqui que a gente direciona a cobertura. Os fatos sempre vêm da fonte.
- **PlatomAI decifra:** `editorial/agente-analise.md` é o prompt do agente de análise (veja "PlatomAI decifra" acima). O servidor recarrega o arquivo quando ele muda.
- **Chave da IA:** `PLATOMAI_ANTHROPIC_API_KEY` é a chave do app; com ela, o servidor ignora as variáveis `ANTHROPIC_*` da máquina (um ambiente de desenvolvimento pode ter as suas).

## Endereços

| Caminho | Conteúdo |
|---|---|
| `/` | Site ao vivo |
| `/api/headlines?limit=150` | Últimas manchetes (JSON) |
| `/api/stream` | Fluxo ao vivo (Server-Sent Events: `headline`, `update`, `ping`) |
| `/api/agenda` | Agenda de divulgações |
| `/api/status` | Saúde das fontes e da IA |
| `/rss.xml` | RSS próprio |
| `/revisao` | Fila de revisão privada (precisa de `REVIEW_TOKEN`) |
| `POST /api/revisao/decifra/<id>/aprovar` e `/descartar` | Aprova ou descarta um decifra (com o token) |
| `/healthz` | Saúde do processo (usado pelo HEALTHCHECK do Docker) |

## Estrutura

```
src/
  main.ts            liga tudo
  config.ts          variáveis de ambiente
  pipeline.ts        consulta → novo? → escreve → checa → publica → envia
  sources/feeds.ts   RSS/Atom (BCB, Copom, Fed, BCE)
  sources/cvm.ts     fatos relevantes da CVM (RAD/ENET + texto do PDF)
  sources/alphavantage.ts, sources/partnr.ts  feeds de notícias pagos (uso interno por padrão)
  sources/press.ts   imprensa: título + crédito + link, filtros e uma vez por história
  latency.ts         latência por fonte (npm run latencia)
  sources/ibge.ts    agenda, releases e SIDRA (+ Focus)
  writer/ai.ts       redator Claude e modo rascunho
  writer/decifra.ts  PlatomAI decifra: agente, formato e checagens
  writer/templates.ts modelos fixos para números oficiais
  writer/guard.ts    checagem de números
  publishers/        Telegram e Bluesky
  server.ts, hub.ts  HTTP, SSE, RSS, revisão
  view.ts            o que o público vê de cada manchete
public/              site (HTML/CSS/JS, sem build)
editorial/           linha editorial (redator) e prompt do agente de análise (decifra)
certs/               certificado intermediário que o servidor do IBGE não envia
```

## Colocar no ar

Numa VM com Docker. A imagem usa Node 24 (24.5 ou mais novo), roda sem root e responde em `/healthz` para o Docker saber se o site está de pé.

```bash
cp .env.example .env    # preencha as chaves e o SITE_URL
docker build --pull -t platomai-ao-vivo .
docker run -d --name aovivo --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --env-file .env -e DB_PATH=/data/aovivo.db \
  -v aovivo-data:/data \
  -v "$PWD/editorial:/app/editorial:ro" \
  --cap-drop ALL --security-opt no-new-privileges \
  platomai-ao-vivo
```

- **`SITE_URL`** tem que ser o endereço público com https (ex.: `https://aovivo.exemplo.com.br`). É o link que vai no Telegram, no Bluesky e no RSS.
- **Banco:** fica no volume `aovivo-data` e sobrevive a `docker rm` e a imagens novas. É o histórico de tudo o que foi publicado: faça backup dele.
- **Linha editorial:** vem da pasta `editorial/` da VM. Edite `linha-editorial.md` ali e a próxima manchete já usa o texto novo, sem refazer a imagem.
- **Porta:** a 8080 só abre em 127.0.0.1 na VM. Quem vem de fora passa pelo proxy com HTTPS.

Na frente, um proxy com HTTPS. O Caddy emite o certificado sozinho; o `/etc/caddy/Caddyfile` fica assim:

```
aovivo.exemplo.com.br {
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
```

No Nginx, desligue o buffer em `/api/stream` (`proxy_buffering off;`) para o ao vivo não atrasar e repasse o IP de quem acessa (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). O servidor aceita até 2000 conexões ao vivo, 20 por IP (`SSE_MAX_CLIENTS`, `SSE_MAX_PER_IP`); sem esse cabeçalho, só o limite total vale.
