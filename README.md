# PlatomAI Ao Vivo

Notícias rápidas do mercado para o Brasil. O sistema vigia fontes oficiais, escreve a manchete em português (modelo fixo para números oficiais, IA para textos), publica no site em tempo real e envia às redes.

```
fontes oficiais ──► monitor (consulta a cada 2–120 s) ──► redator ──► checagem ──► site ao vivo (SSE)
 BCB, Copom, IBGE,       mais rápido perto das              │             │           ├─► Telegram
 SIDRA, Fed, BCE         divulgações da agenda              │             │           ├─► Bluesky
                                                            │             │           └─► RSS próprio
                                         números oficiais: modelo fixo    números da manchete têm
                                         textos: Claude + linha editorial  que existir na fonte
```

## Rodar

Requer Node 24.

```bash
npm install
cp .env.example .env    # opcional: chave da IA e das redes
npm start
```

Abra http://localhost:8080. Na primeira vez, o site mostra as últimas manchetes de cada fonte como histórico e passa a publicar o que surgir dali em diante.

Atrás de um proxy corporativo, use `npm run dev` (liga `NODE_USE_ENV_PROXY=1`).

Outros comandos:

| Comando | O que faz |
|---|---|
| `npm test` | Testes automatizados (parsers com dados reais salvos, redator, checagem, servidor) |
| `npm run typecheck` | Checagem de tipos |
| `npm run probe` | Consulta cada fonte uma vez e mostra o que encontrou, sem publicar |

## Fontes no ar

| Fonte | Como | Intervalo |
|---|---|---|
| Copom: comunicados e atas | feed oficial do BCB | 15 s / 30 s |
| BCB: notas à imprensa | feed oficial do BCB | 20 s |
| IBGE: releases de todos os indicadores | API de notícias do IBGE | 30 s, 3 s em dia de divulgação |
| IPCA, IPCA-15, desemprego (PNAD) | API SIDRA, com mediana Focus para o IPCA | 2 min, 2 s na janela da divulgação |
| Agenda de divulgações | API de calendário do IBGE | 30 min |
| Fed: política monetária e discursos | RSS oficial + texto da página | 20 s / 60 s |
| BCE: comunicados, discursos, entrevistas | RSS oficial + texto da página | 30 s |

## Como a IA escreve

- **Números oficiais não passam pela IA.** IPCA, IPCA-15 e desemprego saem de um modelo fixo, direto dos dados do IBGE, comparados com a mediana do Focus. A IA só acrescenta depois o "PlatomAI explica".
- **Textos** (Copom, notas, Fed, BCE, releases) são lidos pelo Claude, que decide se vira manchete, a urgência e escreve a manchete em português. O pedido usa saída estruturada (JSON validado), pensamento adaptativo, esforço configurável e fallback no servidor quando o modelo recusa.
- **Checagem automática:** todo número da manchete precisa existir na fonte (aceita conversões como 25 pb = 0,25 p.p. e 3-3/4 = 3,75). Se falhar, a manchete vai para `revisar`, não aparece no site e não vai para as redes.
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
