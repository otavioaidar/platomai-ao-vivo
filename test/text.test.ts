import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities, extractArticle, fmtPct, htmlToText, monthName, numbersIn, parseNumber, truncate } from "../src/text.ts";

test("formats Brazilian percentages", () => {
  assert.equal(fmtPct(0.82), "0,82%");
  assert.equal(fmtPct(-0.4), "-0,40%");
  assert.equal(fmtPct(-0.001), "0,00%");
  assert.equal(monthName("202609"), "setembro");
});

test("reads numbers only the way the text's language writes them", () => {
  assert.deepEqual(numbersIn("Selic em 13,75% a.a."), [13.75]);
  assert.deepEqual(numbersIn("rate of 4.25 percent", "en"), [4.25]);
  assert.deepEqual(numbersIn("R$ 1.234,56"), [1234.56]);
  assert.deepEqual(numbersIn("US$ 1,234.56", "en"), [1234.56]);
  // No second reading: a pt "4,9" is never 49, an en "4.3" is never 43.
  assert.equal(parseNumber("4,9", "pt"), 4.9);
  assert.equal(parseNumber("4.3", "en"), 4.3);
  assert.equal(parseNumber("12,400,000", "en"), 12_400_000);
});

test("decodes entities and never throws on an invalid code point", () => {
  assert.equal(decodeEntities("Selic &amp; IPCA &#233; &#x00E9; &frac12; &minus;0,3"), "Selic & IPCA é é ½ −0,3");
  assert.equal(decodeEntities("Taxa &#99999999; 13,75%"), "Taxa &#99999999; 13,75%");
  assert.equal(decodeEntities("x &#x110000; y"), "x &#x110000; y");
  assert.equal(decodeEntities("&#xFFFFFFFFFFFFFFFFFFFF;"), "&#xFFFFFFFFFFFFFFFFFFFF;");
  assert.equal(htmlToText("<p>Taxa &#99999999; 13,75%</p>"), "Taxa &#99999999; 13,75%");
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
