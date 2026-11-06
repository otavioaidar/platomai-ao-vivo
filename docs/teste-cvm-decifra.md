# Teste do PlatomAI decifra com fatos relevantes da CVM (6/11/2026)

## Resumo

- **Volume:** 73 fatos relevantes em 8 dias úteis (27/10 a 5/11/2026), cerca de 9 por dia.
- **Filtro adotado:** decifra só para os que o redator de manchetes marca como urgência "alta" ou "urgente", seguindo a linha editorial (`DECIFRA_CVM_URGENCIA=alta`).
  - Esse corte pegou os 13 fatos que a classificação cega considerou de alta relevância (13 de 13) e deixou de fora 48 dos 73.
  - Depois de tirar os duplicados, sobram cerca de 2 a 3 por dia.
- **Decisão do agente:** nos 21 fatos novos de 4 e 5/11, o agente escreveu 7 textos e respondeu NÃO VALE TEXTO em 14.
  - Os juízes concordaram com a decisão em 20 dos 21.
  - O único erro (texto sobre o dividendo trimestral da Aura) já fica de fora pelo corte de urgência.
- **Prompt v2.4:** nos 7 fatos que passam pelo corte, as inferências sem base caíram de 19 para 9 e os textos centrados na empresa (em vez do macro) de 5 para 1. Não houve nenhuma decisão errada.
- **Revisão humana continua necessária:** os textos ainda trazem de 0 a 4 inferências sutis por texto, como exagerar o alcance ou generalizar o caso de uma empresa para o setor. As checagens automáticas não pegam esse tipo de erro.

## Como foi feito

1. **Coleta.** O script baixou os fatos relevantes da busca oficial da CVM (RAD/ENET), com o texto do PDF, do mesmo jeito que o app faz, inclusive o corte em 6.000 caracteres.
2. **Agente.** Os 21 fatos novos de 4 e 5/11 passaram pelo agente com o prompt `editorial/agente-analise.md` e a mensagem exata que o app monta. Ficaram de fora 3 reapresentações e 1 duplicado.
3. **Juízes.** Cada resposta teve um juiz independente, que avaliou fatos, compliance, relevância e a decisão de escrever ou não, com as regras do prompt v2.3.
4. **Classificação cega.** Os 73 fatos foram classificados por relevância (alta, média ou baixa) sem que o classificador visse a resposta do agente.
5. **Redator.** O redator de manchetes foi simulado com o prompt exato do app nos 73 fatos, para medir a urgência que ele daria a cada um.
6. **Limitação.** Tudo rodou pelo Claude Code, com o mesmo modelo e o mesmo prompt, e não pela API do app, porque a chave ainda não está no ambiente. Custo e tempo reais ficam para o teste com a chave.

## Quais fatos relevantes são de fato relevantes

Relevância na classificação cega: 13 alta, 30 média, 30 baixa.

| Relevância (classificação cega) | Recebe decifra (urgência alta) | Fica só com a manchete | Descartado pelo redator |
|---|---|---|---|
| alta | 13 | 0 | 0 |
| média | 8 | 22 | 0 |
| baixa | 4 | 18 | 8 |

Os 4 de relevância baixa que passavam eram todos duplicados, e o app agora descarta os três tipos:

- **A mesma empresa entregando o mesmo documento duas vezes.** Lojas Renner, protocolos 1584842 e 1584843.
- **Fato relevante conjunto, com o mesmo PDF entregue pelas duas empresas.** Sabesp e EMAE; Raízen e Raízen Energia.
- **As duas partes de uma OPA.** Helbor e HBR: os textos são diferentes, mas o redator vê a primeira manchete em "Manchetes recentes".

Os 13 de relevância alta:

| Data | Empresa | Assunto |
|---|---|---|
| 04/11 | Aeris | Pedido de recuperação extrajudicial |
| 05/11 | Porto Seguro | Modificação de projeções divulgadas |
| 05/11 | NTS | Medida judicial contra deliberação da ANP |
| 05/11 | Lojas Renner | Modificação de projeções divulgadas |
| 05/11 | Suzano | Atualização de projeções |
| 28/10 | Raízen | Transação tributária federal |
| 28/10 | Elfa Medicamentos | Pedido de tutela cautelar |
| 30/10 | CSN | Acordo de exclusividade para alienação |
| 30/10 | Raízen | Deliberações das assembleias |
| 30/10 | Oncoclínicas | Adesão ao plano de recuperação extrajudicial |
| 03/11 | Yduqs | Protocolo da combinação de negócios |
| 03/11 | Itaú Unibanco | Projeções 2026 |
| 03/11 | BB Seguridade | Modificação de projeções divulgadas |

Para mudar o que conta como relevante, edite a seção "Urgência" de `editorial/linha-editorial.md`. O redator segue esse arquivo, e o corte do decifra segue o redator.

## O que o agente fez (21 fatos novos de 4 e 5/11)

