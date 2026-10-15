import assert from "node:assert/strict";
import { test } from "node:test";
import { extractArticle, fmtPct, htmlToText, monthName, numbersIn, truncate } from "../src/text.ts";
import { sourceNumbers, unsupportedNumbers } from "../src/writer/guard.ts";

test("formats Brazilian percentages", () => {
  assert.equal(fmtPct(0.82), "0,82%");
  assert.equal(fmtPct(-0.4), "-0,40%");
  assert.equal(fmtPct(-0.001), "0,00%");
  assert.equal(monthName("202609"), "setembro");
});

test("reads numbers in both pt-BR and en notation", () => {
  assert.ok(numbersIn("Selic em 13,75% a.a.").includes(13.75));
  assert.ok(numbersIn("rate of 4.25 percent").includes(4.25));
  assert.ok(numbersIn("R$ 1.234,56").includes(1234.56));
});

test("turns HTML into text, dropping scripts and comments", () => {
  const t = htmlToText("<div><p>Primeiro&#160;parágrafo.</p><!-- x --><script>alert(1)</script><p>Segundo &amp; fim</p></div>");
  assert.equal(t, "Primeiro parágrafo.\nSegundo & fim");
});

test("extracts the article body from a page", () => {
  const html = `<html><nav>menu</nav><div id="article"><h3>Title</h3><p>Body text.</p></div><footer>rodapé</footer></html>`;
  assert.equal(extractArticle(html), "Title\nBody text.");
});

test("truncates on a word boundary", () => {
  assert.equal(truncate("abc def ghi", 8), "abc def…");
  assert.equal(truncate("curto", 10), "curto");
});

test("guard accepts Fed fractions and basis-point conversions", () => {
  const src = "The Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.";
  assert.ok(sourceNumbers(src).has(3.75));
  assert.deepEqual(unsupportedNumbers("Fed corta juros em 0,25 p.p., para a faixa de 3,75% a 4,00%", src), []);
  assert.deepEqual(unsupportedNumbers("Fed corta juros em 25 pb", src), []);
});

test("guard flags numbers the source does not contain", () => {
  const src = "Copom reduz a taxa Selic para 13,75% a.a.";
  assert.deepEqual(unsupportedNumbers("Copom reduz Selic para 13,75% ao ano", src), []);
  assert.deepEqual(unsupportedNumbers("Copom reduz Selic para 13,50% ao ano", src), ["13,50"]);
});
