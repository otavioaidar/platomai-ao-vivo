# PlatomAI Ao Vivo

Notícias rápidas do mercado para o Brasil. O sistema vigia fontes oficiais, escreve a manchete em português (modelo fixo para números oficiais, IA para textos), publica no site em tempo real e envia às redes.

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

`POLL_SCALE` multiplica os intervalos das fontes, inclusive os das janelas, nunca abaixo de 1 s (a agenda do IBGE não muda).

## Como a IA escreve

- **Números oficiais não passam pela IA.** IPCA, IPCA-15 e desemprego saem de um modelo fixo, direto dos dados do IBGE. O IPCA é comparado com a mediana do Focus; o desemprego, com o trimestre anterior sem sobreposição, como o IBGE faz. A IA só acrescenta depois o "PlatomAI explica".
- **Textos** (Copom, notas, Fed, BCE, releases) são lidos pelo Claude, que decide se vira manchete, a urgência e escreve a manchete em português. O pedido usa saída estruturada (JSON validado), pensamento adaptativo, esforço configurável e fallback no servidor quando o modelo recusa.
- **Checagem automática:** todo número da manchete precisa existir na fonte, com a mesma unidade, escala e sinal (aceita só conversões explícitas, como 25 pb = 0,25 p.p. e 3-3/4 = 3,75). Se falhar, ou se a manchete passar de 240 caracteres, ela vai para `revisar`: não aparece no site (a menos que `SHOW_REVIEW=1`) e não vai para as redes.
- **Nada se perde:** cada item novo entra numa fila no banco antes de ser escrito. Se a IA falhar ou o servidor reiniciar, ele é tentado de novo (15 s, 30 s, 1 min… até 30 min de intervalo). Depois de 6 h sem sucesso, ou se a IA recusar o item, ele fica em `revisar` com o título original da fonte.
- **Notícia velha não dispara alerta:** item que chega com mais de 6 h (por exemplo, depois de o servidor ficar fora do ar) entra no site como histórico, sem bipe nem notificação, e não vai para as redes.
- **Linha editorial:** `editorial/linha-editorial.md` diz o que cobrir, o que destacar e o que ignorar. A IA lê esse arquivo em toda manchete e o servidor recarrega quando ele muda. É aqui que a gente direciona a cobertura. Os fatos sempre vêm da fonte.

## Endereços

| Caminho | Conteúdo |
|---|---|
| `/` | Site ao vivo |
| `/api/headlines?limit=150` | Últimas manchetes (JSON) |
| `/api/stream` | Fluxo ao vivo (Server-Sent Events: `headline`, `update`, `ping`) |
| `/api/agenda` | Agenda de divulgações |
| `/api/status` | Saúde das fontes e da IA |
| `/rss.xml` | RSS próprio |
| `/healthz` | Saúde do processo (usado pelo HEALTHCHECK do Docker) |

## Estrutura

```
src/
  main.ts            liga tudo
  config.ts          variáveis de ambiente
  pipeline.ts        consulta → novo? → escreve → checa → publica → envia
  sources/feeds.ts   RSS/Atom (BCB, Copom, Fed, BCE)
  sources/ibge.ts    agenda, releases e SIDRA (+ Focus)
  writer/ai.ts       redator Claude e modo rascunho
  writer/templates.ts modelos fixos para números oficiais
  writer/guard.ts    checagem de números
  publishers/        Telegram e Bluesky
  server.ts, hub.ts  HTTP, SSE, RSS
public/              site (HTML/CSS/JS, sem build)
editorial/           linha editorial lida pela IA
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