| Empresa | Agente (v2.3) | Juiz: decisão certa? |
|---|---|---|
| Aeris (recuperação extrajudicial) | texto | sim |
| Lavvi (data de pagamento de dividendos) | não vale texto | sim |
| Caramuru (acordo de acionistas) | não vale texto | sim |
| Oncoclínicas (adesão ao plano) | não vale texto | sim |
| Porto Seguro (projeções, sem os números no documento) | não vale texto | sim |
| Engie (incorporação de subsidiária integral) | não vale texto | sim |
| NTS (ação contra a ANP) | texto | sim |
| Sabesp (JCP) | não vale texto | sim |
| Lojas Renner (retira projeção de receita) | texto | sim |
| BMG (JCP trimestral) | não vale texto | sim |
| Aura (resultado do 3T26) | não vale texto | sim |
| Aura (dividendo trimestral) | texto | **não** (era NÃO VALE TEXTO) |
| Prática (listagem na Espanha) | não vale texto | sim |
| Light (formador de mercado) | não vale texto | sim |
| Azevedo & Travassos (formador de mercado) | não vale texto | sim |
| Allos (projeção de dividendos) | não vale texto | sim |
| Kora Saúde (homologação do plano) | texto | sim |
| Iguatemi (Four Seasons) | texto | sim |
| Suzano (custo caixa revisto) | texto | sim |
| Grendene (recompra) | não vale texto | sim |
| Sendas (recompra) | não vale texto | sim |

## Ajuste do prompt (v2.3 para v2.4)

O teste comparou as duas versões nos 7 fatos que passam pelo corte de urgência, com os mesmos juízes e as mesmas regras de julgamento.

| | v2.3 | v2.4 |
|---|---|---|
| Decisões certas | 7 de 7 | 7 de 7 |
| Textos escritos | 6 | 5 (Iguatemi passou a NÃO VALE TEXTO, e o juiz concordou) |
| Afirmações sem base no material | 19 | 9 |
| Análise centrada na empresa em vez do macro | 5 | 1 |
| Nota média dos textos (1 a 5) | 3,2 | 3,2 |

A v2.4 acrescenta ao guia "Empresas e fatos relevantes" uma regra para cada erro que os juízes encontraram:

- **Efeito além da empresa.** O texto parte de um efeito além da empresa que o material mostra. O motivo que a própria empresa dá (economia, setor, regulação) conta como esse efeito. Sem efeito além da empresa, a resposta é NÃO VALE TEXTO.
- **Declaração da empresa.** O que a empresa declara entra atribuído a ela, nunca como fato.
- **Projeção.** Projeção não é resultado ocorrido.
- **Lei e norma.** O texto não completa o material com o que a lei ou a norma preveem.
- **Porcentagem.** Toda porcentagem vem com a base que o material dá.
- **Intensidade.** Nada de "choque" ou "crise" se a fonte não usar essas palavras.
- **Rótulo de setor.** O Impacto só usa rótulo de setor para efeito no setor.
- **Data.** A data do fato é a do documento. A data de entrega à CVM pode ser posterior.

A amostra é pequena (7 fatos, uma rodada cada). A direção foi a mesma nas duas rodadas, mas vale acompanhar a v2.4 nas primeiras semanas pela página de revisão.

## Exemplo de texto da v2.4 (NTS, nota 4 de 5)

> **Com valor de investimentos já feitos em disputa, NTS põe os novos em espera**
>
> A transportadora liga a decisão da ANP à sua capacidade de investir e, mais adiante e sob condições, de honrar obrigações financeiras.
>
> 5 de novembro de 2026
>
> **Resumo.** Segundo fato relevante da NTS, transportadora de gás, o conselho de administração aprovou ação judicial contra a decisão nº 733/2026 da ANP, que reduz a base de ativos da Malha Sudeste, caso recursos administrativos ou acordo não a revertam. A empresa contesta o método, que considera retroativo, e ressalta que a decisão vale só para esse contrato.
>
> **PlatomAI decifra.** Na infraestrutura regulada, a base de ativos define a remuneração; se o critério para avaliar o já investido muda, o retorno de projetos novos fica incerto. O processo pode nem ser aberto; a suspensão de novos investimentos, salvo os de segurança, já foi aprovada.
>
> A disputa olha pelo retrovisor, mas o pé já saiu do acelerador.
>
> **Impacto nos mercados.** Credores: NTS vê risco a obrigações a partir de 2030 só com três condições somadas até 2029.
>
> **Mensagem-chave.** O ponto a acompanhar é a revisão tarifária do próximo ciclo: se ela aplicar o mesmo método aos contratos que vencem entre 2030 e 2031, a disputa deixa de ser sobre um contrato só.

O juiz apontou só uma afirmação forçada, no subtítulo: "capacidade de investir". A empresa fala em suspender as aprovações "por prudência", não em perder capacidade.

## Mudanças no app a partir do teste

- **Corte de urgência.** Decifra de fato relevante só a partir da urgência "alta" (`DECIFRA_CVM_URGENCIA`).
- **Duplicados.** O mesmo fato relevante entregue duas vezes, ou o fato relevante conjunto com o mesmo PDF, vira uma notícia só.
- **Arredondamento.** A checagem aceita número arredondado com "cerca de", como o prompt permite, e só quando a fonte tem o valor exato (até 5% de diferença). Os 2 alarmes falsos do teste sumiram.
- **Data.** O agente recebe a data de entrega à CVM com esse nome. A data do fato é a do documento.

## Em aberto

- **Corte do PDF.** 17 dos 73 PDFs passam do limite de 6.000 caracteres que o app manda ao redator e ao decifra. Nenhum juiz apontou fato faltando, mas os juízes também só viam o texto cortado. Se aparecer um caso assim na revisão, dá para aumentar o limite (o custo extra é pequeno).
- **Custo e tempo reais.** Precisam da chave do app: o teste com a API mede tokens, custo por decifra e quanto tempo cada um leva.
