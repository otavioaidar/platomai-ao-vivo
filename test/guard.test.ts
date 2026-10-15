import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { decodeEntities, htmlToText } from "../src/text.ts";
import { unsupportedNumbers } from "../src/writer/guard.ts";

/** Title and body of every statement in the real BCB Copom feed, as the source gives them to the guard. */
function copomStatements(): string[] {
  const xml = fs.readFileSync(new URL("./fixtures/bcb-copom.xml", import.meta.url), "utf8");
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? "");
    const body = htmlToText(decodeEntities(/<content[^>]*>([\s\S]*?)<\/content>/.exec(e)?.[1] ?? ""));
    return `${title}\n${body}`;
  });
}

const FED_CUT = "The Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.";
const FED_HOLD = "The Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent. Growth slowed in the first half of the year.";
const ECB_CUT =
  "The Governing Council today decided to lower the three key ECB interest rates by 25 basis points. The deposit facility rate will be decreased to 2.00%, with effect from 11 June 2026.";
const ECB_HOLD = "The Governing Council kept the three key ECB interest rates unchanged. Inflation stood at 2.2% in the second quarter.";
const COPOM_OLD = "O Copom decidiu reduzir a taxa Selic em 0,50 ponto percentual, para 13,25% a.a.";
const IPCA_NEWS = "Publicado em 10/10/2026. O IPCA de setembro foi de 0,48%, após -0,11% em agosto. Em 12 meses, o índice acumula 5,17%.";
const PNAD_NEWS = "A taxa de desocupação ficou em 5,6% no trimestre encerrado em agosto. A população ocupada chegou a 102,4 milhões.";
const TESOURO = "O Tesouro captou R$ 12,4 bilhões no leilão de hoje.";

