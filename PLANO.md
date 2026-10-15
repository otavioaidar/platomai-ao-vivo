# Plano do MVP: PlatomAI Ao Vivo

Dupla: **Otávio Aidar** (editor-chefe e dono do produto) + **Claude Code** (engenharia e redação via API). Sem equipe contratada.

## A ideia em uma frase
Ser, para o mercado brasileiro, o que FinancialJuice e investingLive são lá fora: a manchete do dado oficial na tela em segundos, em português claro, com o "PlatomAI explica" para quem está começando. Inspirados neles, sem copiar ninguém: nossas fontes são as oficiais e o texto é nosso.

## Quem faz o quê

| Otávio | Claude Code |
|---|---|
| Linha editorial (`editorial/linha-editorial.md`): o que cobrir, o que destacar, o que ignorar | Código, fontes novas, testes, deploy e monitoramento |
| Avaliar as manchetes da primeira semana e ajustar a linha | Redação automática via API do Claude, com checagem de números |
| Revisar o que cair em `revisar` | Medir a velocidade (fonte → site) e corrigir gargalos |
| Marca, canais, comunidade, parceiros | Integração com Telegram, Bluesky, X, áudio |

## Cronograma

| Quando | Entrega |
|---|---|
| **Semana 1 (feito)** | MVP rodando: BCB, Copom, IBGE (releases, SIDRA, agenda), Focus, Fed, BCE → IA → site ao vivo → Telegram/Bluesky (em simulação até ter as credenciais). Revisão independente em 3 rodadas, 184 testes passando. |
| Semana 2 | No ar: servidor, domínio, HTTPS. Chave da API do Claude, canal no Telegram, conta no Bluesky. Uma semana de manchetes reais para calibrar a linha editorial. Página de revisão para o Otávio. |
| Semanas 3–4 | Mais fontes: Tesouro (leilões, resultado primário), BCB SGS (IBC-Br, fluxo cambial), dados dos EUA (CPI, payroll), agenda do Copom e do Fed. Conta no X. |
| Mês 2 | Beta aberto. App instalável (PWA) com notificação. Medição de velocidade contra os sites de fora. Áudio (squawk em voz sintética) como teste. |
| Mês 3 | Plano pago: alertas por tema, áudio ao vivo, API. Pagamento por Pix e cartão. |

## Custo mensal (sem salários)

Premissas: US$ 1 = R$ 5,05; Claude Opus 5.5 a US$ 4 / US$ 20 por milhão de tokens; cerca de 3.500 tokens de entrada e 700 de saída por item lido, o que dá **~US$ 0,03 (R$ 0,15) por item**.

| Item | Fase 1: fontes de hoje (~30 itens/dia) | Fase 3: ~300 itens/dia |
|---|---|---|
| IA (Claude) | R$ 90–180 | R$ 1.350 |
| Servidor (1 VM) | R$ 30–60 | R$ 60–200 |
| Telegram, Bluesky, RSS | grátis | grátis |
| X (opcional, US$ 0,015 por post só texto) | R$ 0–90 | R$ 90–230 |
| Domínio | ~R$ 4 (R$ 40/ano) | ~R$ 4 |
| **Total** | **~R$ 125–335** | **~R$ 1,5–1,8 mil** |

Únicos: revisão jurídica (termos de uso, LGPD, enquadramento na CVM) de R$ 8–40 mil; registro da marca no INPI de R$ 1–3 mil (opcional no começo).

**Empate:** a R$ 29,90/mês, sobram ~R$ 27,15 por assinante depois das taxas de pagamento (~9,2%). Na Fase 1, bastam **5 a 13 assinantes**; na Fase 3, **56 a 66**.

Para reduzir o custo da IA, dá para trocar o modelo em `AI_MODEL` (por exemplo, Claude Sonnet 5.5 ou Haiku 5.5), medindo antes se a qualidade se mantém.

## "Direcionar para o que queremos mostrar"

A direção vale para **escolher e destacar**: o que vira manchete, o que é urgente, o que ignorar, o tom. Tudo isso está na linha editorial e muda quando o Otávio edita o arquivo. **Os fatos nunca são direcionados**: todo número da manchete precisa existir na fonte, ou ela não sai.

Cuidados que valem desde o primeiro dia:
- Divulgar informação falsa ou enganosa para mexer com preço é crime (Lei 6.385, art. 27-C). A checagem automática e o registro de fonte, horário e texto de cada manchete no banco são a nossa defesa.
- Como gestor (Ujay), o Otávio deve evitar decidir a cobertura de ativos que a gestora opera, ou registrar e divulgar esse conflito. Vale levar à revisão jurídica.
- Manchete e "PlatomAI explica" não podem virar recomendação de compra ou venda; isso é regra de analista (CVM Res. 20). O rodapé do site já avisa.
- Usamos só fontes oficiais e públicas, com texto próprio. A lei protege o texto das agências, não o fato.
- Antes de cobrir empresas listadas com dados da B3, ler a nova política de dados de mercado da B3 (vale a partir de 01/11/2026).

## O que precisamos agora

1. **Repositório no GitHub** para guardar o código (o ambiente na nuvem é temporário).
2. **Chave da API do Claude** (console da Anthropic) para ligar a redação por IA.
3. **Bot do Telegram** (token pelo @BotFather) e o canal onde ele publica.
4. **Bluesky**: usuário e senha de app.
5. **Onde hospedar**: uma VM simples (Lightsail, Hetzner, Oracle) resolve a Fase 1.