/** [headline, source, source language, numbers the guard must flag]. An empty list means the headline passes. */
const CASES: [string, string, "pt" | "en", string[]][] = [
  // Fed
  ["Fed corta juros em 0,25 p.p., para a faixa de 3,75% a 4,00%", FED_CUT, "en", []],
  ["Fed corta juros em 25 pb", FED_CUT, "en", []],
  ["Fed corta juros em 0,50 p.p.", FED_CUT, "en", ["0,50"]],
  ["Fed mantém juros entre 3,75% e 4,00%", FED_HOLD, "en", []],
  ["Fed corta juros em 0,50 p.p.", FED_HOLD, "en", ["0,50"]], // "first half of the year" is not a cut size
  ["Fed corta juros em 0,25%", FED_CUT, "en", ["0,25"]], // % is not p.p.
  ["Fed corta juros em 0,25 p.p.", "lowered the rate by a quarter percentage point", "en", []],
  ["Fed corta juros em 0,50 p.p.", "lowered the rate by half a percentage point", "en", []],
  ["Fed corta juros em 0,75 p.p.", "lowered the rate by three-quarters of a percentage point", "en", []],
  ["Fed: desemprego vai a 4,3%", "the unemployment rate edged up to 4.3 percent", "en", []],
  ["Fed: desemprego vai a 43%", "the unemployment rate edged up to 4.3 percent", "en", ["43"]],
  // Rate phrases need an article or "percentage"; bare "points" in the source are not p.p.
  ["BCE corta juros em 0,25 p.p.", "Survey indicators for the third quarter point to weaker growth.", "en", ["0,25"]],
  ["BCE corta juros em 0,50 p.p.", "Growth in the first half point to a slowdown.", "en", ["0,50"]],
  ["Fed corta juros em 0,25 p.p.", "lowered the rate by a quarter-point", "en", []],
  ["Copom eleva Selic em 3 p.p.", "O Copom destaca 3 pontos de atenção no cenário.", "pt", ["3"]],
  ["Fed eleva juros em 10 p.p.", "The Fed presented a 10-point plan.", "en", ["10"]],
  ["Fed eleva juros em 1/4 de ponto", FED_CUT, "en", []],
  ["Copom reduz Selic em meio ponto", "O Copom decidiu reduzir a Selic em 0,50 ponto percentual.", "pt", []],
  // Weekdays and "segundo o" are not ordinals; "cede" is a fall word.
  ["Copom: 4 diretores votam pela alta", "A reunião terminou nesta quarta-feira.", "pt", ["4"]],
  ["IBGE: 2 setores crescem", "Segundo o IBGE, os setores cresceram.", "pt", ["2"]],
  ["IPCA cede 0,11% em agosto", IPCA_NEWS, "pt", []],
  ["Fed: dois diretores votam contra", "Two members voted against the action.", "en", []],
  ["Fed: três diretores votam contra", "Two members voted against the action.", "en", ["três"]],
  ["PIB dos EUA cresce 3,1% no 2º trimestre", "Real GDP increased 3.1 percent in the second quarter.", "en", []],
  ["PIB dos EUA cresce 3,1% no 3º trimestre", "Real GDP increased 3.1 percent in the second quarter.", "en", ["3"]],
  ["EUA criam 150 mil vagas", "Total nonfarm payroll employment rose by 150,000.", "en", []],
  ["EUA criam 150 mil vagas", "Total nonfarm payroll employment rose by 150 thousand.", "en", []],
  ["EUA criam 15 mil vagas", "Total nonfarm payroll employment rose by 150,000.", "en", ["15"]],
  ["Empresa capta US$ 12,4 milhões", "The company raised US$ 12,400,000.", "en", []],
  // Other central banks in Fed style
  ["BoE mantém juros em 4,25%", "Bank Rate maintained at 4 1/4 percent.", "en", []],
  ["BoE mantém juros em 4,50%", "Bank Rate maintained at 4½%.", "en", []],
  ["BoE mantém juros em 4,50%", "Bank Rate maintained at 4 1/4 percent.", "en", ["4,50"]],
  // ECB
  ["BCE corta juros em 0,25 p.p.; taxa de depósito vai a 2,00%", ECB_CUT, "en", []],
  ["BCE corta as três taxas em 25 pb", ECB_CUT, "en", []],
  ["BCE corta juros em 0,50 p.p.", ECB_CUT, "en", ["0,50"]],
  ["BCE corta juros em 0,25 p.p.", ECB_HOLD, "en", ["0,25"]], // "second quarter" is not 0,25
  ["BCE corta juros em 0,22 p.p.", ECB_HOLD, "en", ["0,22"]], // 2.2% is not 0,22 p.p.
  ["BCE corta juros em 2,00 p.p.", ECB_CUT, "en", ["2,00"]], // the level is not the size of the cut
  ["BCE: inflação fica em 2,2%", ECB_HOLD, "en", []],
  ["BCE: nova taxa vale a partir de 11 de junho", ECB_CUT, "en", []],
  // Copom
  ["Copom reduz Selic em 0,50 p.p., para 13,25% ao ano", COPOM_OLD, "pt", []],
  ["Copom reduz Selic em 50 pb, para 13,25% ao ano", COPOM_OLD, "pt", []],
  ["Copom reduz Selic em meio ponto, para 13,25% ao ano", COPOM_OLD, "pt", []],
  ["Copom reduz Selic em meio ponto, para 13,25% ao ano", "reduzir a Selic em 0,25 ponto percentual, para 13,25% a.a.", "pt", ["meio ponto"]],
  ["Copom eleva Selic em 1 ponto percentual", "elevar a Selic em um ponto percentual", "pt", []],
  ["Copom reduz Selic em 0,50%", COPOM_OLD, "pt", ["0,50"]],
  ["Copom reduz Selic para 13,50% ao ano", COPOM_OLD, "pt", ["13,50"]],
  ["Copom reduz Selic para 13.25% ao ano", COPOM_OLD, "pt", ["13.25"]], // headline must use the pt-BR format
  // IBGE
  ["IPCA sobe 0,48% em setembro", IPCA_NEWS, "pt", []],
  ["IPCA sobe 0,10% em setembro", IPCA_NEWS, "pt", ["0,10"]], // "10/10/2026" is a date, not a figure
  ["IPCA sobe 0,48% em setembro, após queda de 0,11% em agosto", IPCA_NEWS, "pt", []],
  ["IPCA sobe 0,48% em setembro, após -0,11% em agosto", IPCA_NEWS, "pt", []],
  ["IPCA sobe 0,48% em setembro, após alta de 0,11% em agosto", IPCA_NEWS, "pt", ["0,11"]], // sign lost
  ["IPCA acumula 5,17% em 12 meses", IPCA_NEWS, "pt", []],
  ["IPCA acumula 5,2% em 12 meses", IPCA_NEWS, "pt", ["5,2"]], // rounded is not "as in the source"
  ["Desemprego fica em 5,6% no trimestre até agosto", PNAD_NEWS, "pt", []],
  ["População ocupada chega a 102,4 milhões", PNAD_NEWS, "pt", []],
  ["População ocupada chega a 102,4 mil", PNAD_NEWS, "pt", ["102,4"]],
  ["Tesouro capta R$ 12,4 bilhões", TESOURO, "pt", []],
  ["Tesouro capta R$ 12,4 bi", TESOURO, "pt", []],
  ["Tesouro capta R$ 12,4 milhões", TESOURO, "pt", ["12,4"]],
  ["IPCA sobe 0,25% em março", "Divulgação prevista para 1/4.", "pt", ["0,25"]], // "1/4" with no unit is a date
  ["Ata do Copom sai em 23/9", "A ata será publicada em 23 de setembro.", "pt", []],
  ["Ata do Copom sai em 24/9", "A ata será publicada em 23 de setembro.", "pt", ["24/9"]],
];

for (const [headline, source, lang, expected] of CASES) {
  test(`guard: "${headline}" ${expected.length ? `flags ${expected.join(", ")}` : "passes"}`, () => {
    assert.deepEqual(unsupportedNumbers(headline, source, lang), expected);
  });
}

test("guard table has at least 30 cases, both passing and flagged", () => {
  assert.ok(CASES.length >= 30);
  assert.ok(CASES.some((c) => c[3].length) && CASES.some((c) => !c[3].length));
});

test("guard on the real Copom statements: the new level passes, a cut size they never state does not", () => {
  const statements = copomStatements();
  assert.equal(statements.length, 10);
  for (const src of statements) {
    const level = /(?:para|em)\s+(\d+,\d+)% a\.a\./.exec(src)?.[1];
    assert.ok(level, src.slice(0, 80));
    assert.deepEqual(unsupportedNumbers(`Copom reduz Selic para ${level}% ao ano`, src), []);
    // "por meio de", "Tabela 1", "3,2", "4,9" and the like must not back an invented cut or figure.
    for (const made of ["0,25 p.p.", "0,50 p.p.", "0,75 p.p.", "1 p.p.", "1,00 p.p.", "50 pb", "25 pb", "meio ponto"]) {
      assert.equal(unsupportedNumbers(`Copom reduz Selic em ${made}, para ${level}% ao ano`, src).length, 1, `${made} in ${src.slice(0, 60)}`);
    }
    assert.deepEqual(unsupportedNumbers("Copom vê inflação de 32% em 2026", src), ["32"]);
    assert.deepEqual(unsupportedNumbers("Copom vê inflação de 1% em 2026", src), ["1"]);
  }
});

test("guard on the real 281st Copom statement accepts the figures it does state", () => {
  const src = copomStatements()[0];
  assert.deepEqual(unsupportedNumbers("Copom: Focus vê inflação de 4,9% em 2026 e 4,3% em 2027", src), []);
  assert.deepEqual(unsupportedNumbers("Copom projeta IPCA de 3,2% no 1º trimestre de 2028", src), []);
  assert.deepEqual(unsupportedNumbers("281ª reunião do Copom reduz Selic para 13,75% ao ano", src), []);
});

test("the source language decides how its numbers read", () => {
  // "4,3" in an English text reads 43; in a Portuguese one, 4,3.
  assert.deepEqual(unsupportedNumbers("Desemprego vai a 4,3%", "unemployment at 4,3%", "en"), ["4,3"]);
  assert.deepEqual(unsupportedNumbers("Desemprego vai a 4,3%", "desemprego em 4,3%", "pt"), []);
  assert.deepEqual(unsupportedNumbers("Desemprego vai a 4,3%", "unemployment at 4.3%", "pt"), ["4,3"]);
});

test("a text with no numbers always passes", () => {
  assert.deepEqual(unsupportedNumbers("Juro menor barateia o crédito.", ""), []);
});
